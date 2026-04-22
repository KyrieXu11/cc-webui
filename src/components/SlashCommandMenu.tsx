import { useEffect, useRef } from "react";

interface Props {
  commands: string[];
  activeIdx: number;
  onPick: (cmd: string) => void;
  onHover: (idx: number) => void;
  query: string;
}

export default function SlashCommandMenu({
  commands,
  activeIdx,
  onPick,
  onHover,
  query,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const item = el.children[activeIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (commands.length === 0) return null;
  return (
    <div className="absolute left-2 right-2 bottom-full mb-2 bg-surface border border-line-strong rounded-lg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)] overflow-hidden z-50">
      <div className="px-3 py-1.5 text-[10px] font-mono text-subtle uppercase tracking-[0.08em] border-b border-line flex items-center justify-between">
        <span>斜杠命令</span>
        <span className="text-subtle/60">↑↓ · ↵ 选择 · esc 取消</span>
      </div>
      <div ref={listRef} className="max-h-[280px] overflow-y-auto py-1">
        {commands.map((c, i) => (
          <button
            key={c}
            onClick={() => onPick(c)}
            onMouseEnter={() => onHover(i)}
            className={`w-full text-left px-3 py-1.5 flex items-center gap-2 font-mono text-[12.5px] transition-colors ${
              i === activeIdx
                ? "bg-blue/[0.15] text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            <span className="text-subtle">/</span>
            <Highlighted text={c} query={query} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <span>{text}</span>;
  const pos = text.toLowerCase().indexOf(q);
  if (pos < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, pos)}
      <span className="text-fg font-medium bg-blue/20 rounded-sm px-[1px]">
        {text.slice(pos, pos + query.length)}
      </span>
      {text.slice(pos + query.length)}
    </span>
  );
}
