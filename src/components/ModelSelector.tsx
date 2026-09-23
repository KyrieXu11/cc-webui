import { Fragment } from "react";
import Popover from "./Popover";
import {
  modelLabel,
  modelOptionsForProvider,
  providerLabel,
  type AgentProvider,
} from "../lib/settings";

interface Props {
  provider: AgentProvider;
  value: string;
  onChange: (model: string) => void;
  direction?: "up" | "down";
  align?: "left" | "right";
}

export default function ModelSelector({
  provider,
  value,
  onChange,
  direction = "up",
  align = "left",
}: Props) {
  const models = modelOptionsForProvider(provider);
  return (
    <Popover
      align={align}
      direction={direction}
      width={240}
      triggerClassName="inline-flex items-center focus:outline-none rounded px-1.5 py-0.5 hover:bg-fg/5 transition-colors group"
      trigger={
        <span className="font-mono text-[11px] text-subtle group-hover:text-fg transition-colors flex items-center gap-1">
          {modelLabel(value)}
          <Caret />
        </span>
      }
    >
      {({ close }) => (
        <div className="p-1">
          <div className="px-2.5 pt-1.5 pb-1 flex items-baseline gap-2">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-subtle">
              {providerLabel(provider)}
            </span>
            <span className="text-[10.5px] text-subtle/70">
              当前会话仅支持本 provider 的模型
            </span>
          </div>
          {models.map((m, i) => {
            const active = value === m.id;
            // 跟随最新的别名在上，固定版本在下，中间隔一道线——两类的区别
            // （会不会自己变）正是选它时最该知道的事。
            const firstPinned = m.pinned && !models[i - 1]?.pinned;
            return (
              <Fragment key={m.id}>
                {firstPinned && (
                  <div className="mx-2.5 mt-1 mb-0.5 pt-2 border-t border-line text-[10.5px] text-subtle/70">
                    固定版本
                  </div>
                )}
                <button
                  onClick={() => {
                    onChange(m.id);
                    close();
                  }}
                  className="w-full flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md text-left hover:bg-fg/5 transition-colors"
                >
                  <div>
                    <div
                      className={`font-mono text-[12.5px] ${
                        active ? "text-fg" : "text-muted"
                      }`}
                    >
                      {m.label}
                    </div>
                    <div className="text-[10.5px] text-subtle mt-0.5">
                      {m.hint}
                    </div>
                  </div>
                  {active && (
                    <div className="w-1.5 h-1.5 rounded-full bg-blue" />
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

const Caret = () => (
  <svg
    width="8"
    height="8"
    viewBox="0 0 8 8"
    fill="none"
    className="opacity-60"
  >
    <path
      d="M2 3L4 5L6 3"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
