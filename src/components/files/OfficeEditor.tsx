import { useEffect, useRef, useState } from "react";
import { rawFileUrl } from "../../lib/filepreview";

// ONLYOFFICE 编辑器。api.js 由**容器**提供（公网那条腿），配置由我们的
// /api/office/config 下发并签名。
//
// ⚠️ 这个组件所在的那格必须常驻不卸载（见 RightDock 顶部注释）：销毁 iframe 是
// 律枢栽过的那个坑（累积三次再也打不开）。这里只在 path 变化时重建编辑器实例。
//
// ⚠️ 容器不可用（没配、或 lvshu 的栈停了）时**不是报错，是降级**：给「用浏览器
// 打开 / 下载」。Edge 会用它自己的 Office 查看器渲染，别的浏览器就是下载 ——
// 这条路径是刻意接受的（决策 9）。

type DocEditorInstance = {
  destroyEditor?: () => void;
  /** 让 iframe 里的编辑器把键盘焦点抢回去（api.js 里的 postMessage 命令）。 */
  grabFocus?: (data?: unknown) => void;
};

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (id: string, config: unknown) => DocEditorInstance;
    };
  }
}

const loaded = new Map<string, Promise<void>>();

// api.js 全局注入一次就够，多次注入会让 DocsAPI 反复覆盖自己。
function loadApiJs(officeUrl: string): Promise<void> {
  const src = `${officeUrl.replace(/\/+$/, "")}/web-apps/apps/api/documents/api.js`;
  const hit = loaded.get(src);
  if (hit) return hit;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () =>
      reject(new Error(`取不到 api.js（${src}）—— 容器不可达`));
    document.head.appendChild(el);
  });
  loaded.set(src, p);
  return p;
}

interface Props {
  path: string;
  name: string;
}

export default function OfficeEditor({ path, name }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const idRef = useRef(`office-${Math.random().toString(36).slice(2)}`);
  const editorRef = useRef<DocEditorInstance | null>(null);

  useEffect(() => {
    let editor: DocEditorInstance | null = null;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `/api/office/config?path=${encodeURIComponent(path)}`
        );
        if (res.status === 503) throw new Error("服务端未开启在线编辑");
        if (!res.ok) throw new Error(`拿配置失败：${res.status}`);
        const { officeUrl, config } = (await res.json()) as {
          officeUrl: string;
          config: unknown;
        };
        await loadApiJs(officeUrl);
        if (cancelled || !window.DocsAPI) return;
        editor = new window.DocsAPI.DocEditor(idRef.current, config);
        editorRef.current = editor;
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      editorRef.current = null;
      // 只在换文件/关标签时销毁；标签之间的切换是 hidden，不会走到这里。
      editor?.destroyEditor?.();
    };
  }, [path]);

  // 全屏进出时把键盘焦点交给编辑器。两条路都要它：
  //   · **进**全屏（RightDock 那颗「放映」把整个文档栏全屏了）——不抢焦点的话，
  //     ONLYOFFICE 的工具栏和快捷键第一下是不响应的；
  //   · **出**全屏——第一下 Esc 被浏览器拿去退全屏了，放映器还开着，第二下必须落进
  //     iframe 才有用。容器自己的中文文案就是这么写的（locale/zh.json 里
  //     `Common.Controllers.Shortcuts.txtDescriptionDemonstrationClosePreview`）：
  //       「结束幻灯片放映。对于网页版，第一次按 Esc 键会退出浏览器全屏模式，
  //         第二次按 Esc 键会退出放映模式。」
  //     而第二下常常落空 —— 退出全屏后焦点未必还在 iframe 里，Esc 打在宿主页上，
  //     现场表现是「怎么按都退不出放映」。
  //
  // ⚠️ **全屏的是我们的容器，不是这个 iframe**（跨源 iframe 仍然被
  //    `Permissions-Policy: fullscreen=(self)` 挡着，见 server/app.ts）。所以
  //    `fullscreenElement` 是 host 的**祖先**，两个方向都得认。
  // ⚠️ **只认可见的那一份。** 同一格里其它标签的编辑器还挂着（hidden 不卸载），它们
  //    的 host 同样落在那个全屏元素里，不排掉就会几份一起抢焦点。`display:none` 的
  //    子树 offsetParent 恒为 null，拿它当「这份现在在台上」最省事。
  useEffect(() => {
    const ours = { hit: false };
    const mine = (el: Element) => {
      const h = host.current;
      if (!h || h.offsetParent === null) return false;
      return el.contains(h) || h.contains(el);
    };
    const onFsChange = () => {
      const el = document.fullscreenElement;
      if (el) {
        ours.hit = mine(el);
        if (ours.hit) editorRef.current?.grabFocus?.();
        return;
      }
      if (!ours.hit) return;
      ours.hit = false;
      editorRef.current?.grabFocus?.();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  if (err) {
    return (
      <div className="p-4 space-y-3">
        <div className="text-[12.5px] text-orange leading-relaxed">
          在线编辑不可用：{err}
        </div>
        <div className="text-[12px] text-subtle leading-relaxed">
          可以先用浏览器打开看（Edge 会直接渲染 Office 文件，其它浏览器是下载），
          或者让 agent 直接改这份文件。
        </div>
        <a
          href={rawFileUrl(path)}
          target="_blank"
          rel="noreferrer"
          className="inline-block font-mono text-[11.5px] text-blue underline underline-offset-2"
        >
          用浏览器打开 / 下载 {name}
        </a>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <div id={idRef.current} ref={host} className="h-full w-full" />
    </div>
  );
}
