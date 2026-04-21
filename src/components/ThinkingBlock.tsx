interface Props {
  text: string;
  expanded: boolean;
  onToggle: () => void;
  delay?: number;
}

export default function ThinkingBlock({
  text,
  expanded,
  onToggle,
  delay = 0,
}: Props) {
  const preview =
    text.length > 80 ? text.slice(0, 80).replace(/\s+/g, " ") + "…" : text;

  return (
    <div className="msg-enter" style={{ animationDelay: `${delay}ms` }}>
      <button
        onClick={onToggle}
        className="group w-full flex items-center gap-2 text-left hover:bg-fg/[0.02] rounded-sm py-1 pr-2 transition-colors"
      >
        <Chevron open={expanded} />
        <ThoughtIcon />
        <span className="font-mono text-[10.5px] text-subtle uppercase tracking-[0.08em]">
          思考
        </span>
        <span className="text-subtle/70 text-[11px]">· {text.length} 字</span>
        {!expanded && preview && (
          <span className="text-subtle text-[12px] truncate flex-1 ml-1 italic">
            {preview}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 mb-2 pl-3 ml-[11px] border-l-2 border-line-strong">
          <div className="text-[12.5px] leading-[1.75] text-muted italic whitespace-pre-wrap break-words">
            {text}
          </div>
        </div>
      )}
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 9 9"
    fill="none"
    className={`shrink-0 text-subtle transition-transform ${open ? "rotate-90" : ""}`}
  >
    <path
      d="M3 2L6 4.5L3 7"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ThoughtIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0 text-subtle"
  >
    <path
      d="M4 4C4 2.9 4.9 2 6 2H9C10.1 2 11 2.9 11 4V6C11 7.1 10.1 8 9 8H6.5L4 10V8C4 7.45 3.55 7 3 7V4Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <circle cx="5.5" cy="12" r="0.7" fill="currentColor" />
    <circle cx="3" cy="13" r="0.5" fill="currentColor" />
  </svg>
);
