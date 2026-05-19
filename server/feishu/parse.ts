export type Command =
  | { kind: "bind"; gid: string }
  | { kind: "unbind" }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "cd"; path?: string }
  | { kind: "cwd" }
  | { kind: "new"; path?: string }
  | { kind: "model"; name?: string }
  | { kind: "effort"; level?: string }
  | { kind: "mode"; name?: string }
  | { kind: "resume"; prefix?: string }
  | { kind: "chat"; text: string };

export function parseCommand(text: string): Command {
  const t = text.trim();
  if (t === "/help" || t === "/?") return { kind: "help" };
  if (t === "/stop") return { kind: "stop" };
  if (t === "/unbind") return { kind: "unbind" };
  if (t === "/status") return { kind: "status" };
  if (t === "/cwd") return { kind: "cwd" };
  if (t === "/new") return { kind: "new" };
  const newWith = t.match(/^\/new\s+(.+)$/);
  if (newWith) return { kind: "new", path: newWith[1].trim() };
  if (t === "/cd") return { kind: "cd" };
  const cd = t.match(/^\/cd\s+(.+)$/);
  if (cd) return { kind: "cd", path: cd[1].trim() };
  const bind = t.match(/^\/bind\s+(\S+)$/);
  if (bind) return { kind: "bind", gid: bind[1] };
  if (t === "/model") return { kind: "model" };
  const model = t.match(/^\/model\s+(\S+)$/);
  if (model) return { kind: "model", name: model[1].trim() };
  if (t === "/effort") return { kind: "effort" };
  const effort = t.match(/^\/effort\s+(\S+)$/);
  if (effort) return { kind: "effort", level: effort[1].trim() };
  if (t === "/mode") return { kind: "mode" };
  const mode = t.match(/^\/mode\s+(\S+)$/);
  if (mode) return { kind: "mode", name: mode[1].trim() };
  if (t === "/resume") return { kind: "resume" };
  const resume = t.match(/^\/resume\s+(\S+)$/);
  if (resume) return { kind: "resume", prefix: resume[1].trim() };
  return { kind: "chat", text: t };
}

export const HELP_TEXT = [
  "🤖 飞书 ↔ cc-webui",
  "",
  "直接 @ 我发消息即可，第一次会自动建会话。",
  "",
  "命令：",
  "  /cd <path>     换目录 (保留对话历史)",
  "  /cwd           看当前会话的工作目录",
  "  /new           保留目录、清空历史、起新会话",
  "  /new <path>    换目录 + 清空历史 (彻底重开)",
  "  /model         显示当前 Claude 模型",
  "  /model <name>  切换模型（opus / sonnet / haiku 或完整 ID）",
  "  /effort        显示当前 thinking effort",
  "  /effort <lvl>  切换 effort (low / medium / high / xhigh / max)",
  "  /mode          显示当前权限模式",
  "  /mode <name>   切换权限模式：",
  "                   default  — 危险工具弹问询",
  "                   auto     — 模型分类器自动判断 (推荐)",
  "                   edits    — 自动接受 Edit/Write，其他仍问",
  "                   yolo     — 全部放行 (bypassPermissions)",
  "                   dontAsk  — 不询问，未预批一律拒",
  "                   plan     — 只规划不执行",
  "  /resume        列当前 cwd 下最近 10 个会话",
  "  /resume <id>   切到指定 id 前缀的会话（跨 cwd 也行）",
  "  /status        绑定 / 运行状态",
  "  /stop          中止本群正在跑的一轮",
  "  /bind <gid>    绑到 cc-webui 里已有的会话（精确 gid）",
  "  /unbind        解绑",
  "  /help          显示这条帮助",
].join("\n");
