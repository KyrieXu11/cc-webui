import { useEffect, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { appSyntaxHighlighting } from "./highlight";

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
//
// ⚠️ **`&`（＝`.cm-editor`）必须有高度，`.cm-scroller` 必须自己 overflow:auto。**
// 这是 CodeMirror 官方文档写的「内部滚动」配方，不是可选项。以前的写法是给外层
// 那个 div 挂 `overflow-auto`、编辑器不限高 ⇒ `.cm-editor` 长到整份文档的高度、
// 外层在滚 ⇒ **CM 的视口虚拟化被绕过，整份文档一次全渲染**。表现就是「编辑器
// 有点不跟鼠标、总是卡卡的」（用户 2026-08-27 反馈），文件越大越明显。
const THEME_VARS: Record<string, Record<string, string>> = {
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--color-fg)",
    fontSize: "12.5px",
  },
  ".cm-scroller": { overflow: "auto" },
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

// 语言表。**全部动态 import** —— 主 bundle 不为高亮涨体积，每种语言是自己的 lazy chunk，
// 只在真打开那种文件时才下载。
//
// ⚠️ **加语言就加在这张表里，别在 `languageFor` 里堆 if。** 上一版只有 md / json /
// js-ts 三个 if，其余一律 `return null` —— 于是打开 .py 完全没高亮（真机反馈原话：
// 「不是有代码高亮了嘛，怎么 python 的没有高亮显示」），.sh / .yml / .css / .swift
// 同理。三个 if 看不出这是个"缺省即无高亮"的坑，一张表看得出。
//
// 没有官方 lang 包的走 `StreamLanguage` + legacy-modes（CodeMirror 5 时代的 mode，
// 高亮质量略糙但完全够看），见下面的 STREAM。
const LANG: Record<string, () => Promise<Extension | null>> = {};
const put = (exts: string, load: () => Promise<Extension | null>) => {
  for (const e of exts.split(" ")) LANG[e] = load;
};

put("md markdown mdx", async () =>
  (await import("@codemirror/lang-markdown")).markdown()
);
put("json jsonc json5", async () =>
  (await import("@codemirror/lang-json")).json()
);
put("py pyi pyw", async () => (await import("@codemirror/lang-python")).python());
put("css", async () => (await import("@codemirror/lang-css")).css());
put("html htm vue svelte", async () =>
  (await import("@codemirror/lang-html")).html()
);
put("yaml yml", async () => (await import("@codemirror/lang-yaml")).yaml());
put("sql", async () => (await import("@codemirror/lang-sql")).sql());
put("rs", async () => (await import("@codemirror/lang-rust")).rust());
put("go", async () => (await import("@codemirror/lang-go")).go());
put("xml svg xsl plist", async () =>
  (await import("@codemirror/lang-xml")).xml()
);
put("java", async () => (await import("@codemirror/lang-java")).java());
put("c h cc cpp cxx hpp hh m mm", async () =>
  (await import("@codemirror/lang-cpp")).cpp()
);
put("php", async () => (await import("@codemirror/lang-php")).php());

for (const ext of ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]) {
  LANG[ext] = async () => {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({
      typescript: ext.startsWith("ts") || ext.endsWith("ts"),
      jsx: ext.endsWith("x"),
    });
  };
}

/**
 * 没有官方 lang 包的语言：`StreamLanguage` + legacy-modes（CodeMirror 5 时代的 mode，
 * 高亮略糙但完全够看）。
 *
 * ⚠️ **每一项都得是写死的 import 说明符。** 试过 `import.meta.glob` 扫
 * `node_modules/@codemirror/legacy-modes/mode/*.js` 去省这几十行 —— 那是一条相对路径
 * 摸进 node_modules，构建器换个布局（pnpm / 提升方式变了）就整片静默失效，而且要额外
 * 挂 vite/client 类型。写死的说明符 Vite 能静态看见，每个 mode 一个 lazy chunk。
 */
const stream =
  (load: () => Promise<Record<string, unknown>>, name: string) =>
  async (): Promise<Extension | null> => {
    const [{ StreamLanguage }, m] = await Promise.all([
      import("@codemirror/language"),
      load(),
    ]);
    const legacy = m[name];
    return legacy
      ? StreamLanguage.define(legacy as Parameters<typeof StreamLanguage.define>[0])
      : null;
  };

put("sh bash zsh fish ksh", stream(() => import("@codemirror/legacy-modes/mode/shell"), "shell"));
put("swift", stream(() => import("@codemirror/legacy-modes/mode/swift"), "swift"));
put("rb rake gemspec", stream(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby"));
put("lua", stream(() => import("@codemirror/legacy-modes/mode/lua"), "lua"));
put("toml", stream(() => import("@codemirror/legacy-modes/mode/toml"), "toml"));
put("ini conf cfg properties env", stream(() => import("@codemirror/legacy-modes/mode/properties"), "properties"));
put("diff patch", stream(() => import("@codemirror/legacy-modes/mode/diff"), "diff"));
put("dockerfile", stream(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerfile"));
put("ps1 psm1", stream(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell"));
put("pl pm", stream(() => import("@codemirror/legacy-modes/mode/perl"), "perl"));
put("r", stream(() => import("@codemirror/legacy-modes/mode/r"), "r"));
put("scala sc", stream(() => import("@codemirror/legacy-modes/mode/clike"), "scala"));
put("kt kts", stream(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin"));
put("cs", stream(() => import("@codemirror/legacy-modes/mode/clike"), "csharp"));
put("dart", stream(() => import("@codemirror/legacy-modes/mode/clike"), "dart"));
put("groovy gradle", stream(() => import("@codemirror/legacy-modes/mode/groovy"), "groovy"));
put("clj cljs edn", stream(() => import("@codemirror/legacy-modes/mode/clojure"), "clojure"));
put("erl hrl", stream(() => import("@codemirror/legacy-modes/mode/erlang"), "erlang"));
put("hs", stream(() => import("@codemirror/legacy-modes/mode/haskell"), "haskell"));
put("jl", stream(() => import("@codemirror/legacy-modes/mode/julia"), "julia"));
put("scss sass", stream(() => import("@codemirror/legacy-modes/mode/sass"), "sass"));
put("less", stream(() => import("@codemirror/legacy-modes/mode/css"), "less"));
put("nginx", stream(() => import("@codemirror/legacy-modes/mode/nginx"), "nginx"));
put("proto", stream(() => import("@codemirror/legacy-modes/mode/protobuf"), "protobuf"));
put("tcl", stream(() => import("@codemirror/legacy-modes/mode/tcl"), "tcl"));
put("vb", stream(() => import("@codemirror/legacy-modes/mode/vb"), "vb"));
put("f f90 f95", stream(() => import("@codemirror/legacy-modes/mode/fortran"), "fortran"));
put("cmake", stream(() => import("@codemirror/legacy-modes/mode/cmake"), "cmake"));

async function languageFor(filename: string): Promise<Extension | null> {
  const base = filename.slice(filename.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  // 没有扩展名的按整个文件名认（Dockerfile / Makefile / .env 那类）。
  const key = dot > 0 ? base.slice(dot + 1) : base.replace(/^\./, "");
  return LANG[key] ? LANG[key]!() : null; // 认不出来：只给行号与基础编辑，不猜语言
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
          // ⚠️ 必须在 basicSetup **之后**：它自带的 defaultHighlightStyle 是亮色配色，
          // 落在本项目近黑的底色上读不出来。见 ./highlight.ts。
          appSyntaxHighlighting,
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

  // ⚠️ 外层**不能**再挂 overflow：滚动归 `.cm-scroller`（见 THEME_VARS 顶部注释）。
  return <div ref={host} className="h-full min-h-0" />;
}
