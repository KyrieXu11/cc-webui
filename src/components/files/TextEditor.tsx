import { useEffect, useRef, useState } from "react";

// CodeMirror 6 的薄包装。**动态 import**：主 bundle 不为一个校对场景涨 200KB
// （决策 7），只有真正打开编辑器时才拉那个 chunk。
//
// ⚠️ 不做受控组件。CodeMirror 自己持有文档状态，每次 props.value 变化就 dispatch
// 一次全文替换的话，光标位置、撤销历史、折叠状态全丢。这里的契约是：
// **挂载时灌入初始内容，之后改动只经 onChange 往外报**；外部要换文件就换 key，
// 让整个组件重建。

interface Props {
  /** 初始内容。后续变化被忽略——换文件请换 key。 */
  initial: string;
  filename: string;
  onChange: (next: string) => void;
  onSave?: () => void;
}

// 主题跟着应用的 CSS 变量走，light/dark 自动对齐，不引第三方主题包。
const THEME_VARS: Record<string, Record<string, string>> = {
  "&": {
    backgroundColor: "transparent",
    color: "var(--color-fg)",
    fontSize: "12.5px",
  },
  ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-subtle)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "rgba(127,127,127,0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--color-fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(90,140,255,0.25)",
  },
};

async function languageFor(filename: string) {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "mdx") {
    return (await import("@codemirror/lang-markdown")).markdown();
  }
  if (ext === "json" || ext === "jsonc" || ext === "json5") {
    return (await import("@codemirror/lang-json")).json();
  }
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({
      typescript: ext.startsWith("ts"),
      jsx: ext.endsWith("x"),
    });
  }
  return null; // 其它格式：只给行号与基础编辑，不猜语言
}

export default function TextEditor({
  initial,
  filename,
  onChange,
  onSave,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // onChange / onSave 走 ref：它们每次渲染都是新函数，进 CodeMirror 的扩展会
  // 导致整个编辑器重建。
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };

  useEffect(() => {
    let view: { destroy: () => void } | null = null;
    let cancelled = false;

    (async () => {
      try {
        const [{ EditorView, keymap }, { EditorState }, lang] =
          await Promise.all([
            import("@codemirror/view"),
            import("@codemirror/state"),
            languageFor(filename),
          ]);
        const { basicSetup } = await import("codemirror");
        if (cancelled || !host.current) return;

        const extensions = [
          basicSetup,
          EditorView.theme(THEME_VARS),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
          }),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                cbs.current.onSave?.();
                return true;
              },
            },
          ]),
        ];
        if (lang) extensions.push(lang);

        const v = new EditorView({
          state: EditorState.create({ doc: initial, extensions }),
          parent: host.current,
        });
        view = v;
      } catch (err) {
        // 懒加载的 chunk 拉不到（离线、缓存坏了）不该只剩一块白板。
        if (!cancelled) {
          setFailed(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      view?.destroy();
    };
    // initial / filename 变了就该换文件，而换文件由外部换 key 重建组件承担。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return (
      <div className="p-4 space-y-2">
        <div className="text-[12px] text-red font-mono">
          编辑器加载失败：{failed}
        </div>
        <textarea
          defaultValue={initial}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-[60vh] bg-surface border border-line rounded p-3 font-mono text-[12.5px] text-fg"
        />
      </div>
    );
  }

  return <div ref={host} className="h-full overflow-auto" />;
}
