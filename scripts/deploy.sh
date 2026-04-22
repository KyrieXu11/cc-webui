#!/usr/bin/env bash
# cc-webui 幂等部署脚本。
#
# 环境变量：
#   PROJECT_DIR     必填。项目绝对路径；目录不存在会自动 clone
#   PORT            可选。服务端口，默认 8787
#   PORT_CONFLICT   可选。端口被占时的策略：kill | abort。默认 kill
#                     kill  - 杀掉占用 $PORT 的进程
#                     abort - 直接退出，让用户自己处理
#
# 退出码：
#   0 表示服务就绪；非 0 表示失败（原因输出到 stderr）。

set -e

PROJECT_DIR="${PROJECT_DIR:?PROJECT_DIR required}"
PORT="${PORT:-8787}"
PORT_CONFLICT="${PORT_CONFLICT:-kill}"

REPO_HTTPS="https://github.com/KyrieXu11/cc-webui.git"
REPO_SSH="git@github.com:KyrieXu11/cc-webui.git"
LOG="/tmp/cc-webui.log"

log()  { echo "[cc-webui] $*"; }
fail() { echo "[cc-webui] ERROR: $*" >&2; exit 1; }

# 1. clone（按需）
if [ ! -d "$PROJECT_DIR/.git" ]; then
  log "cloning into $PROJECT_DIR"
  mkdir -p "$(dirname "$PROJECT_DIR")"
  git clone "$REPO_HTTPS" "$PROJECT_DIR" 2>/dev/null \
    || git clone "$REPO_SSH" "$PROJECT_DIR" \
    || fail "clone failed (HTTPS and SSH both)"
fi
cd "$PROJECT_DIR"

# 2. 校验前置
command -v node >/dev/null || fail "Node.js not installed"
node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[ "$node_major" -ge 20 ] || fail "Node 20+ required (got $(node --version))"
command -v claude >/dev/null || \
  fail "claude CLI not found; install + login first"
claude --version >/dev/null 2>&1 || \
  fail "claude CLI not logged in; run 'claude' interactively"

# 3. 依赖
if [ ! -d node_modules ]; then
  log "installing dependencies"
  npm ci
fi

# 4. 端口冲突处理
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  case "$PORT_CONFLICT" in
    kill)
      log "killing existing process on :$PORT"
      lsof -ti ":$PORT" | xargs kill -9 2>/dev/null || true
      sleep 1
      ;;
    abort)
      fail "port $PORT busy; retry with another PORT or PORT_CONFLICT=kill"
      ;;
    *)
      fail "unknown PORT_CONFLICT=$PORT_CONFLICT (expected kill|abort)"
      ;;
  esac
fi

# 5. 后台启动，日志落 /tmp/cc-webui.log
log "starting server on :$PORT (log: $LOG)"
PORT="$PORT" nohup npm start >"$LOG" 2>&1 &
disown $! 2>/dev/null || true

# 6. 等待就绪（最多 15 秒）
log "waiting for readiness"
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    log "ready at http://localhost:$PORT"
    exit 0
  fi
  sleep 0.5
done
fail "server did not become ready within 15s; tail $LOG for details"
