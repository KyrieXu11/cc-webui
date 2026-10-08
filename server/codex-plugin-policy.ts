// cc-webui 子进程的局部禁用：不写 ~/.codex/config.toml，不影响原生 Codex。
// 只关用户指定的 PPT/PDF 插件，不关整个 plugins feature 或其它技能。
export const DISABLED_CODEX_ARTIFACT_PLUGINS = [
  "presentations@openai-primary-runtime",
  "pdf@openai-primary-runtime",
] as const;

export const CODEX_ARTIFACT_PLUGIN_OVERRIDES = DISABLED_CODEX_ARTIFACT_PLUGINS.map(
  // CLI 0.161.0 实测：key 不能照搬 TOML 表头的引号；带引号的覆盖仍会把
  // PPT/PDF 列为 enabled。无引号形式经 config/read + skills/list 确认生效。
  id => `plugins.${id}.enabled=false`,
);

// resume 会保留以前读过的 skill 正文。禁用发现并不会抹掉历史，因此每轮还要
// 明确说明当前运行环境；这是行为约束，不宣称磁盘上的缓存变成不可访问。
export const CODEX_ARTIFACT_PLUGIN_PROMPT = `
CC-WEBUI PLUGIN POLICY: This Codex process intentionally disables ${DISABLED_CODEX_ARTIFACT_PLUGINS.join(" and ")} without changing the user's global configuration.
Do not manually load their cached SKILL.md or revive their skill instructions from earlier turns. For PPT/PDF work, use project-owned scripts and ordinary installed libraries/tools directly. Existing project scripts remain usable; disabling these plugins does not prohibit creating, editing or inspecting PPT/PDF files. Do not re-enable these plugins or change the user's global plugin settings.
`;
