// 取件台的读侧：列出「本对话文件」。设计见 docs/file-manager.md。
//
// 两道过滤，缺一不可：
//   ① 会话归属（visibilityFor）—— 不然任何账号换个 sessionId 就能列出别人的产出。
//      policy 表里声明成 handlerScoped，因为这层收窄在处理器里做。
//   ② 路径白名单 —— agent 有完整 shell，它可能往 /tmp、~/Downloads、别人的
//      工作区里写；registry 照实记下了，但列表里**直接过滤掉**当前账号碰不了的
//      路径（决策 6）。既省掉「列了个点不开的东西」的困惑，也不把「agent 写到
//      哪儿了」漏给别的账号。

import { Hono } from "hono";
import path from "node:path";
import { currentUser } from "./auth/middleware.ts";
import { visibilityFor } from "./auth/scope.ts";
import { getAllowedPaths } from "./auth/users.ts";
import { assertCanOpen } from "./auth/paths.ts";
import { listSessionFiles } from "./session-files.ts";

const filesRoute = new Hono();

export type FileRow = {
  path: string;
  name: string;
  dir: string;
  size: number;
  mtimeMs: number;
  firstSeenMs: number;
};

filesRoute.get("/", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ files: [] });

  const user = currentUser(c)!;
  if (!visibilityFor(user)(sessionId)) {
    // 不是 403：会话存在与否本身就不该泄漏。空列表和"没有这条会话"长得一样。
    return c.json({ files: [] });
  }

  const patterns = getAllowedPaths(user.id);
  const rows = listSessionFiles(sessionId);
  const files: FileRow[] = [];
  for (const r of rows) {
    try {
      await assertCanOpen(r.path, patterns);
    } catch {
      continue;
    }
    files.push({
      path: r.path,
      name: path.basename(r.path),
      dir: path.dirname(r.path),
      size: r.size,
      mtimeMs: r.mtimeMs,
      firstSeenMs: r.firstSeenMs,
    });
  }
  return c.json({ files });
});

export { filesRoute };
