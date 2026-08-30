// `transfer` —— 在**服务端文件系统**和**用户自己的电脑**之间搬文件。
//
// 决策 18 说这两个工具是 v1 必备而不是加分项，理由是：外挂模型下 agent 有两只手，
// 各自看着一个**不同的文件系统**。没有传输工具的话，本地浏览器下载到的东西永远
// 困在家人的机器上，服务端那套内置工具（Read/Edit/Glob/Grep）对它完全看不见 ——
// 「外挂」就退化成一个孤立的浏览器。
//
// 这个 server 跑在**家人的机器上**（Electron 主进程 spawn 的子进程），通过 HTTP
// 访问 cc-webui。所以：
//
// ⚠️ **权限完全由服务端那套既有的东西决定，这里不自己发明任何检查。**
//   - 上传走 `POST /api/upload`（落 UPLOAD_DIR，文件名被 sanitize）
//   - 下载走 `GET /api/fs/raw?path=`，而 policy.ts 给它声明了
//     `paths: [{ from: "query", key: "path" }]` —— **authMiddleware 会按这个账号
//     自己的目录白名单校验**。也就是说家人的 agent 想用它去偷服务器上别处的文件，
//     会被他自己的白名单挡住，不需要这里再来一遍（再来一遍反而会漂）。
//
// ⚠️ cookie 通过环境变量传进这个子进程。同机同用户，且它本来就是那个人的会话，
// 但要知道这一点：任何能读到这台机器上进程环境的东西都能拿到它。
// 决策 3 的性质本来就是「服务端可以命令设备 spawn 任意进程」，这不额外扩大风险面。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = (process.env.CC_WEBUI_URL ?? "").replace(/\/+$/, "");
const COOKIE = process.env.CC_WEBUI_COOKIE ?? "";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

function configured(): string | null {
  if (!BASE) return "transfer 未配置：CC_WEBUI_URL 为空";
  if (!COOKIE) return "transfer 未配置：没有会话 cookie，请在客户端里重新登录";
  return null;
}

const server = new McpServer({ name: "cc-webui-transfer", version: "0.1.0" });

server.registerTool(
  "upload_to_server",
  {
    title: "把本机的文件传到服务器",
    description:
      "Upload a file from THIS COMPUTER (the user's own machine) to the cc-webui server, " +
      "so the server-side tools (Read/Edit/Glob/Grep, mcp__bash__run) can work on it. " +
      "Returns the path the file now has ON THE SERVER — use that path with server tools, " +
      "not the local one. Use this whenever you produced or found something locally that " +
      "needs further processing.",
    inputSchema: {
      local_path: z
        .string()
        .describe("Absolute path on the user's own computer."),
    },
  },
  async ({ local_path }) => {
    const bad = configured();
    if (bad) return fail(bad);
    try {
      const s = await stat(local_path);
      if (!s.isFile()) return fail(`不是一个文件：${local_path}`);

      const form = new FormData();
      // Node 的 fetch 接受 Blob/File。用流式的 Blob 避免把大文件整个读进内存。
      const buf = await new Response(
        createReadStream(local_path) as unknown as ReadableStream,
      ).arrayBuffer();
      form.append("files", new Blob([buf]), path.basename(local_path));

      const res = await fetch(`${BASE}/api/upload`, {
        method: "POST",
        headers: { cookie: COOKIE },
        body: form,
      });
      if (!res.ok) {
        return fail(`上传失败：HTTP ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as {
        files?: Array<{ path: string; size: number }>;
      };
      const f = body.files?.[0];
      if (!f) return fail("上传成功但服务端没有返回路径，这不该发生");
      return text(
        `已上传到服务器：${f.path}（${f.size} 字节）\n` +
          `⚠️ 后续对它的读写要用**这个服务端路径**，不是本机那个。`,
      );
    } catch (err) {
      return fail(`上传失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.registerTool(
  "download_from_server",
  {
    title: "把服务器上的文件取到本机",
    description:
      "Download a file from the cc-webui SERVER filesystem onto THIS COMPUTER (the user's " +
      "own machine), so the user can open it, or so local tools can work on it. " +
      "Use this to deliver a finished artefact to the user. The server enforces that " +
      "account's directory allow-list, so paths outside it are refused.",
    inputSchema: {
      server_path: z.string().describe("Absolute path on the cc-webui server."),
      local_path: z
        .string()
        .describe("Where to write it on the user's own computer (absolute)."),
    },
  },
  async ({ server_path, local_path }) => {
    const bad = configured();
    if (bad) return fail(bad);
    try {
      const url = `${BASE}/api/fs/raw?path=${encodeURIComponent(server_path)}`;
      const res = await fetch(url, { headers: { cookie: COOKIE } });
      if (res.status === 403) {
        // 白名单拒绝要说清楚，否则模型只会看到一个 403 然后开始瞎猜。
        return fail(
          `服务器拒绝了这个路径（不在该账号的目录白名单里）：${server_path}`,
        );
      }
      if (!res.ok) {
        return fail(`下载失败：HTTP ${res.status} ${await res.text()}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(path.dirname(local_path), { recursive: true });
      await writeFile(local_path, buf);
      return text(`已取到本机：${local_path}（${buf.length} 字节）`);
    } catch (err) {
      return fail(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

await server.connect(new StdioServerTransport());
