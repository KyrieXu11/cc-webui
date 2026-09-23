const TEXT_EXTENSIONS = new Set([
  // plain / markdown / docs
  "txt", "md", "markdown", "mdx", "rst", "log", "csv", "tsv", "tex", "bib", "org",
  // web / js ecosystem
  "html", "htm", "css", "scss", "sass", "less",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "astro",
  // mainstream languages
  "py", "pyi", "ipynb", "rb", "go", "rs", "java", "kt", "kts", "scala", "groovy",
  "c", "h", "cpp", "hpp", "cc", "cxx", "hh", "m", "mm",
  "swift", "dart", "php", "cs", "vb", "fs", "fsx", "fsi",
  "lua", "perl", "pl", "r", "jl", "ex", "exs", "erl", "elm", "clj", "cljs", "edn",
  // shell / build
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "mk", "makefile", "cmake",
  // query / schema
  "sql", "graphql", "gql", "proto", "thrift", "avsc",
  // config / data
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini",
  "conf", "cfg", "env", "properties", "xml", "plist",
  // misc
  "lock", "gitignore", "gitattributes", "editorconfig", "prettierrc",
  "eslintrc", "babelrc", "npmrc", "nvmrc", "dockerignore",
]);

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const TEXT_BASENAMES = new Set([
  "Dockerfile", "Makefile", "Rakefile", "Gemfile", "Procfile",
  "README", "LICENSE", "NOTICE", "CHANGELOG", "AUTHORS", "COPYING",
  ".gitignore", ".dockerignore", ".env", ".editorconfig",
]);

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isTextFile(name: string): boolean {
  if (!name) return false;
  if (TEXT_BASENAMES.has(name)) return true;
  const ext = getExt(name);
  return !!ext && TEXT_EXTENSIONS.has(ext);
}

export function isImageFile(name: string): boolean {
  const ext = getExt(name);
  return !!ext && IMAGE_EXTENSIONS.has(ext);
}

// PDF 交给浏览器自带的 viewer（<iframe src=raw>）——翻页/搜索/打印/缩放它全都有，
// 自己用 pdf.js 重写一遍只会更差，而且要多一个 ~1MB 的依赖。
// 前提是 /api/fs/raw 得回 `application/pdf`：回 octet-stream 的话浏览器会当下载。
export function isPdfFile(name: string): boolean {
  return getExt(name) === "pdf";
}

export function getImageMime(name: string): string {
  const ext = getExt(name);
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

// .html / .htm 仍然留在 TEXT_EXTENSIONS 里（源码档要 CodeMirror），这个只是回答
// 「它还配不配有一个渲染档」。和 md 一样：渲染 / 源码两档，一个开关切。
export function isHtmlFile(name: string): boolean {
  const ext = getExt(name);
  return ext === "html" || ext === "htm";
}

export function rawFileUrl(absPath: string): string {
  return `/api/fs/raw?path=${encodeURIComponent(absPath)}`;
}

// 渲染 HTML 的 iframe 沙箱档位。
//
// ⚠️⚠️ **`allow-scripts` 和 `allow-same-origin` 绝对不能同时给**。规范里写明了这一对
// 组合「可以让内容移除自己的沙箱」：拿到同源身份的脚本可以直接改父文档里这个
// iframe 的 sandbox 属性再让它重载，于是沙箱自己把自己拆了。而这里的内容是
// **agent 写出来的文件**，还共用着 /api/fs/raw 这个同源地址 —— 一旦它拿到本站源，
// 登录 cookie、localStorage、以登录身份打 /api/* 就全开了，多用户下就是横向越权。
// 只给 allow-scripts（不给 same-origin），它就落在一个 opaque origin 上：页面该跑
// 的跑，本站的东西一样都摸不到。
//
// 这一串必须和 server/fs.ts 里的 HTML_SANDBOX 一字不差：两边同时生效时浏览器取
// **交集**，写岔了会莫名其妙少掉一档能力。
export const HTML_SANDBOX = "allow-scripts allow-popups allow-forms allow-modals";

/**
 * 渲染 HTML 用的 URL。
 *
 * `render=1` 是让 /api/fs/raw 回 text/html 的开关（缺省回 octet-stream，iframe 里
 * 什么都不会渲染 —— 原因见 server/fs.ts 里那段注释，别改成无条件回 text/html）。
 *
 * `v` 传文件的 mtimeMs：**URL 不变，iframe 就不会重新导航**，保存完页面纹丝不动。
 * （服务端那侧 render 响应已经是 no-store，所以这个参数管的是「让 React 换一次
 * src」，不是缓存。）
 *
 * ⚠️ **已知限制**：页面里的相对资源（`<img src="./a.png">`）解析不出来。基地址是
 * `/api/fs/raw?path=…` 这种查询串 URL，`./a.png` 会被解析成 `/api/a.png` 而 404。
 * 刻意**不**为它另开一条按路径的静态路由：那条路会绕开 /raw 这边的目录白名单校验。
 * 主场景是自包含的单文件 html（样式/脚本/图片都内联），够用。
 */
export function renderedHtmlUrl(absPath: string, version?: number | null): string {
  const v = version ? `&v=${Math.round(version)}` : "";
  return `${rawFileUrl(absPath)}&render=1${v}`;
}
