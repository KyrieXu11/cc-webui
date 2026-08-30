import { Hono } from "hono";
import { groupsEnabled } from "./features.ts";
import { officeConfigured } from "./office.ts";
import { clientRelease } from "./client-release.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const metaRoute = new Hono();

// Stable across Claude CLI versions. Not discoverable via filesystem.
const BUILTIN_COMMANDS = [
  "compact",
  "context",
  "cost",
  "heapdump",
  "init",
  "review",
  "security-review",
  "extra-usage",
  "insights",
  "team-onboarding",
  "debug",
  "batch",
];

type Scan = {
  slashCommands: string[];
  skills: string[];
};

async function readDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readMdNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3));
  } catch {
    return [];
  }
}

function expandHome(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Scan a `.claude/` root for user-style commands + skills (no plugin prefix).
async function scanLocalClaudeRoot(
  root: string,
  commandSet: Set<string>,
  skillSet: Set<string>
) {
  for (const name of await readDirs(path.join(root, "skills"))) {
    commandSet.add(name);
    skillSet.add(name);
  }
  for (const name of await readMdNames(path.join(root, "commands"))) {
    commandSet.add(name);
  }
}

async function scanClaudeCommands(cwd?: string): Promise<Scan> {
  const home = os.homedir();
  const homeRoot = path.join(home, ".claude");
  const commandSet = new Set<string>(BUILTIN_COMMANDS);
  const skillSet = new Set<string>();

  // Global user-level skills and commands
  await scanLocalClaudeRoot(homeRoot, commandSet, skillSet);

  // Project-level overrides / additions at <cwd>/.claude
  if (cwd) {
    const projectRoot = path.join(cwd, ".claude");
    if (projectRoot !== homeRoot) {
      await scanLocalClaudeRoot(projectRoot, commandSet, skillSet);
    }
  }

  // Plugin-level skills and commands (global only)
  const pluginsCache = path.join(homeRoot, "plugins", "cache");
  const vendors = await readDirs(pluginsCache);
  for (const vendor of vendors) {
    const vendorPath = path.join(pluginsCache, vendor);
    const plugins = await readDirs(vendorPath);
    for (const pluginName of plugins) {
      const pluginPath = path.join(vendorPath, pluginName);
      const versions = await readDirs(pluginPath);
      for (const v of versions) {
        const versionPath = path.join(pluginPath, v);
        for (const skill of await readDirs(path.join(versionPath, "skills"))) {
          commandSet.add(`${pluginName}:${skill}`);
          skillSet.add(`${pluginName}:${skill}`);
        }
        for (const cmd of await readMdNames(path.join(versionPath, "commands"))) {
          commandSet.add(`${pluginName}:${cmd}`);
        }
      }
    }
  }

  return {
    slashCommands: Array.from(commandSet).sort((a, b) => a.localeCompare(b)),
    skills: Array.from(skillSet).sort((a, b) => a.localeCompare(b)),
  };
}

type CacheEntry = {
  ts: number;
  scan: Scan;
};
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000;

metaRoute.get("/", async (c) => {
  const cwd = expandHome(c.req.query("cwd") || process.env.CC_WEBUI_CWD);
  const key = cwd ?? "__global__";
  const cached = cache.get(key);
  // Feature flags are read fresh (not cached) — they're env lookups, and the
  // frontend uses `features.groups` to decide whether the group-chat surface
  // exists at all.
  // office=false 时前端把 Office 文件降级成只读/下载，而不是给一个点了没反应的按钮。
  const features = { groups: groupsEnabled(), office: officeConfigured() };
  // 桌面客户端的当前版本（docs/desktop-client.md 决策 26/28）。**没发布过就整个
  // 字段缺席**——客户端据「在不在」判断要不要比 semver，给个空对象等于逼它多写
  // 一条判空。和 features 一样每次现算（60 秒缓存只盖 slashCommands/skills 那个
  // Scan），所以下面**两条 return 都要带**；只加一条会让字段时有时无，而第一次
  // 请求总是走重扫那条，本地根本复现不出来。
  const release = clientRelease();
  const desktopClient = release ? { desktopClient: release } : {};
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return c.json({ ...cached.scan, features, ...desktopClient, cached: true });
  }
  const scan = await scanClaudeCommands(cwd);
  cache.set(key, { ts: Date.now(), scan });
  return c.json({ ...scan, features, ...desktopClient, cached: false });
});

export { metaRoute };
