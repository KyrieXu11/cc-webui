// 用户工作区 —— 系统替普通账号建的一块地。
//
// 先分清三个词，它们指的不是一回事：
//   项目   一个被打开的 cwd（决策 3）。磁盘上任何被授权的目录都可以是项目。
//   白名单 管理员给某个账号的一组 glob。
//   工作区 系统建的、和账号一起出生的**一个目录**。它同时是两样东西：
//          白名单里的一条「系统条目」，以及一个**装项目的容器**——用户可以在
//          里面自己分目录，每个都是项目（决策 21）。
//
// 工作区不是特权也不是上限：管理员照样可以额外授权别的目录。

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// 用户名会变成路径的一段，所以它需要一套文件系统和 glob 都不会二次解释的字符集。
// 只在**创建**时强制：用户名建好就不能改（没有改名接口），所以库里的值只可能
// 来自创建那一刻。
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class InvalidUsernameError extends Error {
  constructor(readonly username: string) {
    super(
      `用户名 ${JSON.stringify(username)} 不能用作目录名：只允许小写字母、数字、- 和 _，字母或数字开头，不超过 32 个字符`,
    );
    this.name = "InvalidUsernameError";
  }
}

export class WorkspaceExistsError extends Error {
  constructor(readonly dir: string) {
    super(`${dir} 已存在`);
    this.name = "WorkspaceExistsError";
  }
}

export function isUsableUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export function assertUsableUsername(username: string): void {
  if (!isUsableUsername(username)) throw new InvalidUsernameError(username);
}

// 默认挂在应用数据目录下的一层命名空间里，而不是 ~/.cc-webui/<username>：
// 后者会和 groups/ feishu/ 这些已有目录**撞名**——一个叫 groups 的账号会通过
// 白名单合法地拿到所有群聊 transcript（决策 22）。
export function workspacesRoot(): string {
  const override = process.env.CC_WEBUI_WORKSPACES_DIR?.trim();
  return override || path.join(os.homedir(), ".cc-webui", "workspaces");
}

export function workspaceDirFor(username: string): string {
  assertUsableUsername(username);
  return path.join(workspacesRoot(), username);
}

// `<dir>/**` 而不是光秃秃的 `<dir>`：工作区是容器，用户在里面自己建项目目录。
// （matchesAnyPattern 里补了「子树模式也授权它自己的根」，所以这条同时允许打开
// 工作区本身。）
export function workspacePatternFor(username: string): string {
  return path.join(workspaceDirFor(username), "**");
}

// 系统条目**按约定判定**，不在表里加列（决策 26）：判定就是一次字符串相等，
// 不会出现「库里标着 managed 但路径早就变了」这种漂移。
export function workspacePatternIn(
  username: string,
  patterns: readonly string[],
): string | null {
  if (!isUsableUsername(username)) return null;
  const want = workspacePatternFor(username);
  return patterns.includes(want) ? want : null;
}

// 建号路径专用：**不是** mkdir -p，EEXIST 正是我们要的信号——同名账号被删过又
// 重建时，新人不该默默继承前任留在磁盘上的文件（决策 25）。
export async function createWorkspace(username: string): Promise<string> {
  const dir = workspaceDirFor(username);
  await fs.mkdir(workspacesRoot(), { recursive: true });
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceExistsError(dir);
    }
    throw err;
  }
  return dir;
}

// 降级 / 补建路径专用：幂等，已经存在就用它。这里不该拒绝——目录里的东西本来
// 就是这个账号自己的。
export async function ensureWorkspace(username: string): Promise<string> {
  const dir = workspaceDirFor(username);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function workspaceExists(username: string): Promise<boolean> {
  if (!isUsableUsername(username)) return false;
  try {
    return (await fs.stat(workspaceDirFor(username))).isDirectory();
  } catch {
    return false;
  }
}

// 建号事务失败时的回滚。只删空目录：rmdir 对非空目录会失败，而刚建出来的工作区
// 一定是空的（决策 24：里面什么都不放），所以这既够用又不可能误删数据。
export async function removeEmptyWorkspace(dir: string): Promise<void> {
  await fs.rmdir(dir).catch(() => {});
}
