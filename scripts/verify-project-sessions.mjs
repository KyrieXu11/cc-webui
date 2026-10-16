// Optional UI regression against an isolated Vite preview. All APIs use synthetic data.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/verify-project-sessions.mjs [preview-url]
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = fileURLToPath(new URL('../.playwright-mcp/project-sessions/', import.meta.url));
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const base = process.argv[2] || 'http://127.0.0.1:8796/';
const cwd = '/preview/workspaces/rebecca', now = Date.now();
const id = i => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
const reports = [], pageErrors = [];
async function scenario(provider, theme, mobile) {
  const label = `${provider}-${theme}-${mobile ? 'mobile' : 'desktop'}`;
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: theme, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.on('pageerror', err => pageErrors.push(`${label}: ${err.message}`));
  let rows = Array.from({ length: 45 }, (_, i) => ({ sessionId: id(i), cwd, provider, summary: `对话 ${i}：高中英语课件与阅读练习`, lastModified: now - i * 1000, mine: true }));
  let activity = now;
  const nextActivity = () => activity += 10000;
  const requests = [], held = [];
  let fail = false, holdNext = false;
  await page.addInitScript(({ cwd, provider, theme, sessionId }) => {
    if (!localStorage.getItem('session-fixture-ready')) {
      localStorage.clear();
      localStorage.setItem('session-fixture-ready', '1');
      localStorage.setItem('cc-webui:settings', JSON.stringify({ cwd: '', agentProvider: provider, model: provider === 'codex' ? 'gpt-6-sol' : 'opus', permissionMode: 'auto', effort: 'high', theme, themeChosen: true }));
      localStorage.setItem('cc-webui:lastProject', JSON.stringify({ cwd, sessionId, agentProvider: provider }));
      localStorage.setItem('ccwebui.sessions_expanded', 'true'); // The obsolete global toggle must not reveal everything.
    }
    const realInterval = window.setInterval;
    window.setInterval = (fn, delay, ...args) => {
      if (delay === 10000) {
        window.__sessionPollTick = fn;
        return realInterval(() => { if (!window.__pauseSessionPoll) fn(...args); }, delay);
      }
      return realInterval(fn, delay, ...args);
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!window.__newNativeSession || !url?.endsWith('/chat') || options?.method !== 'POST') return realFetch(input, options);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({ start(controller) {
        const emit = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        window.__finishFixtureTurn = () => { emit('done', {}); controller.close(); };
        emit('message', provider === 'codex'
          ? { type: 'thread.started', thread_id: window.__newNativeSession }
          : { type: 'system', subtype: 'init', session_id: window.__newNativeSession });
      } });
      return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    };
    window.__fixtureVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__fixtureVisibility });
  }, { cwd, provider, theme, sessionId: id(10) });
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url()), p = u.pathname;
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/api/auth/me') return json({ user: { id: 'fixture-admin', username: 'preview', role: 'admin', createdAt: now }, allowedPaths: ['/preview/**'], allowedProviders: ['claude', 'codex'], defaults: null });
    if (p === '/api/meta') return json({ features: { groups: false, office: false }, slashCommands: [], skills: [] });
    if (p === '/api/meta/models') return json({ codex: { source: 'cli', models: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol', supportedEfforts: ['high'] }] } });
    if (p === '/api/fs/home') return json({ home: '/preview' });
    if (p === '/api/sessions') {
      requests.push({ limit: Number(u.searchParams.get('limit')), compact: u.searchParams.get('compact'), cwd: u.searchParams.get('cwd') });
      const data = { sessions: [...rows].sort((a, b) => b.lastModified - a.lastModified).slice(0, Number(u.searchParams.get('limit'))) };
      if (holdNext) { holdNext = false; held.push({ route, data }); return; }
      if (fail) return route.fulfill({ status: 503, body: '{}' });
      return json(data);
    }
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages: [] });
    if (/^\/api\/sessions\/[^/]+$/.test(p) && route.request().method() === 'DELETE') {
      rows = rows.filter(s => !p.endsWith(s.sessionId));
      return json({ ok: true });
    }
    if (p.endsWith('/inflight')) return json({ sessionIds: [] });
    if (p.endsWith('/attach')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: no-inflight\ndata: {}\n\n' });
    if (p === '/api/bash/tasks/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: snapshot\ndata: {"tasks":[],"running":0,"total":0}\n\n' });
    if (p === '/api/files') return json({ files: [] });
    if (p === '/api/fs/tree') return json({ entries: [] });
    return json({});
  });
  const ready = async () => {
    await page.locator('.app-workbench').waitFor();
    if (mobile) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
    await page.locator('.session-sidebar .conversation-row').first().waitFor();
    await page.waitForTimeout(400);
  };
  const count = () => page.locator('.session-sidebar .conversation-row').count();
  const more = () => page.getByRole('button', { name: /^展开显示 \d+ 个对话$/ });
  const collapse = () => page.getByRole('button', { name: '收起更早对话', exact: true });
  const scroller = () => page.locator('.session-sidebar [id]').filter({ has: page.locator('.conversation-selection-rail') });
  const focusRefresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.goto(base); await ready();
  assert.equal(await count(), 5, `${label}: strictly five recent conversations, despite an old selected session and obsolete expanded preference`);
  assert.equal(requests.filter(r => r.cwd === cwd).length, 1, `${label}: collapsed list does not paginate invisibly`);
  assert.equal(await page.locator(`.conversation-row[data-liquid-key="${provider}:${id(10)}"]`).count(), 0);
  assert.equal(await page.locator('.conversation-selection-rail > .liquid-selection').count(), 0, `${label}: hidden old selection leaves no stale glass highlight`);
  const morePosition = await more().boundingBox(), lastPosition = await page.locator('.conversation-row').last().boundingBox();
  assert(morePosition.y >= lastPosition.y + lastPosition.height, `${label}: button follows the fifth row in the scroll flow, not a fixed footer or top header`);
  assert.equal(await more().getAttribute('aria-label'), '展开显示 5 个对话');
  assert.equal(await page.locator('button button').count(), 0);
  await page.screenshot({ path: `${output}/${label}-collapsed.png` });
  const railHandle = await page.locator('.conversation-selection-rail').elementHandle();
  const beforeSelect = requests.length;
  await page.locator('.session-sidebar .conversation-row').first().locator('button').first().click();
  if (mobile) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(requests.length, beforeSelect, `${label}: selecting a known conversation does not reload its list`);
  await more().click();
  assert.equal(await count(), 10, `${label}: one click reveals exactly five`);
  assert.equal(requests.length, beforeSelect, `${label}: first click only reveals already-fetched rows`);
  await more().click();
  await page.waitForFunction(() => document.querySelectorAll('.session-sidebar .conversation-row').length === 15 && !document.querySelector('.conversation-disclosure[disabled]'));
  assert(requests.some(r => r.limit === 30), `${label}: explicit second click reads ahead, without revealing the whole next page`);
  await page.screenshot({ path: `${output}/${label}-expanded-15.png` });
  await more().click();
  assert.equal(await count(), 20, `${label}: third click reveals only another five`);
  await page.waitForTimeout(400);
  const beforeScroll = requests.length;
  await scroller().evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(100);
  assert.equal(await count(), 20, `${label}: scrolling does not reveal another batch`);
  assert.equal(requests.length, beforeScroll, `${label}: scrolling does not fetch another page`);
  await scroller().evaluate(el => { el.scrollTop = 120; });
  const oldScroll = await scroller().evaluate(el => el.scrollTop);
  await focusRefresh();
  await page.waitForTimeout(100);
  assert.equal(await scroller().evaluate(el => el.scrollTop), oldScroll, `${label}: background update preserves scroll`);
  assert(await railHandle.evaluate(el => el.isConnected), `${label}: background update preserves the rail node`);
  assert(requests.every(r => r.compact === '1'), `${label}: sidebar uses compact reads only`);
  const reactivated = rows[30];
  rows = rows.map(s => s.sessionId === reactivated.sessionId ? { ...s, lastModified: nextActivity() } : s);
  await focusRefresh();
  await page.waitForFunction(sessionId => document.querySelector('.conversation-row')?.dataset.liquidKey.endsWith(sessionId), reactivated.sessionId);
  assert.equal(await count(), 20, `${label}: recent activity in an old session moves it to the top without expanding the window`);
  await collapse().click();
  assert.equal(await count(), 5);
  assert.equal(await scroller().evaluate(el => el.scrollTop), 0);
  await page.reload(); await ready();
  assert.equal(await count(), 5, `${label}: reload starts with five`);
  await more().click();
  await page.reload(); await ready();
  assert.equal(await count(), 5, `${label}: obsolete global expanded preference is ignored`);

  if (provider === 'codex' && !mobile) {
    const fullRows = rows;
    rows = rows.slice(0, 13);
    await focusRefresh(); await page.waitForTimeout(100);
    await more().click();
    assert.equal(await count(), 10);
    assert.equal(await more().getAttribute('aria-label'), '展开显示 3 个对话');
    await more().click();
    assert.equal(await count(), 13, `${label}: final partial batch is exact`);
    assert.equal(await more().count(), 0);
    await collapse().click(); rows = fullRows;
    await focusRefresh(); await page.waitForTimeout(100);
  }

  // Synthetic visibility/focus events exercise the exact browser event handlers.
  const hiddenCount = requests.length;
  await page.evaluate(() => { window.__fixtureVisibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); window.__sessionPollTick(); });
  await page.waitForTimeout(100);
  assert.equal(requests.length, hiddenCount, `${label}: hidden tabs skip scheduled scans`);
  const external = { ...rows[0], sessionId: id(99), summary: '来自另一个标签页的新对话', lastModified: nextActivity() };
  rows.unshift(external);
  await page.evaluate(() => { window.__fixtureVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByText(external.summary, { exact: true }).waitFor();

  fail = true;
  await focusRefresh();
  await page.getByText('对话列表加载失败。', { exact: false }).waitFor();
  assert.equal(await count(), 5, `${label}: failed background update retains rows`);
  fail = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.session-sidebar [role=status]'));

  // Coalescing and delete-while-reading: the stale response cannot revive a row.
  holdNext = true;
  await focusRefresh();
  await page.waitForFunction(() => true);
  for (let i = 0; held.length === 0 && i < 50; i++) await page.waitForTimeout(10);
  assert.equal(held.length, 1);
  const heldCount = requests.length;
  await focusRefresh(); await focusRefresh();
  await page.waitForTimeout(50);
  assert.equal(requests.length, heldCount, `${label}: concurrent focus refreshes coalesce`);
  const externalRow = page.locator(`.conversation-row[data-liquid-key="${provider}:${external.sessionId}"]`);
  await externalRow.hover();
  await externalRow.getByRole('button', { name: '删除', exact: true }).click();
  await externalRow.waitFor({ state: 'detached' });
  await held[0].route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(held[0].data) }).catch(() => {});
  await page.waitForTimeout(100);
  assert.equal(await externalRow.count(), 0, `${label}: stale response did not revive a deleted conversation`);

  // Use one real 10-second timer, not an explicit refresh, to discover a new row.
  if (provider === 'codex' && !mobile) {
    const polled = { ...rows[0], sessionId: id(98), summary: '定时同步发现的新对话', lastModified: nextActivity() };
    rows.unshift(polled);
    await page.getByText(polled.summary, { exact: true }).waitFor({ timeout: 12_000 });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
  if (mobile) assert((await more().boundingBox()).height >= 44, `${label}: touch target at least 44px`);
  await page.screenshot({ path: `${output}/${label}-updated.png` });
  if (!mobile) {
    await page.getByRole('button', { name: `新建 ${provider === 'codex' ? 'Codex' : 'Claude'} 会话`, exact: true }).click();
    await page.evaluate(sessionId => { window.__pauseSessionPoll = true; window.__newNativeSession = sessionId; }, id(97));
    const ownSession = { ...rows[0], sessionId: id(97), summary: '本页新会话在回复完成前出现', lastModified: nextActivity() };
    rows.unshift(ownSession);
    await page.locator('textarea').fill('合成会话：测试收到 native id 后立即补拉');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText(ownSession.summary, { exact: true }).waitFor({ timeout: 2000 });
    assert(await page.getByRole('button', { name: '停止生成', exact: true }).isVisible(), `${label}: own native id refreshes before the turn ends`);
    await page.evaluate(() => window.__finishFixtureTurn());
  }
  reports.push({ label, requests: requests.length, checks: ['strict-recent-five', 'inline-five-per-click', 'no-scroll-pagination', 'read-ahead-without-auto-reveal', 'recent-activity-first', 'obsolete-preference-ignored', 'scroll-and-dom-stable', 'focus-and-visibility-sync', 'hidden-skip', 'error-retry', 'request-coalescing', 'delete-race', ...(!mobile ? ['own-native-id-before-done'] : []), ...(provider === 'codex' && !mobile ? ['real-timer-sync', 'partial-final-batch'] : [])] });
  await context.close();
}
try {
  // Sequential contexts avoid synthetic page-visibility interactions between tabs.
  for (const args of [['codex', 'light', false], ['claude', 'dark', false], ['codex', 'dark', true], ['claude', 'light', true]]) await scenario(...args);
  assert.deepEqual(pageErrors, []);
  writeFileSync(`${output}/report.json`, JSON.stringify({ reports, pageErrors }, null, 2));
  console.log(JSON.stringify({ reports, pageErrors, output }, null, 2));
} finally { await browser.close(); }
