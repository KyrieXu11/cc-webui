import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// 编辑器的语法配色。
//
// ⚠️ **必须显式加，不能靠 `basicSetup` 的默认。** basicSetup 里带的
// `defaultHighlightStyle` 是一套**亮色**配色（关键字 #708 深紫、标识符 #00f 纯蓝、
// 字符串 #a11 深红），本项目默认是近黑底（#0a0d14）—— 实测暗色下这几个颜色几乎读不出来。
// 它是以 `{fallback: true}` 挂进去的，所以这里再加一个就会盖掉它。
//
// ⚠️ **颜色写成 CSS 变量，不在 JS 里按主题切两套。** CodeMirror 把这些声明生成成
// 真实的 CSS 类，`var(--syn-x)` 由浏览器按当前 `:root` 解析 —— 换主题即时生效，
// 编辑器不需要知道主题这件事，也不用在切换时重建 EditorView。两套值见 index.css。
const c = (name: string) => `var(--syn-${name})`;

const style = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.self],
    color: c("keyword"),
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: c("string") },
  { tag: [t.number, t.bool, t.null, t.atom], color: c("number") },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: c("comment"),
    fontStyle: "italic",
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    color: c("func"),
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)],
    color: c("type"),
  },
  {
    tag: [t.definition(t.variableName), t.definition(t.propertyName)],
    color: c("def"),
  },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: c("var") },
  {
    tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator],
    color: c("punct"),
  },
  {
    tag: [t.meta, t.annotation, t.processingInstruction],
    color: c("meta"),
  },
  { tag: t.tagName, color: c("keyword") },
  { tag: t.invalid, color: c("invalid") },
  { tag: t.link, color: c("func"), textDecoration: "underline" },
  { tag: t.heading, color: c("keyword"), fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

export const appSyntaxHighlighting = syntaxHighlighting(style);
