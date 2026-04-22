import { useEffect, useState } from "react";
import { pickThinkingWord } from "../lib/thinking-words";

export default function PendingHint() {
  const [label, setLabel] = useState(() => pickThinkingWord());

  useEffect(() => {
    const t = setInterval(() => {
      setLabel((cur) => pickThinkingWord(cur));
    }, 1600);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="msg-enter flex items-center gap-2 pl-1 py-1">
      <svg
        width="13"
        height="13"
        viewBox="0 0 14 14"
        fill="none"
        className="shrink-0 text-orange sparkle-spin"
      >
        <path
          d="M7 1 L7 13 M1 7 L13 7 M2.5 2.5 L11.5 11.5 M2.5 11.5 L11.5 2.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-mono text-[11.5px] text-orange tracking-[0.02em]">
        {label}…
      </span>
    </div>
  );
}
