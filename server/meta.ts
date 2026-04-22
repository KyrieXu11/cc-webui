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

async function scanClaudeCommands(): Promise<Scan> {
  const home = os.homedir();
  const root = path.join(home, ".claude");
  const commandSet = new Set<string>(BUILTIN_COMMANDS);
  const skillSet = new Set<string>();

  // User-level skills and commands
  for (const name of await readDirs(path.join(root, "skills"))) {
    commandSet.add(name);
    skillSet.add(name);
  }
  for (const name of await readMdNames(path.join(root, "commands"))) {
    commandSet.add(name);
  }

  // Plugin-level skills and commands
  const pluginsCache = path.join(root, "plugins", "cache");
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
let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60 * 1000;

metaRoute.get("/", async (c) => {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return c.json({ ...cache.scan, cached: true });
  }
  const scan = await scanClaudeCommands();
  cache = { ts: Date.now(), scan };
  return c.json({ ...scan, cached: false });
});

export { metaRoute };
