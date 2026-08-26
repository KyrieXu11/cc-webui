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

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (
        id: string,
        config: unknown
      ) => { destroyEditor?: () => void };
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

  useEffect(() => {
    let editor: { destroyEditor?: () => void } | null = null;
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
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      // 只在换文件/关标签时销毁；标签之间的切换是 hidden，不会走到这里。
      editor?.destroyEditor?.();
    };
  }, [path]);

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
