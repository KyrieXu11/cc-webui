// Electron 主进程。这个 app 的价值**全在这里** —— 渲染层只是个壳，直接开远端
// 的 cc-webui 页面（决策 12），前端永远和服务端同版本，app 本身几个月不用动。
//
// ⚠️⚠️ **渲染进程加载的是远端页面，而主进程握着「在本机 spawn 任意进程」的能力。**
// 所以 `nodeIntegration: false` + `contextIsolation: true` 不是洁癖：这个 app 的
// 字面能力就是「远程指令 → 本机执行」，渲染层一旦有 node，任何一次前端 XSS 就是 RCE。
// 本文件**不给渲染进程任何 IPC**，一个 preload 都没有 —— 需要什么再单独加，
// 每加一个都要问一遍「这个能力被 XSS 拿到会怎样」。
//
// ⚠️ 托盘常驻、关窗口不退出（决策 15）：WS 要一直连着，开机自启才有意义。

import { app, BrowserWindow, dialog, Menu, session, shell, Tray } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { McpHost } from "./mcp-host.ts";
import { DeviceClient, type ConnStatus } from "./ws-client.ts";
import { browserProfileDir, loadConfig, saveConfig } from "./config.ts";
import { fetchRelease, isNewer, type Release } from "./updater.ts";
import { SESSION_COOKIE_NAME } from "../../server/devices/protocol.ts";

const cfg = loadConfig(app.getPath("userData"));
const version = app.getVersion();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let status: ConnStatus = { state: "connecting" };
let quitting = false;

// ── cookie ───────────────────────────────────────────────────────────────────
// 决策 14：登录只有一处（渲染进程里那个远端页面），主进程从 session 里读它拿到的
// cookie 来开 WS。
// ⚠️ cookie 是 HttpOnly，渲染进程的 JS **永远读不到**它 —— 想通过 preload IPC
// 把它传上来那条路是不通的，别浪费时间。只有主进程的 cookies API 拿得到。
let cookie: string | undefined;

async function refreshCookie(): Promise<void> {
  try {
    const all = await session.defaultSession.cookies.get({
      name: SESSION_COOKIE_NAME,
    });
    const c = all[0];
    cookie = c ? `${c.name}=${c.value}` : undefined;
  } catch {
    cookie = undefined;
  }
}

/**
 * 内置 MCP server 的真实磁盘路径（决策 23）。
 *
 * ⚠️ 两个坑叠在一起，都只在**打包之后**才出现，开发时跑 `electron .` 一切正常：
 *
 * 1. esbuild 输出到 `dist/servers/`，不是 `servers/` —— 少写一层就是文件不存在。
 * 2. 打包后 `app.getAppPath()` 指向 `.../app.asar`，而 asar 是个归档：主进程
 *    读它里面的文件是透明的，但 **spawn 出去的子进程拿到的是一个不存在的路径**。
 *    所以 package.json 的 build.asarUnpack 把 `dist/servers/**` 解包出来，
 *    真实路径在 `app.asar.unpacked/` 下，必须自己替换这一段。
 *
 * 症状会是：家人机器上 transfer 工具永远启动失败，而 stderr 里只有一句
 * ENOENT —— 从那句话反推到「asar 归档里的路径 spawn 不了」并不显然。
 */
function bundledServersDir(): string {
  return path.join(
    app.getAppPath().replace(/app\.asar(?=$|[\\/])/, "app.asar.unpacked"),
    "dist",
    "servers",
  );
}

// ── 本地 MCP 宿主 + 连接 ─────────────────────────────────────────────────────
const host = new McpHost({
  // 决策 23：借 Electron 自带的 Node 跑打包进来的 MCP server，家人机器零依赖。
  // 服务端下发的 spec 里写了 command 就用它（npx 逃生口）。
  defaultCommand: process.execPath,
  bundledDir: bundledServersDir(),
  defaultEnv: () => ({
    ELECTRON_RUN_AS_NODE: "1",
    // 决策 24：浏览器 MCP server 用专属持久 profile，不碰家人日常那个。
    CC_WEBUI_BROWSER_PROFILE: browserProfileDir(app.getPath("userData")),
    // 传输 server（决策 18）要以这个人的身份访问 cc-webui。**每次 spawn 现取** ——
    // 见 HostOptions.defaultEnv 的注释。
    CC_WEBUI_URL: cfg.serverUrl,
    CC_WEBUI_COOKIE: cookie ?? "",
  }),
  onMessage: (server, payload) => client.handleServerMessage(server, payload),
  onExit: (server) => client.handleServerExit(server),
});

const client = new DeviceClient({
  baseUrl: cfg.serverUrl,
  cookie: () => cookie,
  deviceId: cfg.deviceId,
  label: cfg.label,
  clientVersion: version,
  host,
  onStatus: (s) => {
    status = s;
    renderTray();
  },
});

// ── 托盘（决策 8 / 15 / 25 的落点）───────────────────────────────────────────
function statusLine(): string {
  switch (status.state) {
    case "connecting":
      return "连接中…";
    case "connected":
      return `已连接（${status.username}）`;
    case "disconnected":
      return `未连接：${status.reason}`;
  }
}

function renderTray(): void {
  if (!tray) return;
  tray.setToolTip(`cc-webui — ${statusLine()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLine(), enabled: false },
      { type: "separator" },
      {
        // 决策 8：这是决策 6+7 之后**唯一**的在场控制 —— 给机器主人一个物理闸。
        label: "⏸ 暂停本机工具",
        type: "checkbox",
        checked: client.isPaused(),
        click: (item) => {
          client.setPaused(item.checked);
          renderTray();
        },
      },
      {
        label: "开机自启",
        type: "checkbox",
        checked: cfg.autoLaunch,
        click: (item) => {
          cfg.autoLaunch = item.checked;
          saveConfig(app.getPath("userData"), cfg);
          app.setLoginItemSettings({ openAtLogin: item.checked });
        },
      },
      { type: "separator" },
      { label: "检查更新…", click: () => void checkUpdate(true) },
      { label: "打开 cc-webui", click: () => showWindow() },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ── 更新（决策 27/28）────────────────────────────────────────────────────────
async function checkUpdate(manual: boolean): Promise<void> {
  await refreshCookie();
  const release = await fetchRelease(cfg.serverUrl, cookie);
  if (!release || !isNewer(release, version)) {
    // 手点的时候要给回应，自动查的时候安静 —— 每次开机弹「已是最新」是骚扰。
    if (manual) {
      await dialog.showMessageBox({
        type: "info",
        message: release ? "已经是最新版本" : "服务端还没有发布客户端",
        detail: `当前版本 ${version}`,
      });
    }
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: `发现新版本 ${release.version}`,
    detail: (release.notes ? release.notes + "\n\n" : "") +
      `当前 ${version}。\n\n⚠️ 安装前请先从托盘「退出」—— 这个程序关掉窗口后仍在托盘里运行，` +
      `安装程序检测到它还在跑就装不下去。`,
    buttons: ["下载并安装", "以后再说"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  await downloadAndRun(release);
}

async function downloadAndRun(release: Release): Promise<void> {
  try {
    // 决策 27：带 cookie 自己下。**不要** shell.openExternal —— 家人的默认浏览器
    // 多半没登录过 cc-webui，那条路只会拿到 401。
    const res = await fetch(cfg.serverUrl + release.url, {
      headers: cookie ? { cookie } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const target = path.join(
      app.getPath("temp"),
      path.basename(release.url) || `cc-webui-setup-${release.version}.exe`,
    );
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
    // 先自己退出再拉起安装程序：NSIS 会检测到旧进程并要求关闭，而这个 app 是
    // 关窗口不退出的托盘常驻，家人很容易以为「我已经关了」。
    quitting = true;
    await shell.openPath(target);
    app.quit();
  } catch (err) {
    await dialog.showMessageBox({
      type: "error",
      message: "下载失败",
      detail: (err as Error).message,
    });
  }
}

// ── 窗口 ─────────────────────────────────────────────────────────────────────
function showWindow(): void {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "cc-webui",
    webPreferences: {
      // 见文件头。这两行是这个 app 唯一挡在「远端页面」和「本机 spawn」之间的东西。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  void win.loadURL(cfg.serverUrl);
  win.on("close", (e) => {
    // 决策 15：关窗口不退出。WS 要一直连着。
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
// 单实例：第二次双击图标应当唤出已有窗口，而不是再连一条 WS —— 服务端那侧
// 「一账号一设备」会拒掉第二条，表现成一个莫名其妙的失败。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  void app.whenReady().then(async () => {
    app.setLoginItemSettings({ openAtLogin: cfg.autoLaunch });

    tray = new Tray(path.join(app.getAppPath(), "assets", "tray.png"));
    renderTray();
    tray.on("click", () => showWindow());

    showWindow();
    await refreshCookie();
    client.start();

    // 登录状态可能在窗口里发生变化（首次登录、登出、cookie 过期），
    // 所以定期重取一次。轻量到可以忽略，比给渲染进程开 IPC 安全得多。
    setInterval(() => void refreshCookie(), 60_000).unref?.();

    // 决策 28：启动时自动查一次版本。只靠手点等于没提示。
    void checkUpdate(false);
  });

  // 关掉所有窗口不退出（决策 15：托盘常驻，WS 要一直连着）。
  // ⚠️ 这里**没有** preventDefault —— Electron 的语义是「只要有人订阅了
  // window-all-closed，默认的退出行为就不发生」。空函数体是对的，别为了看起来
  // 「做了点什么」而往里塞 e.preventDefault()：那个事件根本没有这个方法。
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    quitting = true;
    client.stop();
    void host.stopAll();
  });
}
