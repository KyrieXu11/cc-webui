import type { Plugin } from "unified";
import { resolveMessageDirectory, resolveMessageFile } from "./message-files";

type Node = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
};

// Work on parsed inline code/links only, never source text or fenced examples.
// Opted in only for Codex webpage replies, not memories or file previews.
const remarkMessageFiles: Plugin<[string], Node> = cwd => tree => {
  const definitions = new Map<string, string>();
  function collect(node: Node) {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    node.children?.forEach(collect);
  }
  collect(tree);
  function directoryForList(paragraph: Node): string | undefined {
    const directories: string[] = [];
    let codeReferences = 0;
    function text(node: Node): string {
      if (node.type === "inlineCode" && node.value) {
        codeReferences++;
        const directory = resolveMessageDirectory(node.value, cwd);
        if (directory) directories.push(directory);
      }
      if (node.type === "link" || node.type === "linkReference") return "";
      return node.value ?? node.children?.map(text).join("") ?? "";
    }
    // Narrow, explicit structure: "保存到 `dir/`：" followed immediately by
    // a file list. No recursive filename search or context leaking past it.
    const label = text(paragraph);
    return /[:：]\s*$/.test(label) && codeReferences === 1 && directories.length === 1 ? directories[0] : undefined;
  }
  function walk(node: Node, basenameDirectory?: string) {
    let nextListDirectory: string | undefined;
    node.children = node.children?.map(child => {
      if (child.type === "list") {
        walk(child, nextListDirectory ?? basenameDirectory);
        nextListDirectory = undefined;
        return child;
      }
      nextListDirectory = child.type === "paragraph" ? directoryForList(child) : undefined;
      const link = child.type === "link" || child.type === "linkReference";
      const value = child.type === "inlineCode" ? child.value : link ? child.url ?? definitions.get(child.identifier ?? "") : undefined;
      const file = value ? resolveMessageFile(value, cwd, link ? "link" : "code", basenameDirectory) : null;
      if (file) {
        const marked = child.type === "inlineCode" ? { type: "link", url: "#", children: [child] } : child;
        marked.data = { ...marked.data, hProperties: { ...marked.data?.hProperties, "data-message-file-path": file.path } };
        return marked;
      }
      // Inline code inside an ordinary web link must not become a nested action.
      if (!link) walk(child, basenameDirectory);
      return child;
    });
  }
  walk(tree);
};
export default remarkMessageFiles;
