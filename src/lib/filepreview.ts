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

export function getImageMime(name: string): string {
  const ext = getExt(name);
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

export function rawFileUrl(absPath: string): string {
  return `/api/fs/raw?path=${encodeURIComponent(absPath)}`;
}
