import { isImageFile, isPdfFile, isTextFile } from "./filepreview";
import type { DockFile } from "./dock-bridge";

type Source = "code" | "link";
const absoluteBase = (cwd: string) => cwd.startsWith("/") && !cwd.startsWith("//") && !/[\u0000-\u001f\u007f\\]/.test(cwd);
const joinReference = (path: string, cwd: string) => path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path.replace(/^(?:\.\/)+/, "")}`;

function referencePath(value: string, source: Source): string | null {
  let path = value;
  if (source === "link") {
    if (/^file:/i.test(path)) {
      try {
        const url = new URL(path);
        if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search) return null;
        path = url.pathname + url.hash;
      } catch { return null; }
    }
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  // Code locations open the file, not a fictitious filename containing :42.
  path = path.replace(/(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*(?:C[1-9]\d*)?(?:-L[1-9]\d*(?:C[1-9]\d*)?)?)$/, "");
  if (!path || path !== path.trim() || /[\u0000-\u001f\u007f\\?*<>|]/.test(path) ||
      /^(?:[a-z][a-z0-9+.-]*:|\/\/|~|#|www\.)/i.test(path) || path.startsWith("/api/")) return null;
  // Do not interpret commands such as `python scripts/build.py` as files.
  // Absolute paths and explicit Markdown destinations can contain spaces.
  if (source === "code" && !path.startsWith("/") && /\s/.test(path.split("/")[0])) return null;
  return path;
}

// Resolve references, not browser URLs. The dock's existing read/raw/Office
// endpoints still authorize every access; recognizing a path grants nothing.
// An explicitly declared directory applies only to bare names in its list.
export function resolveMessageFile(value: string, cwd: string, source: Source = "code", basenameDirectory?: string): DockFile | null {
  if (!absoluteBase(cwd)) return null;
  const path = referencePath(value, source);
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const knownFile = isTextFile(name) || isImageFile(name) || isPdfFile(name) ||
    /\.(?:docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|tar|gz|7z|rar|mp[34]|wav|mov)$/i.test(name);
  if (!knownFile && !(path.includes("/") && /^[^\s.].*\.[a-z0-9]{1,16}$/i.test(name))) return null;
  // Keep .. for the server to resolve with symlinks and its directory policy.
  const base = !path.includes("/") && basenameDirectory !== undefined ? basenameDirectory : cwd;
  if (!absoluteBase(base)) return null;
  return { path: joinReference(path, base), name };
}

export function resolveMessageDirectory(value: string, cwd: string): string | null {
  if (!absoluteBase(cwd) || !value.endsWith("/")) return null;
  const path = referencePath(value, "code");
  if (!path) return null;
  return joinReference(path, cwd).replace(/\/+$/, "") || "/";
}
