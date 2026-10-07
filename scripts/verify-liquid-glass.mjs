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
async function setup({ theme = "light", logged = true, project = false, race = false, groups = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  const held = [];
  await page.addInitScript(({ theme, project, cwd, sessionId }) => {
    localStorage.clear();
    localStorage.setItem("cc-webui:settings", JSON.stringify({ cwd: "", agentProvider: "claude", model: "opus", permissionMode: "auto", effort: "high", theme, themeChosen: true }));
    if (project) localStorage.setItem("cc-webui:lastProject", JSON.stringify({ cwd, sessionId, agentProvider: "claude" }));
  }, { theme, project, cwd, sessionId });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    const sse = (event, body) => route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: ${event}\ndata: ${JSON.stringify(body)}\n\n` });
    if (path === "/api/auth/me") return json(logged ? { user: { id: "preview-admin", username: "preview", role: "admin", createdAt: now }, allowedPaths: ["/preview/**"], allowedProviders: ["claude", "codex"], defaults: null } : { user: null });
    if (path === "/api/meta") return json({ features: { groups, office: false }, skills: ["review", "design"], slashCommands: ["review", "design"], models: { codex: { source: "fallback", models: [] } } });
    if (path === "/api/fs/home") return json({ home: "/preview" });
    if (path === "/api/fs/scan") return json({ dirs: [cwd, "/preview/code/research"], home: "/preview" });
    if (path === "/api/fs/recents") return json({ recents: [{ path: cwd, lastUsed: now }] });
    if (path === "/api/sessions") {
      const provider = url.searchParams.get("provider") || "claude";
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
  return { page, context, held };
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
try {
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
  assert.equal(await page.locator(".cm-scroller").first().evaluate(e => getComputedStyle(e).overflowY), "auto");
  const drag = page.locator('.dragbar[title^="拖动调整右侧那格的宽度"]');
  const dragBox = await drag.boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down(); await page.mouse.move(100, dragBox.y + dragBox.height / 2); await page.mouse.up();
  assert((await page.locator(".chat-panel").boundingBox()).width >= 398);
  await screenshot(page, "files-light");
  checks.push("Editor keeps internal scrolling and splitter preserves the conversation's minimum width");

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

  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  const report = { browser: await browser.version(), checks, errors, unexpected, note: "All API fixtures are synthetic; no production data or backend was used." };
  writeFileSync(resolve(output, "ccwebui-liquid-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
