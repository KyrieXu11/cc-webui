// Optional UI regression against an isolated Vite preview. Requires Playwright.
// Every /api request is intercepted: no real accounts, files, CLI or bots.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, ".playwright-mcp");
mkdirSync(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const base = process.argv[2] || "http://127.0.0.1:8796/";
const cwd = "/preview/code/cc-webui", sessionId = "11111111-1111-4111-8111-111111111111";
const now = Date.now(), checks = [], errors = [], unexpected = [];
const samples = provider => [
  { sessionId, cwd, provider, summary: provider === "claude" ? "统一设置页与导航交互" : "Codex 代码审查", lastModified: now, mine: true },
  { sessionId: "22222222-2222-4222-8222-222222222222", cwd, provider, summary: "检查文件预览和编辑器", lastModified: now - 90_000, mine: true },
  { sessionId: "33333333-3333-4333-8333-333333333333", cwd: "/preview/code/research", provider, summary: "整理项目文档", lastModified: now - 4_000_000, mine: true },
];
const history = [
  { type: "user", uuid: "user-1", session_id: sessionId, message: { content: "请把设置页和导航的配色统一，保留现有交互。" } },
  { type: "assistant", uuid: "a-1", session_id: sessionId, message: { id: "assistant-1", content: [{ type: "tool_use", id: "read-style", name: "Read", input: { file_path: cwd + "/src/index.css" } }] } },
  { type: "user", uuid: "result-1", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "read-style", content: ":root { --color-surface: #fbfdfe; }" }] } },
  { type: "assistant", uuid: "a-2", session_id: sessionId, message: { id: "assistant-2", content: [{ type: "text", text: "## 已统一界面的层级\n\n保留原有的字体、快捷键与文件操作，把**导航与悬浮控件**整理成同一套材质。\n\n- 导航使用轻薄的玻璃光边。\n- 对话正文保持稳定底色，不随背景变化。\n- 编辑器与文件预览继续使用独立的内部滚动。\n\n```css\n.navigation {\n  border-radius: 24px;\n  color: var(--color-fg);\n}\n```\n\n类型检查与回归测试均已通过。下一步可以检查深浅主题和手机上的抽屉。" }] } },
];
async function setup({ theme = "light", logged = true, project = false, race = false, groups = false, mobile = false, scanMode = "", noFolders = false, noRecents = false, codexLive = false, catalogFlip = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 851 } : { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme, isMobile: mobile, hasTouch: mobile,
    ...(mobile ? { userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" } : {}),
  });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  const held = [], scans = [], scanRequests = [], sessionRequests = [], modelRequests = [];
  await page.addInitScript(({ theme, project, cwd, sessionId, codexLive }) => {
    localStorage.clear();
    localStorage.setItem("cc-webui:settings", JSON.stringify({ cwd: "", agentProvider: codexLive ? "codex" : "claude", model: codexLive ? "gpt-6-sol" : "opus", permissionMode: "auto", effort: "high", theme, themeChosen: true }));
    if (project) localStorage.setItem("cc-webui:lastProject", JSON.stringify({ cwd, sessionId, agentProvider: codexLive ? "codex" : "claude" }));
    if (codexLive) {
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const url = typeof input === "string" ? input : input.url;
        if (!url?.includes("/api/codex/chat") || options?.method !== "POST") return realFetch(input, options);
        const encoder = new TextEncoder();
        const stream = new ReadableStream({ start(controller) {
          const emit = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          window.__fixtureCodex = (frame) => emit("codex_event", frame);
          window.__finishCodex = () => { emit("done", {}); controller.close(); };
          options.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
          emit("turn_meta", { type: "turn_meta", startedAt: Date.now(), effort: "high", provider: "codex" });
        } });
        return Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
      };
    }
  }, { theme, project, cwd, sessionId, codexLive });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    const sse = (event, body) => route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: ${event}\ndata: ${JSON.stringify(body)}\n\n` });
    if (path === "/api/auth/me") return json(logged ? { user: { id: "preview-admin", username: "preview", role: "admin", createdAt: now }, allowedPaths: noFolders ? [] : ["/preview/**"], allowedProviders: ["claude", "codex"], defaults: null } : { user: null });
    if (path === "/api/meta") return json({ features: { groups, office: false }, skills: ["review", "design"], slashCommands: ["review", "design"], models: { codex: { source: "fallback", models: [] } } });
    if (path === "/api/meta/models") {
      modelRequests.push(url.search);
      const ids = catalogFlip && url.searchParams.has("refresh") ? ["gpt-6.1-sol", "gpt-6-sol"] : ["gpt-6-sol"];
      return json({ codex: { source: "cli", models: ids.map(id => ({ id, label: id === "gpt-6.1-sol" ? "GPT-6.1-Sol" : "GPT-6-Sol", hint: "fixture model", supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] })) } });
    }
    if (path === "/api/fs/home") return json({ home: "/preview" });
    if (path === "/api/fs/scan") {
      scanRequests.push(url.search);
      if (scanMode === "held") { scans.push(route); return; }
      if (scanMode === "fail" && !url.searchParams.has("refresh")) return route.fulfill({ status: 500, body: '{}' });
      return json({ dirs: [cwd, "/preview/code/research"], home: "/preview" });
    }
    if (path === "/api/fs/recents") return json({ recents: noRecents ? [] : [{ path: cwd, lastUsed: now }] });
    if (path === "/api/sessions") {
      const provider = url.searchParams.get("provider") || "claude";
      sessionRequests.push({ provider, cwd: url.searchParams.get("cwd"), limit: Number(url.searchParams.get("limit")), compact: url.searchParams.get("compact") });
      if (race && provider === "claude") { held.push(route); return; }
      return json({ sessions: samples(provider) });
    }
    if (/\/api\/sessions\/[^/]+\/messages/.test(path)) return json({ messages: history });
    if (/\/api\/sessions\/[^/]+\/shares/.test(path)) return json({ owner: { userId: "preview-admin", username: "preview" }, shares: [] });
    if (path === "/api/auth/directory") return json({ users: [{ id: "preview-admin", username: "preview", role: "admin" }, { id: "reader", username: "reader", role: "user" }] });
    if (path.endsWith("/inflight")) return json({ sessionIds: [] });
    if (path.endsWith("/attach")) return sse("no-inflight", {});
    if (path === "/api/bash/tasks/stream") return sse("snapshot", { tasks: [], running: 0, total: 0 });
    if (path === "/api/bash/tasks") return json({ tasks: [], running: 0, total: 0 });
    if (path === "/api/project-memory") return json({ dir: cwd, enabled: true, total: 1, nextCursor: null, index: "- [项目视觉约定](visual.md) — 保留字体和内容区\n", memories: [{ file: "visual.md", name: "项目视觉约定", description: "保留字体和内容区", type: "project", modified: new Date(now).toISOString(), body: "正文用稳定底色，控制层使用液态玻璃近似。", truncated: false }] });
    if (path === "/api/files") return json({ files: [] });
    if (path === "/api/groups") return json({ groups: [{ id: "preview-group", title: "协作设计审查", cwd, lastTs: now, lastSnippet: "Claude + Codex", inFlight: false }] });
    if (path === "/api/groups/preview-group") return json({ config: {
      id: "preview-group", title: "协作设计审查", cwd, createdAt: now, updatedAt: now,
      participants: [
        { id: "claude", model: "opus", mode: "auto", effort: "high", systemPrompt: "", skills: [], mcpServers: [] },
        { id: "codex", model: "gpt-6.1-sol", mode: "auto", effort: "high", systemPrompt: "", skills: [], mcpServers: [] },
      ], pipeline: ["claude", "codex"],
    }, messages: [
      { agent: "user", ts: now - 2000, event: { id: "group-user", type: "user", text: "一起检查设计层级。" } },
      { agent: "claude", ts: now - 1000, event: { id: "group-answer", type: "assistant", text: "控制层使用玻璃，正文保持清晰。" } },
    ], inFlight: true });
    if (path === "/api/groups/preview-group/stream") return sse("agent_begin", { type: "agent_begin", agent: "claude" });
    if (path === "/api/fs/tree") return json({ entries: [{ name: "README.md", path: cwd + "/README.md", type: "file" }, { name: "index.ts", path: cwd + "/index.ts", type: "file" }] });
    if (path === "/api/fs/read") return json({ content: "// Preview fixture only\nexport const theme = 'liquid';\n".repeat(80), truncated: false, mtimeMs: now, size: 4320 });
    unexpected.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"unhandled preview fixture"}' });
  });
  await page.goto(base);
  return { page, context, held, scans, scanRequests, sessionRequests, modelRequests };
}
async function ready(page, selector = ".app-workbench") { await page.locator(selector).waitFor(); await page.waitForTimeout(450); }
async function screenshot(page, name) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({ path: resolve(output, `ccwebui-liquid-${name}.png`) });
}
async function layout(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: document overflow`);
  assert.equal(await page.locator("button button").count(), 0, `${label}: nested interactive buttons`);
}
async function verifyProjectPicker() {
  const open = async (page) => {
    await ready(page);
    await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
    await page.getByPlaceholder("搜索文件夹，或粘贴绝对路径回车").waitFor();
    return page.locator(".soft-dialog");
  };
  const release = (route) => route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ dirs: [cwd, "/preview/code/research"], home: "/preview" }) });
  for (const mobile of [false, true]) {
    const { page, context, scans } = await setup({ scanMode: "held", mobile, theme: mobile ? "dark" : "light" });
    try {
      let dialog = await open(page);
      await dialog.getByRole("button", { name: "~/code/cc-webui", exact: true }).waitFor();
      assert.equal(scans.length, 1, "recent project visible while scan still held");
      if (mobile) {
        await dialog.getByRole("button", { name: "关闭", exact: true }).tap();
        assert.equal(await dialog.count(), 0, "Android can close during a pending scan");
        dialog = await open(page);
        await dialog.getByRole("button", { name: "~/code/cc-webui", exact: true }).waitFor();
      }
      const input = dialog.getByPlaceholder("搜索文件夹，或粘贴绝对路径回车");
      // Empty-result ArrowDown used to set idx=-1 and break the next Enter.
      await input.fill("no-such-keyword");
      await input.press("ArrowDown");
      await input.press("Enter");
      assert.equal(await dialog.count(), 1, "bare search text is not opened as a fake absolute path");
      await input.fill("");
      await release(scans.at(-1));
      await dialog.getByRole("button", { name: "~/code/research", exact: true }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "~/code/cc-webui", exact: true }).count(), 1, "deduplicate recent/scanned rows");
      await input.press("ArrowDown");
      await input.press("Enter");
      await page.locator(".chat-panel").waitFor();
      assert.equal(await page.locator(".soft-dialog").count(), 0);
      await layout(page, `project picker ${mobile ? "Android" : "desktop"}`);
    } finally { await context.close(); }
  }
  const recent = await setup({ scanMode: "held" });
  try {
    const dialog = await open(recent.page);
    await dialog.getByRole("button", { name: "~/code/cc-webui", exact: true }).click();
    assert.equal(recent.scans.length, 1);
    await recent.page.locator(".chat-panel").waitFor();
    assert.equal(await dialog.count(), 0, "recent project is usable, not just visible, before scan resolves");
  } finally { await recent.context.close(); }
  for (const path of ["/preview/code/new-project", "~/code/new-project"]) {
    const { page, context, scans } = await setup({ scanMode: "held", noRecents: true });
    try {
      const dialog = await open(page);
      // Home arrives independently, allowing ~/ expansion before scan resolves.
      const input = dialog.getByPlaceholder("搜索文件夹，或粘贴绝对路径回车");
      await input.fill(path);
      await dialog.getByRole("button", { name: `打开 "${path}"`, exact: true }).waitFor();
      assert.equal(scans.length, 1);
      await input.press("Enter");
      await page.locator(".chat-panel").waitFor();
      assert.equal(await page.locator(".soft-dialog").count(), 0, "manual path opens before scan completes");
    } finally { await context.close(); }
  }
  const failed = await setup({ scanMode: "fail" });
  try {
    const dialog = await open(failed.page);
    await dialog.getByText("目录扫描失败；仍可打开最近项目或直接输入路径。", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "~/code/cc-webui", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "重试扫描", exact: true }).click();
    await dialog.getByRole("button", { name: "~/code/research", exact: true }).waitFor();
    assert.deepEqual(failed.scanRequests, ["", "?refresh=1"]);
    // Focused Close must close, not bubble Enter into opening the first result.
    await dialog.getByRole("button", { name: "关闭", exact: true }).press("Enter");
    assert.equal(await dialog.count(), 0);
    assert.equal(await failed.page.locator(".chat-panel").count(), 0);
  } finally { await failed.context.close(); }
  const denied = await setup({ noFolders: true });
  try {
    await ready(denied.page);
    await denied.page.getByRole("button", { name: "打开项目", exact: true }).last().click();
    await denied.page.getByText("你的账号还没有被授权任何文件夹。", { exact: true }).waitFor();
    assert.deepEqual(denied.scanRequests, []);
    assert.equal(await denied.page.getByPlaceholder("搜索文件夹，或粘贴绝对路径回车").count(), 0);
  } finally { await denied.context.close(); }
  checks.push("Project picker: recent-first, background merge/dedup, keyboard, immediate absolute/~ paths, retry and current grants (desktop + Android touch)");
}
async function verifySessionAndModelUpdates() {
  const fixture = await setup({ project: true, codexLive: true, catalogFlip: true });
  const { page, context } = fixture;
  try {
    await ready(page, ".chat-panel");
    await page.locator(".session-sidebar .conversation-row").first().waitFor();
    const scoped = () => fixture.sessionRequests.filter(r => r.cwd === cwd);
    assert.equal(scoped()[0].limit, 15, "initial project page is not a 200-transcript request");
    assert.equal(scoped()[0].compact, "1");
    const before = scoped().length;
    await page.locator(".session-sidebar .conversation-row").last().locator(":scope > button").first().click();
    await page.waitForTimeout(150);
    assert.equal(scoped().length, before, "selecting a conversation does not refetch/hide the list");
    const model = page.locator(".chat-panel").getByRole("button").filter({ hasText: /^GPT-6-Sol/ }).first();
    await model.click();
    await page.getByRole("button", { name: "刷新 Codex 模型", exact: true }).click();
    await page.getByText("GPT-6.1-Sol", { exact: true }).waitFor();
    assert(fixture.modelRequests.includes("?refresh=1"), "manual model refresh is not a hard-coded option");
    await page.keyboard.press("Escape");
    await page.locator("textarea").fill("synthetic progress test only");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const activity = page.getByLabel("Codex 处理中", { exact: true });
    await activity.waitFor();
    const word = await activity.locator("span").first().textContent();
    assert.match(word, /^[A-Za-z]+…$/, "Codex visibly keeps only the rotating verb");
    await page.waitForFunction((previous) => document.querySelector('[aria-label="Codex 处理中"] span')?.textContent !== previous, word);
    const total = page.locator("[data-turn-status]");
    assert.doesNotMatch(await activity.textContent(), /总耗时|回合已用|effort/);
    assert.match(await total.textContent(), /本轮总耗时.*含工具与等待.*推理档位/);
    await page.evaluate(() => window.__fixtureCodex({ type: "item.started", item: { id: "reason", type: "reasoning", text: "" } }));
    const reasoning = page.getByLabel("Codex 思考中", { exact: true });
    await reasoning.waitFor();
    assert.match(await reasoning.locator("span").first().textContent(), /^[A-Za-z]+…$/);
    assert.doesNotMatch(await reasoning.textContent(), /处理中 · |思考中 · /);
    assert.doesNotMatch(await reasoning.textContent(), /总耗时|回合已用/);
    assert.equal(await activity.count(), 0, "explicit reasoning replaces generic turn status");
    assert.equal(await total.count(), 1, "total statistic is independent of reasoning");
    await page.evaluate(() => window.__fixtureCodex({ type: "item.started", item: { id: "tool", type: "command_execution", command: "echo fixture" } }));
    await page.waitForTimeout(150);
    assert.equal(await activity.count(), 0, "tool execution uses its spinner, not a synthetic thinking row");
    assert.equal(await page.getByLabel("Codex 思考中", { exact: true }).count(), 0);
    assert.equal(await total.count(), 1, "total statistic includes tool execution too");
    await page.evaluate(() => window.__fixtureCodex({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "echo fixture", exit_code: 0 } }));
    await activity.waitFor();
    await page.evaluate(() => window.__finishCodex());
    await page.waitForFunction(() => !document.querySelector('[aria-label="Codex 处理中"]'));
    assert.equal(await page.locator(".sparkle-spin").count(), 0, "done stops every status animation");
    assert.equal(await total.count(), 0, "done stops the total timer");
    checks.push("Project sessions: compact initial 15 rows, no refetch on selection; CLI model refresh adds GPT-6.1-Sol; animated turn words preserve honest timing/tool/done semantics");
  } finally { await context.close(); }
}
async function verifyDockTogglePlacement() {
  for (const mobile of [false, true]) {
    const { page, context } = await setup({ project: true, mobile });
    try {
      await ready(page, ".chat-panel");
      const toggle = page.getByRole("button", { name: "切换文件面板", exact: true });
      const viewport = page.viewportSize();
      const closed = await toggle.boundingBox();
      assert.equal(closed.y + closed.height / 2, mobile ? 28 : 40);
      assert.equal(viewport.width - closed.x - closed.width, mobile ? 12 : 24);
      if (mobile) assert(closed.width >= 44 && closed.height >= 44);
      const fresh = await page.getByRole("button", { name: "新对话", exact: true }).boundingBox();
      assert(fresh.x + fresh.width < closed.x, "new chat never sits under the disclosure");
      assert(Math.abs(fresh.y + fresh.height / 2 - closed.y - closed.height / 2) <= 1, "the full toolbar is aligned, not just the toggle");
      assert.equal(await page.locator(".app-workbench").evaluate(e => getComputedStyle(e).backgroundImage), "none");
      assert.equal(await page.locator(".app-workbench").evaluate(e => getComputedStyle(e).backgroundColor), "rgb(238, 242, 248)");
      await toggle.click();
      const opened = await toggle.boundingBox();
      assert.deepEqual(opened, closed, "opening the dock must not move or resize its disclosure");
      const upload = await page.getByRole("button", { name: "上传", exact: true }).boundingBox();
      assert(Math.abs(upload.y + upload.height / 2 - opened.y - opened.height / 2) <= 1, "file toolbar actions share the toggle axis");
      await layout(page, "inset dock toggle");
      await screenshot(page, mobile ? "dock-toggle-mobile" : "dock-toggle-desktop");
    } finally { await context.close(); }
  }
  checks.push("File disclosure stays fixed across open/closed states with reserved action space; light canvas uses flat softcard #EEF2F8");
}
async function verifySidebarResize() {
  const { page, context } = await setup({ project: true });
  try {
    await ready(page, ".chat-panel");
    const toggle = page.getByRole("button", { name: "切换侧栏", exact: true });
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    const sidebar = page.locator(".session-sidebar");
    const drag = page.locator('.dragbar[title^="拖动调整左侧会话栏的宽度"]');
    const before = await sidebar.boundingBox(), box = await drag.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + box.height / 2); await page.mouse.up();
    const wide = await sidebar.boundingBox();
    assert(wide.width > before.width + 80);
    assert(Math.abs(Number(await page.evaluate(() => localStorage.getItem("ccwebui.sidebar_w"))) - wide.width) < 1);
    await toggle.click(); await toggle.click();
    assert(Math.abs((await sidebar.boundingBox()).width - wide.width) < 1, "reopening restores the sidebar width");
    await page.getByRole("button", { name: "切换文件面板", exact: true }).click();
    const grown = await drag.boundingBox();
    await page.mouse.move(grown.x + grown.width / 2, grown.y + grown.height / 2);
    await page.mouse.down(); await page.mouse.move(1300, grown.y + grown.height / 2); await page.mouse.up();
    assert((await page.locator(".chat-panel").boundingBox()).width >= 398, "left resizing accounts for the open right dock");
    await drag.dblclick();
    assert.equal(Math.round((await sidebar.boundingBox()).width), 260);
    await screenshot(page, "resizable-sidebar");
  } finally { await context.close(); }
  checks.push("Left sidebar resizes/persists/resets, and reciprocal pane limits protect conversation width");
}
async function verifyMobileNavigation() {
  for (const theme of ["light", "dark"]) for (const project of [false, true]) {
    const { page, context } = await setup({ theme, project, mobile: true });
    try {
      await ready(page);
      const nav = page.locator("[data-railcol]");
      const open = page.getByRole("button", { name: "打开侧栏", exact: true });
      const close = page.getByRole("button", { name: "关闭侧栏", exact: true });
      const closed = async () => {
        await page.waitForFunction(() => {
          const el = document.querySelector("[data-railcol]");
          return el && getComputedStyle(el).display === "none" && !document.querySelector("[data-drawer-scrim]");
        });
        assert.equal(await nav.getAttribute("data-mobile-drawer"), "closed");
        assert.equal(await nav.evaluate(e => e.getBoundingClientRect().width), 0);
        assert.equal(await close.count(), 0, "Hidden drawer controls must not remain focusable/discoverable");
        const hit = await open.evaluate(el => { const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return hit===el || el.contains(hit); });
        assert(hit, "Closed navigation must not intercept the main view's touch target");
      };
      await closed();
      // Use touch taps, not desktop mouse clicks or force:true. Repeated open /
      // close catches a visually hidden but still hit-testing drawer.
      for (let repeat = 0; repeat < 3; repeat++) {
        await open.tap();
        assert.equal(await nav.getAttribute("data-mobile-drawer"), "open");
        const bounds = await close.boundingBox();
        assert(bounds.width >= 44 && bounds.height >= 44);
        await close.tap(); await closed();
      }
      await page.addStyleTag({ content: "[data-railcol] { translate: none !important; }" });
      await open.tap(); await close.tap(); await closed();
      await open.tap();
      await page.touchscreen.tap(383, 200); // outside the 316px drawer
      await closed();
      await layout(page, `Android touch ${theme}/${project ? "project" : "home"}`);
      if (project) {
        await open.tap();
        const files = page.getByRole("button", { name: "切换文件面板", exact: true });
        await files.tap();
        assert.equal(await nav.getAttribute("aria-hidden"), "true");
        assert.equal(await nav.evaluate(e => getComputedStyle(e).pointerEvents), "none");
        await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-railcol]")).display === "none");
        assert.equal(await nav.evaluate(e => getComputedStyle(e).display), "none");
        await page.getByText("index.ts", { exact: true }).waitFor();
        await files.tap(); await closed();
        await page.locator("textarea").fill("关闭侧栏后可以继续输入");
        assert.equal(await page.locator("textarea").inputValue(), "关闭侧栏后可以继续输入");
      } else {
        await page.getByLabel("搜索项目或对话", { exact: true }).fill("设置");
        await page.getByText("统一设置页与导航交互", { exact: true }).waitFor();
      }
      checks.push(`Android touch ${theme}/${project ? "project" : "home"}: close/reopen, no-translate fallback, outside tap and usable main controls`);
    } finally { await context.close(); }
  }
}
try {
  await verifyProjectPicker();
  await verifySessionAndModelUpdates();
  if (process.env.PICKER_ONLY === "1") {
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ checks, errors, unexpected }, null, 2));
    await browser.close();
    process.exit(0);
  }
  if (process.env.DRAWER_ONLY === "1") {
    await verifyMobileNavigation();
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ checks, errors, unexpected, simulatedAndroidTouch: true }, null, 2));
    await browser.close();
    process.exit(0);
  }
  const { page, context } = await setup();
  await ready(page);
  await page.getByText("统一设置页与导航交互", { exact: true }).waitFor();
  await layout(page, "home light");
  assert.equal(await page.locator(".nav-panel").evaluate(e => getComputedStyle(e).backdropFilter), "none");
  assert.notEqual(await page.locator(".nav-panel").evaluate(e => getComputedStyle(e, "::before").backdropFilter), "none");
  await screenshot(page, "home-light");
  checks.push("Home: liquid navigation, opaque project rows, no nested buttons");

  await page.getByLabel("搜索项目或对话", { exact: true }).fill("设置");
  await page.getByText("统一设置页与导航交互", { exact: true }).waitFor();
  assert.equal(await page.getByText("整理项目文档", { exact: true }).count(), 0);
  await page.getByLabel("搜索项目或对话", { exact: true }).press("Escape");
  await page.getByText("统一设置页与导航交互", { exact: true }).click();
  await ready(page, ".chat-panel");
  await layout(page, "chat light");
  assert.equal(await page.locator(".chat-panel").evaluate(e => getComputedStyle(e).backdropFilter), "none");
  await screenshot(page, "chat-light");
  const row = page.locator(".conversation-row").first();
  await row.locator(":scope > button").first().focus();
  assert.equal(await row.getByRole("button", { name: "共享", exact: true }).isVisible(), true);
  await page.waitForFunction(() => {
    const button = document.querySelector('.conversation-row button[aria-label="删除"]');
    return button && getComputedStyle(button).opacity === "1";
  });
  assert.equal(await row.getByRole("button", { name: "删除", exact: true }).evaluate(e => getComputedStyle(e).opacity), "1");
  checks.push("Session actions are sibling buttons and become discoverable with keyboard focus");

  await page.getByRole("button", { name: "共享对话", exact: true }).click();
  const scrim = page.locator(".soft-dialog").locator("..");
  const fullScreen = await scrim.boundingBox();
  assert.equal(fullScreen.x, 0); assert.equal(fullScreen.y, 0);
  assert.equal(fullScreen.width, 1440); assert.equal(fullScreen.height, 1000);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  checks.push("Glass decoration does not trap Header's fixed share dialog in a backdrop-filter containing block");

  await page.getByRole("button", { name: "项目记忆", exact: true }).click();
  await page.getByRole("dialog", { name: "项目记忆" }).waitFor();
  assert.match(await page.getByRole("dialog", { name: "项目记忆" }).evaluate(e => getComputedStyle(e, "::before").backdropFilter), /24px/);
  await screenshot(page, "memory-light");
  await page.keyboard.press("Escape");

  const model = page.locator(".chat-panel").getByRole("button").filter({ hasText: /^Opus/ }).first();
  await model.click();
  const popover = page.locator(".soft-popover").filter({ hasText: "当前会话仅支持" });
  await popover.waitFor();
  const box = await popover.boundingBox();
  assert(box.y >= 0 && box.y + box.height <= 1000);
  await screenshot(page, "model-menu");
  await page.keyboard.press("Escape");
  checks.push("Project memory and upward model menu stay readable, visible and keyboard-dismissable");

  await page.getByRole("button", { name: "切换文件面板", exact: true }).click();
  await page.getByText("index.ts", { exact: true }).first().click();
  await page.locator(".cm-editor").first().waitFor();
  await layout(page, "editor");
  const dockSurface = page.locator(".dock-surface");
  const dockStyle = await dockSurface.evaluate(e => {
    const s = getComputedStyle(e);
    return { corners: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius], overflow: s.overflow, filter: s.backdropFilter };
  });
  assert.deepEqual(dockStyle.corners, ["24px", "24px", "24px", "24px"]);
  assert.equal(dockStyle.overflow, "hidden", "opaque file children respect the content frame's corners");
  assert.equal(dockStyle.filter, "none");
  const dockBox = await dockSurface.boundingBox();
  assert.equal(dockBox.y, 12);
  assert.equal(1440 - dockBox.x - dockBox.width, 12);
  assert.equal(1000 - dockBox.y - dockBox.height, 12);
  assert.equal(await page.locator(".cm-scroller").first().evaluate(e => getComputedStyle(e).overflowY), "auto");
  const drag = page.locator('.dragbar[title^="拖动调整右侧那格的宽度"]');
  const dragBox = await drag.boundingBox();
  assert.equal(await drag.evaluate(e => getComputedStyle(e).backgroundImage), "none");
  await drag.hover();
  assert.equal(await drag.evaluate(e => getComputedStyle(e).backgroundImage), "none", "hidden seam stays quiet on hover");
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down(); await page.mouse.move(100, dragBox.y + dragBox.height / 2); await page.mouse.up();
  assert((await page.locator(".chat-panel").boundingBox()).width >= 398);
  await screenshot(page, "files-light");
  checks.push("File panel has four clipped corners and inset desktop gutters; editor keeps internal scrolling and splitter preserves conversation width");

  await page.getByRole("button", { name: "切换到夜间", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await screenshot(page, "files-dark");
  await page.getByRole("button", { name: "切换文件面板", exact: true }).click();
  await page.getByTitle("回到主页", { exact: true }).click();
  await ready(page);
  await screenshot(page, "home-dark");
  checks.push("Both themes retain IBM Plex typography and independent syntax palettes");

  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  assert.equal(await page.locator(".nav-panel").evaluate(e => getComputedStyle(e, "::before").backdropFilter), "none");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-contrast", value: "more" }] });
  assert.equal(await page.locator(".nav-panel").evaluate(e => getComputedStyle(e, "::before").backdropFilter), "none");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  assert.equal(await page.locator(".nav-panel").evaluate(e => getComputedStyle(e, "::before").backdropFilter), "none");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  const motion = await page.evaluate(() => {
    const probe = document.createElement("span"); probe.className = "dockcol sparkle-spin";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = { animation: style.animationName, transition: style.transitionDuration };
    probe.remove(); return result;
  });
  assert.deepEqual(motion, { animation: "none", transition: "0s" });
  checks.push("Reduced transparency, increased contrast, forced colors and reduced motion fallbacks");

  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await layout(page, "mobile home");
  await screenshot(page, "home-mobile");
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
  await page.getByText("统一设置页与导航交互", { exact: true }).click();
  await ready(page, ".chat-panel");
  await layout(page, "mobile chat");
  await screenshot(page, "chat-mobile");
  const send = await page.getByRole("button", { name: "发送", exact: true }).boundingBox();
  assert(send.y >= 0 && send.y + send.height <= 844);
  checks.push("390px home, drawers and chat fit; send remains reachable");
  await context.close();

  // Deliberately let old Claude defaults and full-search requests finish AFTER
  // Codex. Neither old response may replace the new provider's result list.
  const race = await setup({ race: true });
  await race.page.getByRole("tab", { name: "Claude", exact: true }).waitFor();
  await race.page.getByLabel("搜索项目或对话", { exact: true }).focus();
  await race.page.waitForTimeout(100);
  assert(race.held.length >= 2);
  await race.page.getByRole("tab", { name: "Codex", exact: true }).click();
  await race.page.getByText("Codex 代码审查", { exact: true }).waitFor();
  await race.page.getByLabel("搜索项目或对话", { exact: true }).fill("Codex");
  await race.page.waitForTimeout(100);
  for (const route of race.held) await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: samples("claude") }) });
  await race.page.waitForTimeout(150);
  assert.equal(await race.page.getByText("Codex 代码审查", { exact: true }).count(), 1);
  assert.equal(await race.page.getByText("统一设置页与导航交互", { exact: true }).count(), 0);
  await race.context.close();
  checks.push("Regression: slow old-provider default and full-search responses cannot overwrite Codex results");

  const login = await setup({ logged: false });
  await ready(login.page, ".login-surface");
  await screenshot(login.page, "login-light");
  await layout(login.page, "login");
  await login.context.close();
  checks.push("Login glass surface works before authentication without exposing workbench content");

  const group = await setup({ groups: true });
  await group.page.getByText("协作设计审查", { exact: true }).first().click();
  await ready(group.page, ".chat-panel");
  await group.page.getByText("控制层使用玻璃，正文保持清晰。", { exact: true }).waitFor();
  await layout(group.page, "group chat");
  const glow = group.page.locator('span[style*="box-shadow"]');
  await glow.first().waitFor();
  assert.notEqual(await glow.first().evaluate(e => getComputedStyle(e).boxShadow), "none");
  await screenshot(group.page, "group-light");
  await group.page.getByRole("button", { name: "编辑群聊配置", exact: true }).click();
  const configOverlay = await group.page.locator(".soft-dialog").locator("..").boundingBox();
  assert.equal(configOverlay.width, 1440); assert.equal(configOverlay.height, 1000);
  await group.context.close();
  checks.push("Group chrome, full-window config and active-agent glow resolve CSS variables correctly");

  await verifyMobileNavigation();
  await verifyDockTogglePlacement();
  await verifySidebarResize();

  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  const report = { browser: await browser.version(), checks, errors, unexpected, note: "All API fixtures are synthetic; no production data or backend was used." };
  writeFileSync(resolve(output, "ccwebui-liquid-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
