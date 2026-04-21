import { useState } from "react";

interface Props {
  question: string;
  options: string[];
  delay?: number;
  onAnswer?: (answer: string) => void;
}

export default function PermissionCard({
  question,
  options,
  delay = 0,
  onAnswer,
}: Props) {
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const answer = (v: string) => {
    setSelected(v);
    onAnswer?.(v);
  };

  const locked = selected !== null;

  return (
    <div
      className="msg-enter amber-card rounded-lg p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="text-[14.5px] text-fg leading-[1.7] mb-4">
        {question}
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        {options.map((opt) => (
          <button
            key={opt}
            disabled={locked}
            onClick={() => answer(opt)}
            className={`px-3.5 h-8 rounded-md text-[13px] border transition-all duration-150 ${
              selected === opt
                ? "bg-blue border-blue text-white"
                : locked
                  ? "bg-transparent border-fg/5 text-subtle"
                  : "bg-canvas/50 border-fg/10 text-muted hover:text-fg hover:border-fg/25 hover:bg-raised"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          disabled={locked}
          placeholder="自定义回答…"
          className="flex-1 h-9 px-3 rounded-md bg-canvas/50 border border-fg/10 text-[13px] text-fg placeholder:text-subtle focus:outline-none focus:border-fg/25 disabled:opacity-50 transition-colors"
        />
        <button
          disabled={!custom.trim() || locked}
          onClick={() => answer(custom.trim())}
          className="h-9 px-4 rounded-md bg-blue text-white text-[13px] font-medium hover:bg-blue-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          回答
        </button>
      </div>
    </div>
  );
}
