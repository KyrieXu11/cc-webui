# CLAUDE.md

本仓库的架构、上手方式、约定、已知问题**统一维护在 [AGENTS.md](./AGENTS.md)**——先读它。
（下面的 `@AGENTS.md` 会把内容导入到 Claude Code 会话上下文。）

@AGENTS.md

## 最重要的几条（详见 AGENTS.md）

- 提交前跑 `npm run typecheck` 和 `npm test`（后者是 `tsx --test "server/**/*.test.ts"`）。
- **两套 Bash MCP**：单聊 Claude 用进程内 `server/bash-mcp.ts`；Codex / 飞书用 HTTP `server/mcp-bash-route.ts`。改 bash 行为两边都要看。
- 新增/改模型只动 `src/lib/settings.ts`。
- `docs/superpowers/` 是**设计期**文档，已与实现漂移，别当现状读（漂移清单在 AGENTS.md 末尾）。
