import { readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

// Minimal .env loader. Avoids a runtime dependency on `dotenv` and avoids
// having to thread node's --env-file flag through tsx. Variables already
// present in process.env take precedence (so the shell can override).
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
