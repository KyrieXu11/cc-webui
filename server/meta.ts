import { Hono } from "hono";
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
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return c.json({ ...cached.scan, cached: true });
  }
  const scan = await scanClaudeCommands(cwd);
  cache.set(key, { ts: Date.now(), scan });
  return c.json({ ...scan, cached: false });
});

export { metaRoute };
