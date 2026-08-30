// 桌面客户端版本下发（docs/desktop-client.md 决策 26/28）。纯脚本风格。
//
// 钉住的两条：① 没发布 / 发布文件坏了都**不能抛**——它挂在 /api/meta 上，抛出去
// 等于整个前端起不来；② 坏 JSON 必须留一行 console.warn，否则「客户端收不到更新」
// 排查时零线索。
//
// ⚠️ 必须 await import()：静态 import 会被提升到 CC_WEBUI_CLIENT_DIR 赋值之前。
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-webui-client-"));
process.env.CC_WEBUI_CLIENT_DIR = path.join(tmp, "client");

const { clientRelease, clientDir } = await import("./client-release.ts");

// console.warn 收进数组：既能断言「有线索」，又不把 test 输出刷满。
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));

const latest = path.join(tmp, "client", "latest.json");
const write = async (body: string) => {
  await fsp.mkdir(path.dirname(latest), { recursive: true });
  await fsp.writeFile(latest, body);
};

try {
  // ── 目录路径 ───────────────────────────────────────────────────────────────

  // macOS 的 os.tmpdir() 在 /var 下，而 /var 是指向 /private/var 的软链，两边都
  // realpath 过再比。⚠️ realpath 只能作用在**存在**的路径上，而 client 目录此刻
  // 还没建（下面正要测「没发布」），所以 realpath 父目录、自己接上最后一段。
  const realDir = async (p: string) =>
    path.join(await fsp.realpath(path.dirname(p)), path.basename(p));
  assert.equal(
    await realDir(clientDir()),
    await realDir(path.join(tmp, "client")),
    "env 覆盖生效"
  );
  delete process.env.CC_WEBUI_CLIENT_DIR;
  assert.equal(
    clientDir(),
    path.join(os.homedir(), ".cc-webui", "client"),
    "缺省落在 ~/.cc-webui/client"
  );
  process.env.CC_WEBUI_CLIENT_DIR = path.join(tmp, "client");

  // ── 没发布 ────────────────────────────────────────────────────────────────

  assert.equal(clientRelease(), undefined, "目录不存在 = 还没发布，不是错误");
  // ⚠️ 别用 assert.deepEqual(warnings, [])：@types/node 里它是 `asserts actual is T`，
  // 传个 [] 进去会把 warnings 就地窄化成 never[]，后面所有 warnings[0] 都不过编译。
  assert.equal(warnings.length, 0, "没发布是正常状态，不该刷日志");

  // ── 坏 JSON / 缺字段 ──────────────────────────────────────────────────────

  await write("{ 这不是 JSON");
  assert.equal(clientRelease(), undefined, "坏 JSON 返回 undefined");
  assert.equal(warnings.length, 1, "坏 JSON 必须留一行线索");
  assert.ok(warnings[0].includes("latest.json"), "线索里要有出问题的文件路径");

  warnings.length = 0;
  await write(JSON.stringify({ file: "cc-webui-setup-1.2.0.exe" }));
  assert.equal(clientRelease(), undefined, "缺 version");
  await write(JSON.stringify({ version: "1.2.0" }));
  assert.equal(clientRelease(), undefined, "缺 file");
  await write(JSON.stringify({ version: "  ", file: "x.exe" }));
  assert.equal(clientRelease(), undefined, "version 是空白等于没有");
  await write(JSON.stringify(["1.2.0"]));
  assert.equal(clientRelease(), undefined, "顶层不是对象");
  assert.equal(warnings.length, 4, "每种缺字段都留线索");

  // file 会被拼进下发的 URL，带目录的必须挡住。
  warnings.length = 0;
  await write(JSON.stringify({ version: "1.2.0", file: "../../etc/passwd" }));
  assert.equal(clientRelease(), undefined, "file 带路径分隔符要拒");
  assert.equal(warnings.length, 1);

  // ── 正常发布 ──────────────────────────────────────────────────────────────

  warnings.length = 0;
  await write(
    JSON.stringify({
      version: "1.2.0",
      file: "cc-webui-setup-1.2.0.exe",
      notes: "修了托盘图标",
    })
  );
  assert.deepEqual(
    clientRelease(),
    {
      version: "1.2.0",
      url: "/api/client/download/cc-webui-setup-1.2.0.exe",
      notes: "修了托盘图标",
    },
    "url 由 file 拼出来，客户端自己接 base（决策 27）"
  );

  // notes 可选：没写就不该出现这个 key（客户端 dialog 靠它在与不在决定要不要显示）。
  await write(JSON.stringify({ version: "1.2.0", file: "s.exe" }));
  const noNotes = clientRelease();
  assert.deepEqual(noNotes, { version: "1.2.0", url: "/api/client/download/s.exe" });
  assert.ok(noNotes && !("notes" in noNotes), "notes 缺省时 key 不出现");
  await write(JSON.stringify({ version: "1.2.0", file: "s.exe", notes: "   " }));
  assert.ok(!("notes" in clientRelease()!), "空白 notes 等于没写");

  assert.equal(warnings.length, 0, "正常发布不该有告警");
} finally {
  console.warn = realWarn;
  delete process.env.CC_WEBUI_CLIENT_DIR;
  await fsp.rm(tmp, { recursive: true, force: true });
}

console.log("client-release.test.ts: all assertions passed");
