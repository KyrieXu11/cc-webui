# subagent-mcp

Stdio MCP server that exposes **Claude** (via `@anthropic-ai/claude-agent-sdk`) as a subagent for any MCP-aware host. Designed to plug into the OpenAI **Codex CLI** so the parent Codex agent can delegate hard subtasks to Claude.

The server runs as a short-lived child process spawned on demand by the host — no daemon, no port. Lives in this repo to share `node_modules`, but is otherwise independent of the cc-webui web server.

## Tool exposed

`claude` — accepts:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `prompt` | ✓ | — | Self-contained task for Claude (no parent context). |
| `cwd` |   | host cwd | Working directory Claude operates in. |
| `model` |   | `claude-opus-4-7` | One of opus / sonnet / haiku. |
| `permission_mode` |   | `acceptEdits` | `plan` / `default` / `acceptEdits` / `bypassPermissions`. |
| `allowed_tools` |   | all | Restrict Claude to these tool names (e.g. `["Read", "Grep"]`). |
| `max_turns` |   | unlimited | Cap on tool-use iterations. |

Returns the final assistant text plus a `--- subagent steps (N) ---` trace.

## Authentication

The Claude SDK internally spawns the `claude` binary, which reads `~/.claude/` for credentials (Claude Code's OAuth login). If you've run `claude login` once, no extra setup. To force an API key instead, set `ANTHROPIC_API_KEY` in the `env` block of the Codex MCP config below.

## Wiring it into Codex CLI

Append to `~/.codex/config.toml`:

```toml
[mcp_servers.subagent]
command = "npx"
args    = ["tsx", "/Users/xuqiang/code/cc-webui/cli/subagent-mcp/index.ts"]
default_tools_approval_mode = "approve"
# Optional: force a specific Anthropic API key instead of OAuth
# env = { ANTHROPIC_API_KEY = "sk-ant-..." }
```

Codex will spawn the script the first time it tries to invoke `mcp__subagent__claude` in any session and reuse it for the rest of the turn.

## Optional: native Codex subagent wrapper

To get Codex's native "spawn subagent" UX (parallel instances, dedicated context, nice spawn UI), add a TOML wrapper at `~/.codex/agents/claude.toml`:

```toml
name = "claude"
description = "Delegate to Claude (Code SDK). Use for hard reasoning, careful reviews, large refactors."
developer_instructions = """
Your ONLY job is to call the `mcp__subagent__claude` tool with the user's task verbatim,
then return its output verbatim. Do not edit, paraphrase, or shell out yourself.
"""
sandbox_mode = "read-only"
```

Then prompt Codex with `"spawn a claude subagent to ..."` and it will go through this persona.

## Testing

From any terminal:

```bash
cd /any/dir
codex
> Use mcp__subagent__claude to ask Claude to read README.md and summarise it in one line.
```

You should see Codex spawn the script (visible via `ps aux | grep subagent-mcp`) and return Claude's summary. First-call cold start ≈ 2-3s (tsx + Claude binary spawn).
