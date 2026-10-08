import { useEffect, useState } from "react";
import { pickThinkingWord } from "../lib/thinking-words";
import { codexActivityLabel } from "../lib/turn-activity";

// Codex 独立的阶段反馈：可见文案只保留动态词，阶段语义留在 aria-label/title。
// 只有外部明确的 reasoning 信号才标「思考中」。
// 没有计时或 token 猜测；不改 Claude ThinkingRow 的时钟和活动检测。
export default function CodexActivityRow({
  phase = "processing", active = true, effort,
}: { phase?: "processing" | "reasoning"; active?: boolean; effort?: string }) {
  const [word, setWord] = useState(() => pickThinkingWord());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setWord(cur => pickThinkingWord(cur)), 1800);
    return () => clearInterval(timer);
  }, [active]);

  const reasoning = phase === "reasoning";
  return (
    <div className="relative flex items-center py-[6px] gap-3 w-full text-left"
      aria-label={active ? reasoning ? "Codex 思考中" : "Codex 处理中" : undefined}
      title={reasoning
        ? "收到 Codex reasoning 事件；未提供可靠的独立思考时长"
        : "当前回合仍在处理；CLI 未提供当前阶段，不代表已确认正在思考"}>
      <div className="relative z-10 shrink-0 bg-surface">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden
          className={`text-orange ${active ? "sparkle-spin" : ""}`}>
          <path d="M7 1 L7 13 M1 7 L13 7 M2.5 2.5 L11.5 11.5 M2.5 11.5 L11.5 2.5"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] min-w-0 flex-1">
        <span className="font-mono text-orange">{codexActivityLabel(active, word, phase)}</span>
        {reasoning && active && effort && (
          <span className="font-mono text-[11.5px] text-subtle">推理档位：{effort}</span>
        )}
      </div>
    </div>
  );
}
