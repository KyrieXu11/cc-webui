import { useEffect, useState } from "react";
import { WORKING_WORDS, pickFrom } from "../lib/thinking-words";

export default function PendingHint() {
  const [label, setLabel] = useState(() => pickFrom(WORKING_WORDS));

  useEffect(() => {
    const t = setInterval(() => {
      setLabel((cur) => pickFrom(WORKING_WORDS, cur));
    }, 1800);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="msg-enter flex items-center gap-2 pl-1 py-1">
      <svg
        width="13"
        height="13"
        viewBox="0 0 14 14"
        fill="none"
        className="shrink-0 text-muted animate-spin origin-center"
        style={{ animationDuration: "1.2s" }}
      >
        <circle
          cx="7"
          cy="7"
          r="5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeDasharray="10 6"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-mono text-[11.5px] text-muted tracking-[0.02em]">
        {label}…
      </span>
    </div>
  );
}
