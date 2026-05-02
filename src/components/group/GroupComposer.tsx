import {
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const TARGETS = ["all", "claude", "codex"] as const;
type Target = (typeof TARGETS)[number];

const TARGET_HINTS: Record<Target, string> = {
  all: "流水线协作（按 pipeline 顺序）",
  claude: "只发给 Claude",
  codex: "只发给 Codex",
};

type Props = {
  running: boolean;
  onSend: (text: string, recipients: Target[]) => void;
  onStop: () => void;
};

export default function GroupComposer({ running, onSend, onStop }: Props) {
  const [value, setValue] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [menuFilter, setMenuFilter] = useState("");
  const [menuIdx, setMenuIdx] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const filtered = useMemo(
    () => TARGETS.filter((t) => t.startsWith(menuFilter.toLowerCase())),
    [menuFilter],
  );

  useEffect(() => {
    if (filtered.length > 0 && menuIdx >= filtered.length) {
      setMenuIdx(filtered.length - 1);
    }
  }, [filtered.length, menuIdx]);

  const insertMention = (target: Target) => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const atIdx = before.lastIndexOf("@");
    const newBefore = atIdx >= 0 ? before.slice(0, atIdx) : before;
    const insert = `@${target} `;
    const next = newBefore + insert + after;
    setValue(next);
    setShowMenu(false);
    setMenuFilter("");
    queueMicrotask(() => {
      ta.focus();
      const newPos = newBefore.length + insert.length;
      ta.selectionStart = newPos;
      ta.selectionEnd = newPos;
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    const pos = e.target.selectionStart;
    const before = v.slice(0, pos);
    const m = before.match(/@([a-z]*)$/);
    if (m) {
      setShowMenu(true);
      setMenuFilter(m[1]);
      setMenuIdx(0);
    } else {
      setShowMenu(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMenu && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(filtered[menuIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMenu(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // First @<target> at the start of message determines recipients;
  // body is everything after it (so Claude/Codex don't see the @ tag).
  const parse = (
    raw: string,
  ): { text: string; recipients: Target[] } => {
    const trimmed = raw.replace(/^\s+/, "");
    const m = trimmed.match(/^@(claude|codex|all)(\s+|$)/i);
    if (!m) {
      return { text: raw.trim(), recipients: ["all"] };
    }
    const target = m[1].toLowerCase() as Target;
    return {
      text: trimmed.slice(m[0].length).trim(),
      recipients: [target],
    };
  };

  const submit = () => {
    if (running) return;
    if (!value.trim()) return;
    const { text, recipients } = parse(value);
    if (!text) return;
    onSend(text, recipients);
    setValue("");
  };

  return (
    <div className="border-t border-soft px-3 pt-2 pb-2 relative bg-canvas">
      {showMenu && filtered.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 bg-surface border border-soft rounded shadow-lg z-10 min-w-[200px]">
          {filtered.map((t, i) => (
            <div
              key={t}
              onClick={() => insertMention(t)}
              className={`px-3 py-1.5 cursor-pointer text-[13px] flex justify-between gap-3 ${
                i === menuIdx ? "bg-zinc-700/40" : ""
              }`}
            >
              <span className="font-mono">@{t}</span>
              <span className="text-subtle text-[11px]">{TARGET_HINTS[t]}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKey}
        placeholder="@all (流水线) / @claude / @codex …  ↵ 发送，⇧↵ 换行"
        rows={3}
        disabled={running}
        className="w-full bg-surface border border-soft rounded px-3 py-2 resize-none focus:outline-none focus:border-blue text-[14px] disabled:opacity-50"
      />
      <div className="flex justify-end mt-1.5">
        {running ? (
          <button
            onClick={onStop}
            type="button"
            className="px-4 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-[13px]"
          >
            ■ 停止
          </button>
        ) : (
          <button
            onClick={submit}
            type="button"
            disabled={!value.trim()}
            className="px-4 py-1 bg-blue hover:opacity-90 text-white rounded text-[13px] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↑ 发送
          </button>
        )}
      </div>
    </div>
  );
}
