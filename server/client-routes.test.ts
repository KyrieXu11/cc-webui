// 桌面客户端安装包下载路由的路径护栏（docs/desktop-client.md 决策 27）。
//
// ⚠️ **这里测的是处理器自己的收窄，鉴权那一半一行都没跑。** 下面的 app 只
// mount 了 clientRoute，没有 authMiddleware —— 就像 files-routes.test.ts 用假
// 身份中间件顶替 authMiddleware 时那样，policy 表声明的检查根本没跑。
// 另一半（`GET /api/client/download/:file` 是 auth:"user"、**不在**公开面清单
// 里）由 server/auth/policy.test.ts 断言。两半都测才算覆盖：只看这里会以为
// 「这条路由谁都能下」，只看 policy 会以为「登录了就能下任意路径」。
//
// ⚠️ clientRoute 必须**动态** import。clientDir() 今天是在函数体里读 env 的
// （client-release.ts 顶部写了为什么），但哪天有人把它提到模块顶层，静态
// import 会被提升到 process.env.CC_WEBUI_CLIENT_DIR 赋值之前 —— 于是这个测试
// 静默地去翻开发者真实的 ~/.cc-webui/client/，而且不报错。
// 这条路由不碰 DB / 不建用户，所以 CC_WEBUI_DB、CC_WEBUI_WORKSPACES_DIR 都不需要。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";

// ⚠️ realpath：macOS 上 os.tmpdir() 在 /var 下，而 /var 是指向 /private/var 的
// 软链。不解开的话下面 dirname 相关的推理和真实路径对不上。
// mkdtemp（不是时间戳后缀）：这个仓库的测试文件是并行跑的。
const tmp = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-client-route-")),
);
const clientDir = path.join(tmp, "client");
await fs.mkdir(clientDir);

// 哨兵放在**安装包目录的父目录**里：穿越一层就够得着。只断言状态码证明不了
// 「没读到目录外的东西」—— 一个把 400 改成 200 但仍然回 404 文案的实现照样能
// 骗过状态码断言。所以每次拒绝都要正面验一遍「响应体里没有它」。
const SENTINEL = "SENTINEL-outside-the-client-dir";
await fs.writeFile(path.join(tmp, "secret.txt"), SENTINEL);

const INSTALLER = "cc-webui-setup-1.2.0.exe";
// 纯 ASCII：content-length 是磁盘字节数，不是 JS 字符串长度，掺非 ASCII 会让
// 断言看起来在测编码问题。
const INSTALLER_BODY = "MZ-fake-installer-bytes\n";
await fs.writeFile(path.join(clientDir, INSTALLER), INSTALLER_BODY);
await fs.mkdir(path.join(clientDir, "subdir"));

process.env.CC_WEBUI_CLIENT_DIR = clientDir;

const { clientRoute } = await import("./client-routes.ts");

try {
  // 挂载点与 server/app.ts 一致，这样测试里的 URL 就是线上的 URL。
  const app = new Hono();
  app.route("/api/client", clientRoute);

  // ⚠️ 用真实 URL 发请求，不要直接把解码后的串塞进去。Hono 会把路径参数
  // decodeURIComponent 一次，所以 `%2e%2e%2f` 到处理器里已经是 `../` —— 只有
  // 走真 URL 才测得到这一跳。
  const get = (url: string) => app.request(url);

  // ── ① 正常下载 ────────────────────────────────────────────────────────────

  const ok = await get(`/api/client/download/${INSTALLER}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/octet-stream");
  assert.equal(
    ok.headers.get("content-length"),
    String(Buffer.byteLength(INSTALLER_BODY)),
    "content-length 来自 stat().size；客户端主进程按它显示进度",
  );
  assert.equal(
    ok.headers.get("content-disposition"),
    `attachment; filename="${INSTALLER}"`,
  );
  assert.equal(await ok.text(), INSTALLER_BODY);

  // 名字里有空格的安装包（URL 里就是 %20）：这条钉的是「判据是 basename 相等，
  // 不是某条白名单正则」。换成正则很容易把合法名字一起挡掉，而挡掉之后的症状是
  // 家人点「下载并安装」什么都没发生。
  const spaced = "cc webui setup.exe";
  await fs.writeFile(path.join(clientDir, spaced), "spaced");
  const sp = await get(`/api/client/download/${encodeURIComponent(spaced)}`);
  assert.equal(sp.status, 200);
  assert.equal(
    sp.headers.get("content-disposition"),
    `attachment; filename="${spaced}"`,
  );
  assert.equal(await sp.text(), "spaced");

  // ── ② 不存在 → 404 ────────────────────────────────────────────────────────

  const missing = await get("/api/client/download/cc-webui-setup-9.9.9.exe");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "not found");

  // ── ③ 目标是目录 → 404 ────────────────────────────────────────────────────
  // stat 成功 ≠ 可以下。少了 isFile() 那一行的话，createReadStream 一个目录会在
  // 响应头已经发出去之后才 EISDIR，客户端拿到的是一个 200 的半截流。
  const asDir = await get("/api/client/download/subdir");
  assert.equal(asDir.status, 404);
  assert.equal((await asDir.json()).error, "not found");

  // ── ④ 路径穿越 ────────────────────────────────────────────────────────────
  //
  // ⚠️ 「谁拒的」这一列不是装饰：
  //   router  = 请求**根本没进处理器**。要么 WHATWG URL 解析器在
  //             `new Request()` 里就把 `..` 段消掉了（node-server 那边也是
  //             `new URL(...)`，行为一致），要么 `:file` 匹配不了多段路径。
  //   handler = 编码形式绕过了 URL 归一化，是处理器的 basename 判据挡住的。
  // 只有 handler 那几行在测实现；router 那几行钉的是「这些形式确实到不了处理
  // 器」。哪天前面加了个不做归一化的代理、或 Hono 换了 getPath，它们会变成
  // handler 行 —— 那时是护栏在兜底，但也说明这张表要重新想一遍。
  const traversal: { label: string; url: string; status: number; by: string }[] = [
    { label: "裸 ../..", url: "/api/client/download/../../etc/passwd", status: 404, by: "router" },
    { label: "裸 ../哨兵", url: "/api/client/download/../secret.txt", status: 404, by: "router" },
    // 这三条是真到得了处理器的形式，别删。
    { label: "%2e%2e%2f 哨兵", url: "/api/client/download/%2e%2e%2fsecret.txt", status: 400, by: "handler" },
    { label: "%2e%2e%2f 两层", url: "/api/client/download/%2e%2e%2f%2e%2e%2fetc%2fpasswd", status: 400, by: "handler" },
    { label: "编码绝对路径", url: "/api/client/download/%2Fetc%2Fpasswd", status: 400, by: "handler" },
    { label: "子路径 a/b", url: "/api/client/download/a/b", status: 404, by: "router" },
    { label: "裸绝对路径", url: "/api/client/download//etc/passwd", status: 404, by: "router" },
    { label: "空文件名", url: "/api/client/download/", status: 404, by: "router" },
  ];

  for (const { label, url, status, by } of traversal) {
    const res = await get(url);
    assert.equal(res.status, status, `${label}（应由 ${by} 拒掉）`);
    assert.notEqual(
      res.headers.get("content-type"),
      "application/octet-stream",
      `${label}：一个字节的文件流都不该有`,
    );
    // 正面验证：拒绝的语义是「读不到目录外的内容」，不是「回了个错误码」。
    const body = await res.text();
    assert.equal(body.includes(SENTINEL), false, `${label}：泄漏了哨兵文件`);
  }

  // 这一条单独钉住 basename 那道判据 —— 也是唯一能把两道判据区分开的输入：
  // "sub/../<安装包>" 被 path.join 归一化回目录内，所以 dirname 那道**放行**，
  // 只有 basename 相等挡得住。删掉它测试才会红。为什么不该放行：这条路由的单位
  // 是文件名不是路径，同一个安装包不该有第二种拼法（下发的 URL 只有一种）。
  const oddSpelling = await get(`/api/client/download/sub%2f%2e%2e%2f${INSTALLER}`);
  assert.equal(oddSpelling.status, 400);
  assert.equal((await oddSpelling.json()).error, "bad file name");
  assert.notEqual(oddSpelling.headers.get("content-type"), "application/octet-stream");

  // ── ⑤ 文件名就是 "." 或 ".." → 400 ────────────────────────────────────────
  //
  // 这两个值 basename 相等（basename(".") === "."），第一道判据放行，挡住它们的
  // 是 `path.dirname(full) !== dir` 那道纵深防御 —— 删掉那几行，"." 会去
  // createReadStream 一个目录，".." 会指到安装包目录的父目录。所以必须单独钉。
  //
  // ⚠️ 但这两个值**没法用普通 URL 送进来**：WHATWG URL 解析器会消掉
  // single-dot / double-dot 路径段，而且它认的是「.」「..」「%2e」「%2e%2e」
  // 「.%2e」「%2e.」这一整族（大小写不敏感），所以连 %2e 编码都绕不过去
  // （实测：/download/. 和 /download/%2e 都变成 /download/ → 404）。
  // 于是这里手工造一个 url 没被归一化的 Request —— 模拟的是「前面挂了个不做
  // 归一化的中间件/代理」，不是为了钻测试框架的空子。
  const rawGet = (rawPath: string) => {
    const req = new Request("http://localhost/api/client/download/placeholder");
    // Hono 的 getPath 是直接对 request.url 做字符串切片的，实例上的自有属性
    // 会盖掉原型上的 getter。
    Object.defineProperty(req, "url", {
      value: `http://localhost${rawPath}`,
      configurable: true,
    });
    return app.request(req);
  };

  for (const name of [".", ".."]) {
    const res = await rawGet(`/api/client/download/${name}`);
    assert.equal(res.status, 400, `文件名 "${name}" 必须被判 bad file name`);
    assert.equal((await res.json()).error, "bad file name");
  }

  // 顺带钉住上面那段解释：走正常 URL 时，这四种形式在路由层就没了。
  for (const encoded of [".", "..", "%2e", "%2e%2e"]) {
    const res = await get(`/api/client/download/${encoded}`);
    assert.equal(res.status, 404, `URL 归一化应吃掉 "${encoded}"，压根到不了处理器`);
    assert.equal((await res.text()).includes(SENTINEL), false);
  }

  // 没被归一化的多段路径同样进不来（`:file` 只匹配单段）。
  const rawDeep = await rawGet("/api/client/download/../secret.txt");
  assert.equal(rawDeep.status, 404);
  assert.equal((await rawDeep.text()).includes(SENTINEL), false);

  // ── ⑥ 目录不存在 → 404，不抛 ──────────────────────────────────────────────
  // 「还没发布过客户端」是正常状态（client-release.ts 同款约定）：家人的服务端
  // 不该因为一个还没发布的客户端而 500。clientDir() 每次调用都读 env，所以这里
  // 直接改环境变量就够，不用重新 import。
  process.env.CC_WEBUI_CLIENT_DIR = path.join(tmp, "no-such-dir");
  const noDir = await get(`/api/client/download/${INSTALLER}`);
  assert.equal(noDir.status, 404);
  assert.equal((await noDir.json()).error, "not found");
  // 目录不存在时穿越尝试也不该变成别的行为。
  const noDirEscape = await get("/api/client/download/%2e%2e%2fsecret.txt");
  assert.equal(noDirEscape.status, 400);
  assert.equal((await noDirEscape.text()).includes(SENTINEL), false);
  process.env.CC_WEBUI_CLIENT_DIR = clientDir;

  // stat 对含 NUL 的路径是**同步**抛 ERR_INVALID_ARG_VALUE（不是 errno 异常），
  // 但它在 try 里，所以照样收敛成 404 而不是 500。
  const nul = await get("/api/client/download/%00");
  assert.equal(nul.status, 404);

  console.log("client-routes.test.ts: all assertions passed");
} finally {
  delete process.env.CC_WEBUI_CLIENT_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
}
