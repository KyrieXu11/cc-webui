import { promises as fs } from "node:fs";
import path from "node:path";
import { feishuDataDir } from "./config.ts";

type BindingMap = Record<string, string>;
let CACHE: BindingMap | null = null;

function bindingsPath(): string {
  return path.join(feishuDataDir(), "bindings.json");
}

async function load(): Promise<BindingMap> {
  if (CACHE !== null) return CACHE;
  try {
    const raw = await fs.readFile(bindingsPath(), "utf8");
    CACHE = JSON.parse(raw) as BindingMap;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      CACHE = {};
    } else {
      throw err;
    }
  }
  return CACHE!;
}

async function save(map: BindingMap): Promise<void> {
  await fs.mkdir(feishuDataDir(), { recursive: true });
  const tmp = bindingsPath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(map, null, 2));
  await fs.rename(tmp, bindingsPath());
}

export async function getBinding(chatId: string): Promise<string | undefined> {
  const map = await load();
  return map[chatId];
}

export async function setBinding(chatId: string, gid: string): Promise<void> {
  const map = await load();
  map[chatId] = gid;
  await save(map);
}

export async function removeBinding(chatId: string): Promise<boolean> {
  const map = await load();
  if (!(chatId in map)) return false;
  delete map[chatId];
  await save(map);
  return true;
}
