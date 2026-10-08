import type { Plugin } from "unified";
import type { Position } from "unist";

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: Position;
};

// Some existing memories use **标题：**正文. CommonMark treats that closing
// delimiter as punctuation next to a CJK letter, so the markers remain text.
// This opt-in memory compatibility rule only repairs already-parsed literal
// text nodes. It never rewrites stored Markdown, URLs, code or escaped syntax.
const PAIR = /\*\*([^\s*][^*\n]*[\p{P}\p{S}])\*\*(?=[㐀-䶿一-鿿豈-﫿])/gu;

function walk(node: Node, source: string) {
  if (!node.children || ["link", "linkReference", "code", "inlineCode", "html"].includes(node.type)) return;
  node.children = node.children.flatMap(child => {
    if (child.type !== "text" || !child.value?.includes("**")) {
      walk(child, source);
      return [child];
    }
    const start = child.position?.start.offset, end = child.position?.end.offset;
    // Parsing removes escapes/entities: if the source is different, leave it
    // alone rather than accidentally turning literal examples into emphasis.
    if (start === undefined || end === undefined || source.slice(start, end) !== child.value) return [child];
    const parts: Node[] = [];
    let at = 0;
    for (const match of child.value.matchAll(PAIR)) {
      if (match.index > at) parts.push({ type: "text", value: child.value.slice(at, match.index) });
      parts.push({ type: "strong", children: [{ type: "text", value: match[1] }] });
      at = match.index + match[0].length;
    }
    if (!parts.length) return [child];
    if (at < child.value.length) parts.push({ type: "text", value: child.value.slice(at) });
    return parts;
  });
}

const remarkCjkMemoryStrong: Plugin<[], Node> = () => (tree, file) => {
  walk(tree, String(file.value ?? ""));
};
export default remarkCjkMemoryStrong;
