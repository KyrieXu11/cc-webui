import { promises as fs } from "node:fs";
import {
  configPath,
  ensureGroupDir,
  type AgentId,
} from "./store.ts";

export type GroupMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type GroupEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type Participant = {
  id: AgentId;
  model: string;
  mode?: GroupMode;
  effort?: GroupEffort;
  systemPrompt?: string;
  skills: string[];
  mcpServers: string[];
};

export type GroupConfig = {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  participants: Participant[];
  pipeline: AgentId[];
};

export function validateConfig(c: GroupConfig): void {
  if (!c.id || typeof c.id !== "string") {
    throw new Error("config.id required");
  }
  if (!c.title || typeof c.title !== "string") {
    throw new Error("config.title required");
  }
  if (!c.cwd || typeof c.cwd !== "string") {
    throw new Error("config.cwd required");
  }
  if (!Array.isArray(c.participants) || c.participants.length !== 2) {
    throw new Error("config requires exactly 2 participants");
  }
  const ids = c.participants.map((p) => p.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("participants ids must be unique");
  }
  for (const id of ids) {
    if (id !== "claude" && id !== "codex") {
      throw new Error(
        `participant id must be one of {claude, codex}, got ${id}`,
      );
    }
  }
  if (
    !Array.isArray(c.pipeline) ||
    c.pipeline.length !== c.participants.length
  ) {
    throw new Error("pipeline length must match participants");
  }
  if (new Set(c.pipeline).size !== c.pipeline.length) {
    throw new Error("pipeline cannot contain duplicates");
  }
  for (const pid of c.pipeline) {
    if (!ids.includes(pid)) {
      throw new Error(`pipeline references unknown participant ${pid}`);
    }
  }
}

export async function writeConfig(c: GroupConfig): Promise<void> {
  validateConfig(c);
  await ensureGroupDir(c.id);
  const tmp = configPath(c.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(c, null, 2));
  await fs.rename(tmp, configPath(c.id));
}

export async function readConfig(gid: string): Promise<GroupConfig> {
  const raw = await fs.readFile(configPath(gid), "utf8");
  const parsed = JSON.parse(raw) as GroupConfig;
  validateConfig(parsed);
  return parsed;
}

export function defaultConfig(opts: {
  id: string;
  title: string;
  cwd: string;
}): GroupConfig {
  const now = Date.now();
  return {
    id: opts.id,
    title: opts.title,
    cwd: opts.cwd,
    createdAt: now,
    updatedAt: now,
    participants: [
      {
        id: "claude",
        model: "claude-opus-4-7",
        mode: "default",
        effort: "medium",
        systemPrompt: "",
        skills: [],
        mcpServers: ["bash"],
      },
      {
        id: "codex",
        model: "gpt-5.3-codex",
        effort: "medium",
        systemPrompt: "",
        skills: [],
        mcpServers: ["bash"],
      },
    ],
    pipeline: ["claude", "codex"],
  };
}
