# Claude Code 记忆提示原文

这是 2026-10-03 对本机 Claude Code 2.1.283 的研究快照，不参与产品运行时装配。

- `claude-sonnet-4-6-new.txt` 和 `claude-opus-5-5-new.txt`：实际请求里的记忆 system 段，仅将合成目录替换为 `<MEMORY_DIR>`。
- `*-resume.txt`：新的 CLI 进程 resume 时重发的规则，与该模型的新会话规则一致。
- `*-index.txt`：user-role 中的合成索引提醒，包含新会话与索引变化后的 resume 提醒。
- `capture-summary.json`：二进制 hash、长度、原文快照 hash、实验条件和六用例结果。
- `experimental-stone-shell-template.txt` 和 `connected-store-save-guidance-template.txt`：从格式化源码的字符串常量提取；**不是本次实际送出的 system prompt**。`<INTERPOLATION:...>` 是未展开的变量位置。

完整模块、完整请求和诊断日志在私有 `~/.cc-webui/research/claude-memory/2.1.283-2026-10-03/`。仓库不保存整个程序源码或其它系统提示，也不保存真实账号、凭据或生产记忆。

触发条件与产品差异见 [Claude Code 记忆 Prompt 对照](../../claude-memory-prompts.md)。
