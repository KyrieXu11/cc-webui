import { readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

// Minimal .env loader for the whole app. Avoids a runtime dependency on
// `dotenv` and avoids threading node's --env-file through tsx. Variables
// already present in process.env win, so the shell can always override.
//
// Called once from server/index.ts before anything reads config. It used to
// live under server/feishu/ and be invoked only by the Feishu modules, which
// meant app-wide settings (CC_WEBUI_ADMIN, …) silently never reached
// process.env from .env at all.
//
// CC_WEBUI_DOTENV points it at a different file — handy for running without
// the Feishu credentials, since loading them connects live bots.
export function loadDotEnvOnce(): void {
  if (loaded) return;
  loaded = true;
  const dotenvPath = process.env.CC_WEBUI_DOTENV ?? path.resolve(".env");
  let content: string;
  try {
    content = readFileSync(dotenvPath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const stripped = trimmed.replace(/^export\s+/, "");
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
