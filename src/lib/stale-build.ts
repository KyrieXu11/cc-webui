// 「构建产物换了，但这个页面还是旧的那一份」。
//
// Vite 的 chunk 文件名带内容 hash，所以每次 `npm run build` 之后旧文件名就没了。
// 一个开着不动的标签页在那之后再触发任何 `import()`（这个仓库里就是 CodeMirror 的
// 语言包、按扩展名懒加载的那批）都会拿到 404，浏览器把它报成
// 「Failed to fetch dynamically imported module: …/assets/index-XXXX.js」。
//
// 这不是缓存坏了，也不是网络问题——是**页面比服务端旧**，唯一的修法是重新加载。
// 生产实例正好是「构建即上线」（服务直接托管仓库里的 dist/，不重启），所以每次
// 部署都会命中，用户看到的却是一句和真因无关的报错。
//
// ⚠️ 必须防转圈：如果刷新之后还是同样的错，那就**不是**陈旧构建（比如 chunk 真的
// 没被上传），这时候再自动刷新就是无限重载。所以记一个时间戳，短时间内只刷一次。

const KEY = "cc-webui:stale-build-reload";
const COOLDOWN_MS = 30_000;

const PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i, // Safari
  /dynamically imported module/i,
];

export function isStaleChunkError(err: unknown): boolean {
  const msg =
    err instanceof Error ? `${err.message}` : typeof err === "string" ? err : "";
  return !!msg && PATTERNS.some((re) => re.test(msg));
}

/**
 * 是陈旧构建就重新加载页面。
 * @returns true = 已经在刷新了，调用方不用再显示错误（马上就没了）。
 */
export function reloadIfStaleBuild(err: unknown): boolean {
  if (!isStaleChunkError(err)) return false;
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0);
    // 刚刷过还是这个错 —— 说明刷新解决不了，让错误正常显示出来。
    if (Date.now() - last < COOLDOWN_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // 隐私模式下 sessionStorage 会抛。没有防转圈的手段就不自动刷，宁可显示错误。
    return false;
  }
  console.warn("[cc-webui] 检测到服务端构建已更新，正在重新加载页面…");
  location.reload();
  return true;
}

/** 挂一次，兜住所有没有单独 catch 的懒加载。 */
export function watchForStaleBuild(): void {
  // Vite 自己在 preload 失败时会派发这个事件（比 import() 的 catch 更早、更全）。
  window.addEventListener("vite:preloadError", (e) => {
    const payload = (e as CustomEvent<unknown>).detail;
    if (reloadIfStaleBuild(payload)) e.preventDefault();
  });
  // 没被任何人 catch 的 import() 失败走这里。
  window.addEventListener("unhandledrejection", (e) => {
    if (reloadIfStaleBuild(e.reason)) e.preventDefault();
  });
}
