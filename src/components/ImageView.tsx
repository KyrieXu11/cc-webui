import { useCallback, useEffect, useRef, useState } from "react";
import LiquidSelection from "./LiquidSelection";

/* 图片查看器：缩放 + 拖动 + 旋转 + 适应/原图。
   替换的是一个裸 `<img className="max-w-full max-h-full object-contain">` ——
   一张拍下来的作业纸被压成窗口宽度，字全糊了，而**没有任何放大的办法**。

   ⚠️ 不引第三方库：一个只读查看器不值得多一个依赖，而依赖会跟着进每一次打包。

   下面这几条是 lvshu 那个查看器（app/src/components/RightDock.tsx）已经付过学费的，
   照抄的是教训不是布局——这里仍然长在原来那个可拖动的弹出窗口里：

   ⚠️⚠️ **倍率只能有一套刻度，且必须以「原图 100%」为基准**。把「适应」交给 CSS 的
   `max-width:100%` 去算、而 `z` 仍从 1 起步的话，适应态实际可能只有 35%，一点「＋」
   却切成 `scale(1.25)` ＝ 原图的 125% —— 一下跳 3.5 倍，屏幕上只剩一个字。
   所以 fitScale 由 JS 量出来，`z` 与它同一刻度，「适应」只是 `z = fitScale` 的别名。

   手势取看图软件的通用做法：
     滚轮/触控板 = 缩放（以指针为锚）· 拖拽 = 平移 · 双击 = 在「适应」与 100% 间切换 */

type View = { z: number; x: number; y: number };

const FIT_PAD = 24;
const MIN_Z = 0.05;
const MAX_Z = 8;

interface Props {
  url: string;
  alt: string;
  /** 棋盘底衬——透明图（png/webp）没有它就分不清「白」和「透明」。 */
  checkerboard?: boolean;
}

export default function ImageView({ url, alt, checkerboard = true }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const modeRail = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  /* ⚠️ 倍率与偏移是**一个**状态：缩放要连带修正偏移（锚点）、拖动要受当前倍率约束。
     拆成两个 useState 就得在其中一个的 setter 里读另一个的旧值，必然读到上一帧。
     `z === 0` ＝「跟着适应走」，容器一变宽它自己跟着变，不是一个待填的数。 */
  const [v, setV] = useState<View>({ z: 0, x: 0, y: 0 });
  const [deg, setDeg] = useState(0);
  const [grabbing, setGrabbing] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const measure = useCallback(() => {
    const el = stage.current;
    if (el) setBox({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    /* ⚠️ 先自己量一次再交给 ResizeObserver：只靠 RO 拿首个尺寸的话，容器尺寸会停在
       `{0,0}` ⇒ fitScale 退化成 1 ⇒ 打开就是 100%。RO 只保证「尺寸变了会通知」，
       不保证「挂上去就先通知一次当前值」。而这个窗口本身就能拖动改大小。 */
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  /* ⚠️ 不能只靠 `onLoad` 量原图尺寸：图在缓存里时 `complete` 在 React 把监听挂上去
     之前就已经是 true，那个事件**永远不来** ⇒ nat 恒为 0 ⇒ 适应倍率退化成 1，
     打开就是 100%。表现是「第一次打开好好的，第二次打开满屏一个字」。 */
  useEffect(() => {
    setV({ z: 0, x: 0, y: 0 });
    setDeg(0);
    measure();
    const el = img.current;
    setNat(
      el?.complete && el.naturalWidth
        ? { w: el.naturalWidth, h: el.naturalHeight }
        : { w: 0, h: 0 }
    );
  }, [url, measure]);

  /* 旋转 90°/270° 后，图在屏幕上占的框是长宽对调的——适应倍率和平移边界都得用
     这个「转过之后的」尺寸算，否则竖图转横之后要么留一大片白、要么拖不到边。 */
  const turned = deg % 180 !== 0;
  const shown = turned ? { w: nat.h, h: nat.w } : nat;

  /* 适应倍率：长边贴合容器，留一点余量。**不放大小图**（上限 1）——
     把一张 300px 的截图撑满窗口只会糊，看图软件都是这个规矩。
     ⚠️ 挂载那一瞬容器高度是 0，不设下限会算出负倍率。 */
  const fitOf = (n: { w: number; h: number }, b: { w: number; h: number }) =>
    n.w > 0 && n.h > 0 && b.w > FIT_PAD && b.h > FIT_PAD
      ? Math.min(1, (b.w - FIT_PAD) / n.w, (b.h - FIT_PAD) / n.h)
      : 1;
  const fitScale = fitOf(shown, box);
  const cur = v.z || fitScale;
  const atFit = Math.abs(cur - fitScale) < 0.005;
  const pannable = cur > fitScale + 0.005;
  const modeKey = v.z === 0 ? "fit" : Math.abs(cur - 1) < .005 ? "original" : atFit ? "fit" : null;

  /* 平移边界：图比容器小的那个方向锁死居中，大的方向不许把边缘拖进容器内。
     不收边的话图能被整个拖出视野，界面上就只剩一片空白——看着像坏了。 */
  const clampXY = useCallback(
    (z: number, x: number, y: number, n = shown, b = box): View => {
      const mx = Math.max(0, (n.w * z - b.w) / 2);
      const my = Math.max(0, (n.h * z - b.h) / 2);
      return {
        z,
        x: Math.max(-mx, Math.min(mx, x)),
        y: Math.max(-my, Math.min(my, y)),
      };
    },
    [shown, box]
  );

  /* 以指针为锚缩放：放大是为了看清某处，按图片中心缩会把那一处推出视野，
     等于每放大一次都要重新找一遍。 */
  const zoomAt = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      setV((prev) => {
        const el = stage.current;
        const b = el ? { w: el.clientWidth, h: el.clientHeight } : box;
        const from = prev.z || fitOf(shown, b);
        const z = Math.max(MIN_Z, Math.min(MAX_Z, from * factor));
        const k = z / from - 1;
        let { x, y } = prev;
        if (el && cx !== undefined && cy !== undefined) {
          const r = el.getBoundingClientRect();
          x -= (cx - r.left - r.width / 2 - x) * k;
          y -= (cy - r.top - r.height / 2 - y) * k;
        }
        return clampXY(z, x, y, shown, b);
      });
    },
    [box, shown, clampXY]
  );

  /* ⚠️ 滚轮必须自己挂原生监听：React 把 wheel 注册成**被动**的，写在 onWheel 里的
     preventDefault 不生效（只在控制台留一行警告），于是缩放的同时外层还跟着滚。 */
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const toFit = useCallback(() => setV({ z: 0, x: 0, y: 0 }), []);

  /* 转完保留当前倍率（用户放大是为了看细节，转一下不该把它丢掉），
     但偏移要按新的框重新收边——旧偏移是按旧朝向算的。 */
  const rotate = (by: number) => {
    const next = (((deg + by) % 360) + 360) % 360;
    const swap = next % 180 !== 0;
    const box2 = swap ? { w: nat.h, h: nat.w } : nat;
    setDeg(next);
    setV((p) => (p.z ? clampXY(p.z, p.x, p.y, box2) : { z: 0, x: 0, y: 0 }));
  };

  const btn =
    "image-view-button shrink-0 inline-flex items-center justify-center font-mono select-none";
  const on = "image-view-button--active";

  return (
    <div className="image-view h-full min-h-0 flex flex-col">
      <div className="image-view-toolbar shrink-0" role="toolbar" aria-label="图片操作">
        <div className="image-view-controls">
        <div className="image-control-group">
        <button className={btn} title="缩小" aria-label="缩小" onClick={() => zoomAt(1 / 1.25)}>
          <ZoomIcon />
        </button>
        <span
          className="image-view-zoom text-center font-mono text-muted tabular-nums select-none"
          title="当前显示倍率（相对原图）"
        >
          {Math.round(cur * 100)}%
        </span>
        <button className={btn} title="放大" aria-label="放大" onClick={() => zoomAt(1.25)}>
          <ZoomIcon plus />
        </button>
        </div>
        <div className="image-control-group image-view-modes" ref={modeRail}>
        <LiquidSelection container={modeRail} activeKey={modeKey} axis="horizontal" />
        <button
          className={`${btn} ${modeKey === "fit" ? on : ""}`}
          data-liquid-key="fit"
          title="缩到看得见整张"
          aria-pressed={modeKey === "fit"}
          onClick={toFit}
        >
          适应
        </button>
        <button
          className={`${btn} ${modeKey === "original" ? on : ""}`}
          data-liquid-key="original"
          title="按原图尺寸显示"
          aria-pressed={modeKey === "original"}
          onClick={() => setV(clampXY(1, 0, 0))}
        >
          原图
        </button>
        </div>
        <div className="image-control-group">
        <button className={btn} title="向左转 90°" aria-label="向左旋转" onClick={() => rotate(-90)}>
          <RotateIcon dir="ccw" />
        </button>
        <button className={btn} title="向右转 90°" aria-label="向右旋转" onClick={() => rotate(90)}>
          <RotateIcon dir="cw" />
        </button>
        </div>
        {deg !== 0 && (
          <span className="font-mono text-[10.5px] text-subtle tabular-nums select-none">
            {deg}°
          </span>
        )}
        </div>
        {nat.w > 0 && (
          <span className="image-view-dimensions font-mono text-muted tabular-nums select-none">
            {nat.w}×{nat.h}
          </span>
        )}
      </div>

      <div
        ref={stage}
        className={
          "image-view-stage flex-1 min-h-0 overflow-hidden flex items-center justify-center " +
          (checkerboard ? "image-view-stage--checker " : "") +
          (grabbing ? "cursor-grabbing" : pannable ? "cursor-grab" : "cursor-default")
        }
        onDoubleClick={(e) => (atFit ? zoomAt(1 / cur, e.clientX, e.clientY) : toFit())}
        onPointerDown={(e) => {
          if (!pannable) return;
          drag.current = { x: e.clientX, y: e.clientY, ox: v.x, oy: v.y };
          setGrabbing(true);
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setV((p) =>
            clampXY(p.z || fitScale, d.ox + (e.clientX - d.x), d.oy + (e.clientY - d.y))
          );
        }}
        onPointerUp={() => {
          drag.current = null;
          setGrabbing(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setGrabbing(false);
        }}
      >
        <img
          ref={img}
          src={url}
          alt={alt}
          className="image-view-image"
          draggable={false}
          onLoad={(e) =>
            setNat({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          /* rotate 写在最里层：scale 作用在**转过之后**的图上，视觉中心不动，
             所以 translate 的语义和没旋转时完全一致（clampXY 才敢共用一套算法）。
             max-width 必须显式关掉——Tailwind preflight 的 `img{max-width:100%}`
             会把 transform 之前的布局宽度先砍掉一刀（那是 CSS 的一套刻度），
             倍率就再也对不上原图了。 */
          style={{
            maxWidth: "none",
            maxHeight: "none",
            // 布局尺寸必须**恰好**是原图尺寸——整套倍率算的都是相对它。
            // 它是 flex item，被 shrink 掉一点点，屏幕上的 100% 就不是 100% 了。
            flexShrink: 0,
            transform: `translate(${v.x}px, ${v.y}px) scale(${cur}) rotate(${deg}deg)`,
            // 拖动时不能有过渡：那会让图追着指针慢半拍，手感像卡了。
            transition: grabbing ? "none" : "transform 90ms linear",
          }}
        />
      </div>
    </div>
  );
}

const ZoomIcon = ({ plus = false }: { plus?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d={plus ? "M3 8h10M8 3v10" : "M3 8h10"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const RotateIcon = ({ dir }: { dir: "cw" | "ccw" }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    style={dir === "ccw" ? { transform: "scaleX(-1)" } : undefined}
  >
    <path
      d="M11.5 6.2A4.6 4.6 0 1 0 10.2 10"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <path
      d="M11.8 2.6v3.6H8.2"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
