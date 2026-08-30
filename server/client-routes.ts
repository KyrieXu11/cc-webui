// 桌面客户端安装包的下载路由（docs/desktop-client.md 决策 27）。
//
// ⚠️ **这条路由要鉴权，绝不能是公开的。** 设计文档第 236-238 行专门写死了这条：
// 客户端是**主进程带 cookie 自己下**，不是 shell.openExternal 丢给家人的默认
// 浏览器（那个浏览器很可能从没登录过 cc-webui，下载会直接 401）。
// 把它改成 public 会同时打破 AGENTS.md 的公开面清单和 auth/policy.test.ts 的
// 断言 —— 那条断言存在的意义就是让这种改动必须是显式的。
//
// ⚠️ 为什么不用 serveStatic 指向安装包目录：@hono/node-server 的 serveStatic
// 的 root **只接受相对 cwd 的路径**（serve-static.d.ts 明写 "Absolute paths are
// not supported"），而安装包在 ~/.cc-webui/client/ 下。而且再挂一个 `/*` 中间件
// 会让路由顺序和公开面都更难推理。所以自己流式返回。

import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { clientDir } from "./client-release.ts";

const route = new Hono();

route.get("/download/:file", async (c) => {
  const requested = c.req.param("file");

  // Hono 会把路径参数 decodeURIComponent 一次，所以 `%2e%2e%2f` 到这里已经是
  // `../`。basename 相等是唯一可靠的判据 —— 别用 includes("..") 那种黑名单。
  if (!requested || requested !== path.basename(requested)) {
    return c.json({ error: "bad file name" }, 400);
  }

  const dir = clientDir();
  const full = path.join(dir, requested);
  // basename 已经挡住了穿越，这一步是纵深防御：目录本身可能是个软链，
  // 而 join 不会解析它。
  if (path.dirname(full) !== dir) {
    return c.json({ error: "bad file name" }, 400);
  }

  let size: number;
  try {
    const s = await stat(full);
    if (!s.isFile()) return c.json({ error: "not found" }, 404);
    size = s.size;
  } catch {
    return c.json({ error: "not found" }, 404);
  }

  const stream = Readable.toWeb(
    createReadStream(full),
  ) as unknown as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      // 客户端是主进程自己下、自己存，但带上文件名能让手动 curl 排查时省事。
      "content-disposition": `attachment; filename="${requested}"`,
    },
  });
});

export { route as clientRoute };
