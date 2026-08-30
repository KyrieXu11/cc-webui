// 本地 MCP server 的宿主：按服务端下发的配置 spawn 子进程，用 stdio 跟它们说
// JSON-RPC，再把应答送回去。
//
// 这是「任何能力外挂」（决策 3）真正落地的地方 —— 加一个能力 = 服务端配置表里
// 多一行，这里不用改一个字。
//
// ⚠️ MCP 的 stdio transport 就是**换行分隔的 JSON-RPC**，没有别的框架。写：
// `JSON.stringify(msg) + "\n"` 进 stdin；读：把 stdout 按 \n 切开逐条 parse。
// 子进程的 stderr **必须**转出来（不是丢掉）：MCP server 启动失败时唯一的线索
// 就在那里，而它此刻跑在家人的电脑上、你看不到。
//
// ⚠️ 这个文件**不 import electron**，纯 Node。理由是它要能在没有 Electron 的
// 情况下被测（tsx 直接跑），而 Electron 的整个测试环境不值得为它搭。
// 唯一和 Electron 相关的东西是 `command` 缺省时用哪个可执行文件 —— 那个由调用
// 方通过 `defaultCommand` 注入（决策 23：ELECTRON_RUN_AS_NODE=1 借 Electron 自带
// 的 Node，家人机器上零依赖）。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LocalMcpServerSpec } from "../../server/devices/protocol.ts";

export type HostOptions = {
  /**
   * spec.command 为空时用它。生产上是 Electron 自己的可执行文件 + 内置的
   * MCP server 脚本（配 ELECTRON_RUN_AS_NODE=1），测试里可以是 "node"。
   */
  defaultCommand: string;
  defaultEnv?: Record<string, string>;
  /** 收到子进程发来的一帧 JSON-RPC。宿主自己不解释内容，原样上抛。 */
  onMessage: (server: string, payload: unknown) => void;
  /** 子进程意外退出。上层据此把这个 server 标成不可用。 */
  onExit: (server: string, code: number | null, signal: string | null) => void;
};

type Child = {
  name: string;
  proc: ChildProcessWithoutNullStreams;
  /** stdout 的半行缓冲。一帧 JSON 可能跨多次 data 事件到达。 */
  buf: string;
};

export class McpHost {
  private children = new Map<string, Child>();

  constructor(private opts: HostOptions) {}

  /**
   * 按新配置重建所有子进程。
   *
   * 全量重启而不是 diff：配置下发只在连上服务端时发生一次（见 ws-client），
   * 一年也没几回，而 diff 的边界情况（同名不同参、启动中被替换）足够写出真 bug。
   */
  async apply(
    specs: LocalMcpServerSpec[],
  ): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    await this.stopAll();
    const out: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const spec of specs) {
      try {
        this.start(spec);
        out.push({ name: spec.name, ok: true });
      } catch (err) {
        out.push({
          name: spec.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  private start(spec: LocalMcpServerSpec): void {
    const command = spec.command?.trim() || this.opts.defaultCommand;
    const proc = spawn(command, spec.args ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...this.opts.defaultEnv, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      // ⚠️ Windows 上 `npx` 实际是 `npx.cmd`，不带 shell 的 spawn 直接找不到。
      // 这是经典坑，但**不能**无脑开 shell:true —— 那会让 args 里的空格和引号
      // 被 cmd.exe 重新解释一遍。只在命令看起来需要 shell 时才开。
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    }) as ChildProcessWithoutNullStreams;

    const child: Child = { name: spec.name, proc, buf: "" };
    this.children.set(spec.name, child);

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(child, chunk));

    // 转出来，别丢。见文件头。
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console.warn(`[mcp:${spec.name}] ${line}`);
      }
    });

    proc.on("error", (err) => {
      console.error(`[mcp:${spec.name}] spawn failed:`, err.message);
      this.children.delete(spec.name);
      this.opts.onExit(spec.name, null, null);
    });
    proc.on("exit", (code, signal) => {
      this.children.delete(spec.name);
      this.opts.onExit(spec.name, code, signal);
    });
  }

  private onStdout(child: Child, chunk: string): void {
    child.buf += chunk;
    // 最后一段可能是半行，留在缓冲里等下一次 data。
    const lines = child.buf.split("\n");
    child.buf = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      try {
        this.opts.onMessage(child.name, JSON.parse(text));
      } catch {
        // 不是 JSON 的行多半是 server 把日志写到了 stdout（常见错误）。
        // 丢掉会让人完全查不到，所以当日志转出来。
        console.warn(`[mcp:${child.name}] non-JSON on stdout: ${text.slice(0, 200)}`);
      }
    }
  }

  /** 名字对应的 server 是否活着。 */
  has(name: string): boolean {
    return this.children.has(name);
  }

  names(): string[] {
    return [...this.children.keys()];
  }

  /** 往某个 server 写一帧。server 不存在时抛 —— 上层要把它翻译成 rpc-error。 */
  send(name: string, payload: unknown): void {
    const child = this.children.get(name);
    if (!child) throw new Error(`local MCP server "${name}" is not running`);
    child.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  async stopAll(): Promise<void> {
    const all = [...this.children.values()];
    this.children.clear();
    await Promise.all(
      all.map(
        (c) =>
          new Promise<void>((resolve) => {
            if (c.proc.exitCode !== null || c.proc.signalCode !== null) {
              resolve();
              return;
            }
            // 给一点时间体面退出，然后 SIGKILL。playwright 那类 server 会
            // 拖着一个浏览器进程，不 kill 干净的话家人的任务管理器里会积一堆。
            const hard = setTimeout(() => {
              c.proc.kill("SIGKILL");
              resolve();
            }, 2000);
            hard.unref?.();
            c.proc.once("exit", () => {
              clearTimeout(hard);
              resolve();
            });
            c.proc.kill();
          }),
      ),
    );
  }
}
