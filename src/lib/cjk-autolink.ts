import type { Plugin } from "unified";

// GFM 的 autolink literal 只认 ASCII 空白和 ASCII 标点作为 URL 的终止符。中文正文
// **没有空格**，于是 `（www.gsxt.gov.cn）、'信用中国'网站查询…` 会被整句吞成一个链接
// （实测 href 里塞进了 40 多个汉字，整段变蓝带下划线）。
//
// ⚠️ **修剪必须做在 GFM 产出的 link 节点上，不能在源文本上做正则。**
// 上一版是在源文本里给 URL 和后面的汉字之间插一个空格，那等于**自己重新实现一遍 GFM
// 的 URL 匹配规则** —— 而它只写了 `https?://`，漏掉了 GFM 同样会 linkify 的裸 `www.`
// 形式，于是用户报的那一例完全没被修到。改成后处理就不存在"漏形式"这个类别的 bug 了，
// 而且不用往正文里注入空格（`（www.x.cn ）` 那个空格是看得见的）。
//
// 只动 **autolink literal**：判据是"链接文字就是 URL 本身"（`node.url` 以文字结尾 ——
// 裸 www 形式 url 会多一个 `http://` 前缀）。显式写的 `[文字](url)` 一律不碰。

/** 全角/CJK 标点。真 URL 里不可能出现（合法的话一定是 percent-encoded）。 */
const CJK_PUNCT =
  /[‘’“”…　-〿︐-﹯＀-￯]/;
/** CJK 表意文字。**路径里可能是真的**（维基百科条目名那类），所以要区别对待。 */
const CJK_IDEO = /[㐀-䶿一-鿿豈-﫿]/;

/** 该在第几个字符处把链接切开；-1 = 不用切。 */
export function cjkCutIndex(text: string): number {
  // 主机名到哪结束：跳过 `scheme://` 再找第一个 / ? #
  const sep = text.indexOf("://");
  const afterScheme = sep >= 0 ? sep + 3 : 0;
  const rel = text.slice(afterScheme).search(/[/?#]/);
  const pathStart = rel < 0 ? -1 : afterScheme + rel;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (CJK_PUNCT.test(ch)) return i;
    // 主机名里出现汉字一定是越界了；路径/查询串里就放过 —— truncate 一个真链接
    // 比留一个吞句子的链接更坏：它会静默指向错的地址。
    if (CJK_IDEO.test(ch) && !(pathStart >= 0 && i > pathStart)) return i;
  }
  return -1;
}

type MdNode = {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
};

/** 返回 true 表示在 index 后面插了一个 text 节点。 */
function trimLink(link: MdNode, siblings: MdNode[], index: number): boolean {
  const only = link.children?.length === 1 ? link.children[0] : undefined;
  if (!only || only.type !== "text" || !link.url || only.value === undefined) {
    return false;
  }
  // 只认 autolink literal：文字 === URL（裸 www 形式 url 前面多个 http://）
  if (!link.url.endsWith(only.value)) return false;

  const cut = cjkCutIndex(only.value);
  if (cut <= 0) return false;

  const tail = only.value.slice(cut);
  only.value = only.value.slice(0, cut);
  link.url = link.url.slice(0, link.url.length - tail.length);
  siblings.splice(index + 1, 0, { type: "text", value: tail });
  return true;
}

function walk(node: MdNode) {
  const kids = node.children;
  if (!Array.isArray(kids)) return;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    // 链接内部没什么要修的，不往里走。
    if (k.type === "link") {
      if (trimLink(k, kids, i)) i++; // 跳过刚插进去的那个 text
    } else {
      walk(k);
    }
  }
}

/**
 * remark 插件：把 GFM autolink 越界吞掉的中文尾巴从链接里挪回正文。
 * autolink 是**解析期**（micromark 扩展）产生的，所以本插件放在 remarkGfm 前后都行。
 */
const remarkCjkAutolink: Plugin<[], MdNode> = () => (tree) => {
  walk(tree);
};

export default remarkCjkAutolink;
