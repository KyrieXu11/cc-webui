import Popover from "./Popover";
import {
  availableEffortOptions,
  effortLabel,
  type EffortLevel,
} from "../lib/settings";

interface Props {
  value: EffortLevel;
  onChange: (v: EffortLevel) => void;
  model: string;
}

export default function EffortSelector({ value, onChange, model }: Props) {
  const options = availableEffortOptions(model);
  return (
    <Popover
      align="left"
      direction="up"
      width={220}
      triggerClassName="inline-flex items-center focus:outline-none rounded px-1.5 py-0.5 hover:bg-fg/5 transition-colors group"
      trigger={
        <span className="font-mono text-[11px] text-subtle group-hover:text-fg transition-colors flex items-center gap-1">
          {effortLabel(value)}
          <Caret />
        </span>
      }
    >
      {({ close }) => (
        <div className="p-1">
          {options.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                onChange(m.id);
                close();
              }}
              className="w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-md text-left hover:bg-fg/5 transition-colors"
            >
              <div>
                <div
                  className={`font-mono text-[12.5px] ${
                    value === m.id ? "text-fg" : "text-muted"
                  }`}
                >
                  {m.label}
                </div>
                <div className="text-[10.5px] text-subtle mt-0.5">{m.hint}</div>
              </div>
              {value === m.id && (
                <div className="w-1.5 h-1.5 rounded-full bg-blue" />
              )}
            </button>
          ))}
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
