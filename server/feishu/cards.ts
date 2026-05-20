// Feishu interactive-card renderers for tool permission requests.
//
// The cc-webui permission flow (server/groups/claude-runner.ts) emits two
// payload shapes on the agent_event channel:
//
//   { type: "permission_request",  id, tool, input, ... }
//   { type: "permission_resolved", id, behavior?|stale? }
//
// bridge.ts catches both: it sends a fresh card for the request and patches
// that same card via channel.updateCard() once a decision (or timeout)
// arrives, locking the buttons.

export type PermissionRequestPayload = {
  type: "permission_request";
  id: string;
  tool: string;
  input: Record<string, any>;
  title?: string;
  displayName?: string;
  description?: string;
  hasSessionPermissionSuggestions?: boolean;
  toolUseId?: string;
};

export type PermissionResolvedPayload = {
  type: "permission_resolved";
  id: string;
  behavior?: "allow" | "allow_session" | "allow_tool_session" | "deny";
  stale?: boolean;
};

const MAX_SUMMARY = 600;

function plain(content: string): object {
  return { tag: "plain_text", content };
}

function summarizeInput(input: Record<string, any> | undefined): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const candidate =
    (typeof o.command === "string" && o.command) ||
    (typeof o.file_path === "string" && o.file_path) ||
    (typeof o.path === "string" && o.path) ||
    (typeof o.url === "string" && o.url) ||
    (typeof o.query === "string" && o.query) ||
    (typeof o.pattern === "string" && o.pattern) ||
    "";
  if (candidate) return candidate;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function codeBlock(tool: string, summary: string): string {
  const lang = tool === "Bash" ? "bash" : "";
  const truncated =
    summary.length > MAX_SUMMARY
      ? summary.slice(0, MAX_SUMMARY) + "…"
      : summary;
  return summary ? `\`\`\`${lang}\n${truncated}\n\`\`\`` : "_(no input)_";
}

export function permissionRequestCard(p: PermissionRequestPayload): object {
  const summary = summarizeInput(p.input);
  const desc = p.description || p.displayName || "";
  const md = [
    `**工具**: \`${p.tool}\``,
    desc ? `**描述**: ${desc}` : "",
    "",
    codeBlock(p.tool, summary),
  ]
    .filter(Boolean)
    .join("\n");

  const actions: object[] = [
    {
      tag: "button",
      text: plain("✓ 允许"),
      type: "primary",
      value: { kind: "permission", id: p.id, decision: "allow" },
    },
  ];
  if (p.hasSessionPermissionSuggestions) {
    actions.push({
      tag: "button",
      text: plain("🔁 本轮都允许"),
      type: "default",
      value: { kind: "permission", id: p.id, decision: "allow_session" },
    });
  }
  actions.push({
    tag: "button",
    text: plain("✗ 拒绝"),
    type: "danger",
    value: { kind: "permission", id: p.id, decision: "deny" },
  });

  return {
    // `update_multi: true` is required by Feishu for cards that will be
    // patched via channel.updateCard() — without it, server-side updates
    // don't propagate to recipients' clients (the server's message state
    // changes but the IM UI never re-renders).
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: plain("🔒 工具权限请求"),
      template: "orange",
    },
    elements: [
      { tag: "markdown", content: md },
      { tag: "hr" },
      { tag: "action", actions },
    ],
  };
}

export function permissionResolvedCard(
  request: PermissionRequestPayload,
  resolved: PermissionResolvedPayload,
  operatorName?: string,
): object {
  const stale = !!resolved.stale;
  const behavior = resolved.behavior;

  let template: string;
  let headerTitle: string;
  if (stale) {
    template = "grey";
    headerTitle = "⏱ 已过期 / 中止";
  } else if (behavior === "deny") {
    template = "red";
    headerTitle = `✗ 已拒绝 ${request.tool}`;
  } else if (behavior === "allow_session") {
    template = "green";
    headerTitle = `✓ 本轮都允许 ${request.tool}`;
  } else if (behavior === "allow_tool_session") {
    template = "green";
    headerTitle = `✓ 该工具本轮都允许`;
  } else {
    template = "green";
    headerTitle = `✓ 已允许 ${request.tool}`;
  }

  const summary = summarizeInput(request.input);
  const md = [
    `**工具**: \`${request.tool}\``,
    operatorName ? `**操作人**: ${operatorName}` : "",
    "",
    codeBlock(request.tool, summary),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    // `update_multi: true` is required by Feishu for cards that will be
    // patched via channel.updateCard() — without it, server-side updates
    // don't propagate to recipients' clients (the server's message state
    // changes but the IM UI never re-renders).
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: plain(headerTitle),
      template,
    },
    elements: [{ tag: "markdown", content: md }],
  };
}
