import { useEffect, useRef, useState } from "react";

interface Props {
  text: string;
  expanded: boolean;
  onToggle: () => void;
  delay?: number;
}

const WORDS = [
  "Thinking",
  "Pondering",
  "Musing",
  "Considering",
  "Deliberating",
  "Ruminating",
  "Contemplating",
  "Reflecting",
  "Cogitating",
  "Reasoning",
  "Analyzing",
  "Brewing",
  "Churning",
  "Thundering",
  "Simmering",
  "Crunching",
  "Scheming",
  "Weaving",
  "Stirring",
  "Unraveling",
  "Decoding",
  "Plotting",
];

function pickWord(prev?: string): string {
  if (WORDS.length < 2) return WORDS[0];
  while (true) {
    const w = WORDS[Math.floor(Math.random() * WORDS.length)];
    if (w !== prev) return w;
  }
}

export default function ThinkingBlock({
  text,
  expanded,
  onToggle,
  delay = 0,
}: Props) {
  const [label, setLabel] = useState(() => pickWord());
  const [active, setActive] = useState(true);
  const prevTextRef = useRef(text);

  // Mark active whenever the content changes; flip to inactive after a quiet gap.
  useEffect(() => {
    prevTextRef.current = text;
    setActive(true);
    const t = setTimeout(() => setActive(false), 2500);
    return () => clearTimeout(t);
  }, [text]);

  // While thinking is active, rotate through verbs.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setLabel((cur) => pickWord(cur));
    }, 1600);
    return () => clearInterval(t);
  }, [active]);

  const preview =
    text.length > 80 ? text.slice(0, 80).replace(/\s+/g, " ") + "…" : text;

  return (
    <div className="msg-enter" style={{ animationDelay: `${delay}ms` }}>
      <button
        onClick={onToggle}
        className="group w-full flex items-center gap-2 text-left hover:bg-fg/[0.02] rounded-sm py-1 pr-2 transition-colors"
      >
        <Chevron open={expanded} />
        <Sparkle active={active} />
        <span className="font-mono text-[11.5px] text-orange tracking-[0.02em]">
          {active ? `${label}…` : "thought"}
        </span>
        <span className="text-subtle/70 text-[11px]">· {text.length} 字</span>
        {!expanded && preview && (
          <span className="text-subtle text-[12px] truncate flex-1 ml-1 italic">
            {preview}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 mb-2 pl-3 ml-[11px] border-l-2 border-orange/40">
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

const Sparkle = ({ active }: { active: boolean }) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 14 14"
    fill="none"
    className={`shrink-0 text-orange ${active ? "sparkle-spin" : ""}`}
  >
    <path
      d="M7 1 L7 13 M1 7 L13 7 M2.5 2.5 L11.5 11.5 M2.5 11.5 L11.5 2.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);
