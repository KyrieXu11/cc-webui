import { useEffect, useState } from "react";
import { formatTurnElapsed, turnElapsedSeconds } from "../lib/turn-activity";

// 独立的整轮统计，不挂在 thinking/activity 行上，也不随工具/思考阶段切换归零。
// CLI 未提供可验证的 reasoning 累计耗时，不做「总耗时减工具耗时」之类的猜测。
export default function TurnStatus({ startedAt, effort }: { startedAt?: number; effort?: string }) {
  const [elapsed, setElapsed] = useState(() => turnElapsedSeconds(startedAt));
  useEffect(() => {
    const tick = () => setElapsed(turnElapsedSeconds(startedAt));
    tick();
    if (turnElapsedSeconds(startedAt) === null) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (elapsed === null) return null;
  return (
    <div data-turn-status className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted text-[11.5px]"
      title="从服务端本轮开始时间累计，包含模型等待、工具执行与回答生成；不是 reasoning 时长">
      <span className="inline-flex items-center gap-1.5 font-mono tabular-nums whitespace-nowrap">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" />
          <path d="M7 3.5V7L9.5 8.5" stroke="currentColor" strokeLinecap="round" />
        </svg>
        {formatTurnElapsed(elapsed)}
      </span>
      <span className="whitespace-nowrap">含工具与等待</span>
      {effort && <span className="font-mono whitespace-nowrap">推理档位：{effort}</span>}
    </div>
  );
}
