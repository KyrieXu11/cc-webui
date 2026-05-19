#!/usr/bin/env node
// Print the current Feishu chat-id ↔ cc-webui gid binding table,
// enriched with cwd, last activity time, last user snippet, and (when
// available) the Feishu chat mode + name.
//
// Usage:
//   node cli/feishu-bindings.mjs              # default: FEISHU_CLAUDE_*
//   node cli/feishu-bindings.mjs codex        # use FEISHU_CODEX_* credentials
//   node cli/feishu-bindings.mjs --no-net     # skip Feishu API calls (offline)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const BINDINGS_PATH = path.join(HOME, ".cc-webui/feishu/bindings.json");
const INDEX_PATH = path.join(HOME, ".cc-webui/groups/index.json");
const GROUPS_DIR = path.join(HOME, ".cc-webui/groups");

const args = process.argv.slice(2);
const noNet = args.includes("--no-net");
const botKey = (args.find((a) => !a.startsWith("--")) ?? "claude").toUpperCase();
const ENV_PREFIX = `FEISHU_${botKey}`;

main().catch((err) => {
  console.error("error:", err.message ?? err);
  process.exit(1);
});

async function main() {
  const bindings = readJson(BINDINGS_PATH);
  if (!bindings || Object.keys(bindings).length === 0) {
    console.log("(no bindings)");
    return;
  }
  const groupsIdx = readJson(INDEX_PATH);
  const groupById = new Map(
    (groupsIdx?.groups ?? []).map((g) => [g.id, g]),
  );

  // Best-effort Feishu lookup; degrades to "?" when token unavailable or API
  // returns nothing (common for p2p chats — they have no name).
  let token = null;
  if (!noNet) token = await getTenantToken();

  const rows = [];
  for (const [chatId, gid] of Object.entries(bindings)) {
    const grp = groupById.get(gid);
    const cwd = grp?.cwd ?? "?";
    const snippet = lastUserSnippet(gid);
    const lastTs = grp?.lastTs ? humanTs(grp.lastTs) : "?";
    let mode = "?";
    let name = "";
    if (token) {
      const info = await fetchChatInfo(token, chatId);
      mode = info?.chat_mode || "?";
      name = info?.name || "";
      // For p2p chats Feishu returns no name — peer identity lives in the
      // member list. Owner of a p2p is one of the two parties; we just list
      // members and pick whichever doesn't match our bot.
      if (mode === "p2p" && !name) {
        const members = await fetchChatMembers(token, chatId);
        name = members.map((m) => m.name).join(", ");
      }
    }
    rows.push({ chatId, gid, mode, name, cwd, lastTs, snippet });
  }

  rows.sort((a, b) => (b.lastTs > a.lastTs ? 1 : -1));
  print(rows);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function lastUserSnippet(gid) {
  const file = path.join(GROUPS_DIR, gid, "transcript.jsonl");
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e?.agent === "user" && typeof e.event?.text === "string") {
          return clip(e.event.text.replace(/\s+/g, " "), 40);
        }
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* no transcript */
  }
  return "";
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function humanTs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function getTenantToken() {
  loadDotEnv();
  const appId = process.env[`${ENV_PREFIX}_APP_ID`];
  const appSecret = process.env[`${ENV_PREFIX}_APP_SECRET`];
  if (!appId || !appSecret) {
    console.error(
      `# ${ENV_PREFIX}_APP_ID / _APP_SECRET not set — running offline (no chat names)`,
    );
    return null;
  }
  try {
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );
    const data = await res.json();
    if (data.code !== 0) {
      console.error(`# tenant_access_token failed: ${data.msg}`);
      return null;
    }
    return data.tenant_access_token;
  } catch (err) {
    console.error("# tenant_access_token error:", err.message);
    return null;
  }
}

let permissionWarned = false;

function checkPermission(data) {
  if (data?.code === 99991672 && !permissionWarned) {
    permissionWarned = true;
    console.error(
      "# 提示: 飞书应用未开 im:chat:readonly 权限，type/name 列将为空。",
    );
    console.error(
      "#       去开发者后台「权限管理」搜 im:chat:readonly 添加 → 重新发布版本。",
    );
  }
}

async function fetchChatInfo(token, chatId) {
  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    checkPermission(data);
    return data?.data ?? null;
  } catch {
    return null;
  }
}

async function fetchChatMembers(token, chatId) {
  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?page_size=20`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    checkPermission(data);
    return data?.data?.items ?? [];
  } catch {
    return [];
  }
}

function loadDotEnv() {
  // Prefer .env in cwd, fall back to project root inferred from this script.
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
    return;
  }
}

function print(rows) {
  const cols = [
    { key: "chatId", label: "chat_id", width: 38 },
    { key: "gid", label: "gid", width: 10, fmt: (v) => v.slice(0, 8) },
    { key: "mode", label: "type", width: 6 },
    { key: "name", label: "name", width: 18 },
    { key: "cwd", label: "cwd", width: 32 },
    { key: "lastTs", label: "last", width: 17 },
    { key: "snippet", label: "snippet", width: 42 },
  ];
  const fmt = (v, w) => {
    const s = v == null ? "" : String(v);
    return s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w);
  };
  console.log(
    cols.map((c) => fmt(c.label, c.width)).join("  "),
  );
  console.log(cols.map((c) => "─".repeat(c.width)).join("  "));
  for (const r of rows) {
    console.log(
      cols
        .map((c) => fmt(c.fmt ? c.fmt(r[c.key] ?? "") : r[c.key], c.width))
        .join("  "),
    );
  }
  console.log("");
  console.log(`# ${rows.length} binding(s)`);
}
