// 文件夹下载走真实鉴权路由；尤其防止「目录能打开」被误当成「子树全都授权」。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-download-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
await fs.writeFile(process.env.CC_WEBUI_DOTENV, "");

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser, setAllowedPaths } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { prepareDownload } = await import("./file-download.ts");
const { ZIP_MAX_ENTRY_BYTES } = await import("./zip.ts");

try {
  const mine = path.join(tmp, "mine");
  const folder = path.join(mine, "练习册");
  const nested = path.join(folder, "Unit 2");
  await fs.mkdir(path.join(nested, "空目录"), { recursive: true });
  await fs.writeFile(path.join(folder, "阅读.html"), "<h1>阅读</h1>");
  await fs.writeFile(path.join(nested, "阅读.html"), "第二份同名文件");
  const loose = path.join(mine, "说明.txt");
  await fs.writeFile(loose, "说明");
  const app = createApp();
  const alice = createUser({ username: "alice", password: "x", role: "user", allowedPaths: [mine] });
  const cookie = `${SESSION_COOKIE}=${issueSession(alice.id)}`;
  const download = (paths: string[], authenticated = true) => app.request(
    `/api/files/download?${paths.map(p => `path=${encodeURIComponent(p)}`).join("&")}`,
    { headers: authenticated ? { cookie } : {} },
  );
  const bytes = async (res: Response) => {
    assert.equal(res.status, 200, res.status === 200 ? undefined : await res.text());
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-length"), null, "流式 ZIP 不假定 stat 大小永远不变");
    return Buffer.from(await res.arrayBuffer());
  };
  const names = (zip: Buffer) => {
    const eocd = zip.length - 22;
    assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
    const result: string[] = [];
    let offset = zip.readUInt32LE(eocd + 16);
    for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
      assert.equal(zip.readUInt32LE(offset), 0x02014b50);
      const length = zip.readUInt16LE(offset + 28);
      result.push(zip.toString("utf8", offset + 46, offset + 46 + length));
      offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    return result.sort();
  };
  const expected = ["练习册/", "练习册/阅读.html", "练习册/Unit 2/", "练习册/Unit 2/阅读.html", "练习册/Unit 2/空目录/"].sort();

  // 单目录：同名 ZIP，包含顶层目录、所有深度的正文与空目录。
  const res = await download([folder]);
  assert.match(res.headers.get("content-disposition") ?? "", /filename\*=UTF-8''%E7%BB%83%E4%B9%A0%E5%86%8C\.zip/);
  const archive = await bytes(res);
  assert.deepEqual(names(archive), expected);
  let hasUnzip = true;
  try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); } catch { hasUnzip = false; }
  if (hasUnzip) {
    const zipPath = path.join(tmp, "download.zip");
    const out = path.join(tmp, "extracted");
    await fs.writeFile(zipPath, archive);
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    execFileSync("unzip", ["-q", zipPath, "-d", out]);
    assert.equal(await fs.readFile(path.join(out, "练习册", "阅读.html"), "utf8"), "<h1>阅读</h1>");
    assert.equal(await fs.readFile(path.join(out, "练习册", "Unit 2", "阅读.html"), "utf8"), "第二份同名文件");
    assert((await fs.stat(path.join(out, "练习册", "Unit 2", "空目录"))).isDirectory());
  }

  assert.deepEqual(names(await bytes(await download([loose, folder]))), [...expected, "说明.txt"].sort(), "文件和目录混选");
  for (const picks of [[nested, folder, path.join(folder, "阅读.html"), folder], [folder, nested]]) {
    assert.deepEqual(names(await bytes(await download(picks))), expected, "父子重叠与重复选择不会写出重名条目");
  }
  const empty = path.join(mine, "空的");
  await fs.mkdir(empty);
  assert.deepEqual(names(await bytes(await download([empty]))), ["空的/"], "纯空目录也能下载");
  assert.deepEqual(names(await bytes(await download([empty, folder]))), [...expected, "空的/"].sort(), "多个文件夹");
  const oneFileFolder = path.join(mine, "单文件目录");
  await fs.mkdir(oneFileFolder);
  await fs.writeFile(path.join(oneFileFolder, "only.txt"), "only");
  assert.deepEqual(names(await bytes(await download([oneFileFolder]))), ["单文件目录/", "单文件目录/only.txt"].sort());
  const plain = await download([loose]);
  assert.equal(plain.headers.get("content-type"), "application/octet-stream");
  assert.equal(await plain.text(), "说明", "单文件仍原样下");

  // 不登录不能打包；第二个选择与每个递归子项都必须授权。
  assert.equal((await download([folder], false)).status, 401);
  const outside = path.join(tmp, "secret.txt");
  await fs.writeFile(outside, "secret");
  assert.equal((await download([folder, outside])).status, 403);
  // 字面量目录本身会隐含子树，用 ? 匹配末尾一个字符来只允许根与直接子项。
  setAllowedPaths(alice.id, [`${folder.slice(0, -1)}?`, `${folder}/*`]);
  assert.equal((await download([folder])).status, 403, "不能因父目录获准就绕过孙辈 glob 白名单");
  setAllowedPaths(alice.id, [mine]);

  const links = path.join(mine, "links");
  await fs.mkdir(links);
  const link = path.join(links, "link");
  await fs.symlink(outside, link);
  assert.equal((await download([links])).status, 403, "不能通过软链读取白名单外文件");
  await fs.unlink(link);
  await fs.symlink(links, link);
  const cyclic = await download([links]);
  assert.equal(cyclic.status, 400, "目录软链循环不递归、不静默漏掉");
  assert.match((await cyclic.json()).error, /软链接/);
  await fs.unlink(link);
  await fs.symlink(folder, link);
  assert.equal((await download([links])).status, 400, "白名单内软链也明确拒绝，不越出所选目录");
  const alias = path.join(mine, "alias");
  await fs.symlink(folder, alias);
  assert.deepEqual(names(await bytes(await download([alias, folder]))), expected, "显式路径仍按 realpath 授权与去重");
  const unreadable = path.join(folder, "unreadable.txt");
  await fs.writeFile(unreadable, "not readable");
  await fs.chmod(unreadable, 0);
  try {
    if (process.getuid?.() !== 0) {
      assert.equal((await download([folder])).status, 403, "不可读文件在开始发包前拒绝，不下载半个坏包");
    }
  } finally {
    await fs.chmod(unreadable, 0o600);
  }

  // ZIP32 总大小、单文件大小都必须在发送前拒绝（稀疏文件，不写满磁盘）。
  const huge = path.join(mine, "huge");
  await fs.mkdir(huge);
  const sparse = async (name: string, size: number) => {
    const handle = await fs.open(path.join(huge, name), "w");
    try { await handle.truncate(size); } finally { await handle.close(); }
  };
  await sparse("a", ZIP_MAX_ENTRY_BYTES + 1);
  assert.equal((await download([huge])).status, 413);
  const singleLarge = await prepareDownload([path.join(huge, "a")], [mine]);
  assert.equal(singleLarge.kind, "file", "不打包的单文件不受 ZIP32 限制");
  await sparse("a", 0x80000000);
  await sparse("b", 0x80000000);
  assert.equal((await download([huge])).status, 413, "总长度不能溢出 central directory 的 32 位 offset");
  const unsafe = path.join(mine, "unsafe");
  await fs.mkdir(unsafe);
  await fs.writeFile(path.join(unsafe, "..\\escaped.txt"), "keep inside");
  assert([400, 403].includes((await download([unsafe])).status), "不能让 POSIX 文件名变成 Windows 解压路径穿越（白名单也可能先拒）");
  assert.equal((await download([path.join(mine, "missing")])).status, 404);
  assert.equal((await download([])).status, 400);
  assert.equal((await download(Array.from({ length: 101 }, (_, i) => path.join(mine, String(i))))).status, 400);
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log("Folder downloads: nested/empty/mixed ZIPs, deduplication, authorization, symlink and ZIP32 guards verified");
