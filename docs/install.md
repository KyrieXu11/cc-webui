# cc-webui 安装指南

> 这一篇写给 **LLM agent** 读；人类看 README 里的"For Humans"一段、把提示词贴给
> agent 就行。

## Agent 角色：按步骤执行

### Step 1 — 问用户两件事

用 `AskUserQuestion` 或等价交互工具询问（**不要凭猜测选值**）：

1. **项目目录** 三选一：
   - A. 已经 clone 到本地，请提供绝对路径
   - B. 帮我 clone，目标绝对路径是？
   - C. 用当前 shell 的 `pwd`

2. **端口 `8787` 被占时怎么办**：
   - `kill` — 杀掉占用的进程再启动（默认）
   - `port` — 换端口（接着问 PORT 值）
   - `abort` — 不启动，让我自己处理

拿到答案后设置三个 shell 变量：`PROJECT_DIR` / `PORT` / `PORT_CONFLICT`。

### Step 2 — 跑脚本

仓库里有现成的幂等部署脚本 `scripts/deploy.sh`。取两种方式之一：

**方式 A：仓库已 clone**
```bash
PROJECT_DIR="<用户给的路径>" \
PORT="${PORT:-8787}" \
PORT_CONFLICT="${PORT_CONFLICT:-kill}" \
bash "$PROJECT_DIR/scripts/deploy.sh"
```

**方式 B：仓库还没 clone（脚本会自己 clone）**
```bash
curl -fsSL https://raw.githubusercontent.com/KyrieXu11/cc-webui/main/scripts/deploy.sh \
  -o /tmp/cc-webui-deploy.sh
chmod +x /tmp/cc-webui-deploy.sh
PROJECT_DIR="<用户给的路径>" \
PORT="${PORT:-8787}" \
PORT_CONFLICT="${PORT_CONFLICT:-kill}" \
/tmp/cc-webui-deploy.sh
```

脚本做的事（每一步都幂等、可重跑）：
1. 目录不存在就 `git clone`（先试 HTTPS 再试 SSH）
2. 校验 Node 20+ 和 `claude --version`
3. 缺 `node_modules` 就 `npm ci`
4. 占端口按 `PORT_CONFLICT` 策略处理
5. `nohup npm start`，日志写到 `/tmp/cc-webui.log`
6. 轮询 `http://localhost:$PORT/` 最多 15 秒等就绪

### Step 3 — 向用户反馈

脚本退出码 **0 = 就绪**。向用户明确返回：

- 服务状态（HTTP 200）+ 访问 URL `http://localhost:$PORT`
- **远程会话提示**（如果检测到在 SSH 里）：
  - SSH 端口转发：`ssh -L $PORT:127.0.0.1:$PORT user@host`
  - 或建议 Tailscale 之类的 mesh VPN
- **失败时**读 `/tmp/cc-webui.log` 最后 30 行给用户，常见原因：
  - `claude CLI not logged in` — 让用户在终端手动跑一次 `claude`
  - `port busy` — 换端口重试
  - `clone failed` — 检查 git 凭据

### 停止服务

```bash
lsof -ti ":$PORT" | xargs kill -9
```

---

## 环境变量参考

`scripts/deploy.sh` 只读下面这几个：

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `PROJECT_DIR` | 是 | — | 项目绝对路径；目录不存在会 `git clone` |
| `PORT` | 否 | `8787` | 服务端口 |
| `PORT_CONFLICT` | 否 | `kill` | 端口被占时策略：`kill` / `abort` |

cc-webui 本身启动后还接这些运行时变量（README 里有表）：`CC_WEBUI_CWD`、`CC_WEBUI_UPLOAD_DIR`、`CC_WEBUI_PERMISSION_TIMEOUT_MS`。
