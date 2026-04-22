import { useEffect, useState } from "react";
import { WORKING_WORDS, pickFrom } from "../lib/thinking-words";

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export default function PendingHint() {
  const [label, setLabel] = useState(() => pickFrom(WORKING_WORDS));
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const labelTimer = setInterval(() => {
      setLabel((cur) => pickFrom(WORKING_WORDS, cur));
    }, 1800);
    const tickTimer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => {
      clearInterval(labelTimer);
      clearInterval(tickTimer);
    };
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
      <span className="font-mono text-[11px] text-subtle tabular-nums">
        · {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
