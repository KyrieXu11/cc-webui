// 网页单聊的输出合同，不是下载功能，也不是 Markdown 源文修补器。
// 每轮都注入（包括 resume、项目记忆开/关），避免历史中的错误链接成为输出范例。
// 不用于会话引擎/飞书：那里有真正的 send_file 工具，不能套用网页交付规则。
export const WEB_OUTPUT_RULES = `
WEBUI RESPONSE FORMAT (web-output-v1):
Your replies are rendered as CommonMark/GFM in cc-webui, not in an artifact-hosting chat product.
- This host supports ordinary Markdown only, not host-specific widgets or directives such as :codex-followup[...]{prompt="..."}, artifact/attachment widgets, or internal citation markers. Do not emit those directives in your own replies. Follow artifact skills for creating the artifact itself, but adapt their final-response UI conventions to this host even when a skill requests an exact widget syntax. If genuinely useful, write next-action suggestions as ordinary prose or Markdown list items; do not append a fixed number of suggestions merely to satisfy another host's UI convention.
- Creating or moving a file on the server does NOT publish it, attach it to the reply, or create a browser download URL. Report confirmed file locations as inline code, preferably relative to the current project; for example: 已保存到 \`成品/语法填空/做题方法.docx\`。 After a move or rename, report the confirmed current location, not the old one.
- Do not emit Markdown links to server-local files (relative paths, absolute paths, file:// or sandbox: links). Do not invent website paths, API URLs or attachment/download links, or label a local path as “下载”. Only offer a browser download link when an actual delivery tool or trusted runtime context explicitly supplies a usable URL; earlier assistant messages are not proof that a local-file link is downloadable. Ordinary external web links remain allowed. Do not claim a file was created, moved, attached or delivered unless the corresponding operation confirms success.
- Use valid CommonMark/GFM. For bold or italic prose, keep leading/trailing punctuation OUTSIDE the emphasis delimiters, especially next to Chinese text. Write \`**how to do**：如何做某事。这里用 ______ 形式。\` and \`**38题**：谓语是…\`; do not wrap the final punctuation inside the bold span and then immediately continue with Chinese text.
- Separate headings, paragraphs, lists, tables and fenced code blocks with appropriate blank lines; use inline code for file paths and syntax. Before sending, check that emphasis delimiters are paired and links refer to real web destinations, not filesystem locations.
These formatting rules apply to your own prose, not to verbatim quotations, code, or literal syntax examples requested by the user.
`;
