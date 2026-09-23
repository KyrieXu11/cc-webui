// 手写的 ZIP 打包器只有一条验收标准：**真的 unzip 能解开**。所以这个文件不去逐字节
// 断言头部布局（那只是把实现抄一遍），而是拿系统的 unzip 解一次、逐个比对内容。
//
// `unzip -t` 会校验 crc32 —— 那正是这份实现里最容易写错的一块（增量计算 + data
// descriptor），也是错了以后**在浏览器里看不出来**的一块：包能下下来，双击才报错。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

const { zipStream } = await import("./zip.ts");

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-webui-zip-"));

// 中文名 + 中文内容 + 一个子目录里的同名文件：三样都是这个仓库的日常。
const big = "行".repeat(200_000); // 跨多个 read chunk，逼出增量 crc 的错
await fsp.mkdir(path.join(tmp, "sub"), { recursive: true });
await fsp.writeFile(path.join(tmp, "报告.md"), "# 标题\n正文\n");
await fsp.writeFile(path.join(tmp, "sub", "报告.md"), big);
await fsp.writeFile(path.join(tmp, "empty.txt"), ""); // 空文件也得能打进去

const entries = [
  { path: path.join(tmp, "报告.md"), name: "报告.md", mtimeMs: Date.parse("2026-09-06T10:30:00") },
  { path: path.join(tmp, "sub", "报告.md"), name: "sub/报告.md" },
  { path: path.join(tmp, "empty.txt"), name: "empty.txt" },
];

const zip = Buffer.from(await new Response(zipStream(entries)).arrayBuffer());

// 形状先粗查一遍：magic + EOCD 里的条目数。
assert.equal(zip.subarray(0, 4).toString("hex"), "504b0304", "以 local header 开头");
assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "结尾是 EOCD");
assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 3, "EOCD 记着 3 个条目");

const zipPath = path.join(tmp, "out.zip");
await fsp.writeFile(zipPath, zip);

// ── 真 unzip ────────────────────────────────────────────────────────────────
// 没有 unzip 的机器上只跑上面那几条结构断言（别让缺个命令行工具把整个测试套弄红）。
let hasUnzip = true;
try {
  execFileSync("unzip", ["-v"], { stdio: "ignore" });
} catch {
  hasUnzip = false;
}

if (hasUnzip) {
  // -t = 逐条校验 crc32。写错了这里就红。
  const test = execFileSync("unzip", ["-t", zipPath], { encoding: "utf-8" });
  assert.match(test, /No errors detected in compressed data/);

  const out = path.join(tmp, "out");
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", out]);
  assert.equal(await fsp.readFile(path.join(out, "报告.md"), "utf8"), "# 标题\n正文\n");
  assert.equal(
    await fsp.readFile(path.join(out, "sub", "报告.md"), "utf8"),
    big,
    "子目录里的同名文件各是各的（包里的名字带相对路径，不会互相盖）"
  );
  assert.equal((await fsp.stat(path.join(out, "empty.txt"))).size, 0);
} else {
  console.log("zip.test.ts: 没装 unzip，跳过解包验证");
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log("zip.test.ts: all assertions passed");
