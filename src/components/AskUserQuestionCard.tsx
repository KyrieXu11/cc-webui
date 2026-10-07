import { useState } from "react";

// AskUserQuestion 不是一个「要不要放行」的请求，是模型在**问你问题**。
//
// 之前它走通用权限卡：input 被当成 JSON 原样倒出来，四个按钮问你允不允许——
// 而点「允许」只是放行，没有人回答问题，CLI 于是返回
// "The user did not answer the questions."（实测 2.1.240）。
// 答案要通过工具 input 里的 `answers` 字段回传（key = 问题原文，value = 选项
// label），这正是它 schema 里写的 "collected by the permission component"。
type Option = { label: string; description?: string };
type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Option[];
};

const OTHER = "__other__";

export function parseQuestions(input: Record<string, any>): Question[] {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is Question => !!q && typeof q.question === "string",
  );
}

interface Props {
  questions: Question[];
  locked: boolean;
  resolvedLabel?: string;
  delay?: number;
  onSubmit: (answers: Record<string, string>) => void;
  onSkip: () => void;
}

export default function AskUserQuestionCard({
  questions,
  locked,
  resolvedLabel,
  delay = 0,
  onSubmit,
  onSkip,
}: Props) {
  // 每题一份选择：单选存一个 label，多选存一组。"其他" 用 OTHER 占位，
  // 真正的文本放在 custom 里。
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((p) => {
      const cur = p[qi] ?? [];
      if (!multi) return { ...p, [qi]: cur[0] === label ? [] : [label] };
      return {
        ...p,
        [qi]: cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label],
      };
    });
  };

  const answerFor = (qi: number): string => {
    const cur = picked[qi] ?? [];
    return cur
      .map((l) => (l === OTHER ? custom[qi]?.trim() || "" : l))
      .filter(Boolean)
      .join("，");
  };

  const complete = questions.every((_, i) => answerFor(i).length > 0);

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const a = answerFor(i);
      if (a) answers[q.question] = a;
    });
    onSubmit(answers);
  };

  return (
    <div
      className="msg-enter rounded-panel p-5 bg-wash border border-blue/25"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2 mb-4">
        <div className="text-[10.5px] font-mono text-blue uppercase tracking-[0.1em]">
          请选择
        </div>
        {locked && (
          <span className="ml-auto font-mono text-[10.5px] text-subtle">
            {resolvedLabel ?? "已失效"}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-5">
        {questions.map((q, qi) => {
          const multi = q.multiSelect === true;
          const cur = picked[qi] ?? [];
          return (
            <div key={qi}>
              <div className="flex items-baseline gap-2 mb-2.5">
                {q.header && (
                  <span className="shrink-0 text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded bg-blue/12 text-blue">
                    {q.header}
                  </span>
                )}
                <span className="text-[13.5px] text-fg leading-relaxed">
                  {q.question}
                </span>
                {multi && (
                  <span className="text-[11px] text-subtle shrink-0">可多选</span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                {(q.options ?? []).map((o) => {
                  const on = cur.includes(o.label);
                  return (
                    <button
                      key={o.label}
                      disabled={locked}
                      onClick={() => toggle(qi, o.label, multi)}
                      className={`text-left px-3 py-2 rounded-md border transition-colors ${
                        on
                          ? "bg-blue/12 border-blue/50"
                          : locked
                            ? "bg-transparent border-fg/5 cursor-default"
                            : "bg-canvas/50 border-fg/10 hover:border-fg/25 hover:bg-raised"
                      }`}
                    >
                      <div
                        className={`text-[13px] ${on ? "text-fg" : "text-muted"}`}
                      >
                        {o.label}
                      </div>
                      {o.description && (
                        <div className="text-[11.5px] text-subtle leading-relaxed mt-0.5">
                          {o.description}
                        </div>
                      )}
                    </button>
                  );
                })}

                <button
                  disabled={locked}
                  onClick={() => toggle(qi, OTHER, multi)}
                  className={`text-left px-3 py-2 rounded-md border transition-colors text-[13px] ${
                    cur.includes(OTHER)
                      ? "bg-blue/12 border-blue/50 text-fg"
                      : locked
                        ? "bg-transparent border-fg/5 text-subtle cursor-default"
                        : "bg-canvas/50 border-fg/10 text-muted hover:border-fg/25 hover:bg-raised"
                  }`}
                >
                  其他（自己写）
                </button>
                {cur.includes(OTHER) && !locked && (
                  <input
                    autoFocus
                    value={custom[qi] ?? ""}
                    onChange={(e) =>
                      setCustom((m) => ({ ...m, [qi]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && complete) submit();
                    }}
                    placeholder="你的答案…"
                    className="h-9 px-3 rounded-md bg-canvas/50 border border-fg/10 text-[12.5px] text-fg placeholder:text-subtle focus:outline-none focus:border-blue/50"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!locked && (
        <div className="flex items-center gap-2 mt-5">
          <button
            disabled={!complete}
            onClick={submit}
            className="px-3.5 h-8 rounded-md text-[12.5px] border transition-all bg-blue border-blue text-on-brand disabled:opacity-35 disabled:cursor-not-allowed"
          >
            提交
          </button>
          <button
            onClick={onSkip}
            className="px-3 h-8 rounded-md text-[12.5px] border border-fg/10 text-muted hover:text-fg hover:border-fg/25 transition-colors"
          >
            跳过
          </button>
          <span className="text-[11.5px] text-subtle ml-auto">
            答案会作为工具结果回给模型
          </span>
        </div>
      )}
    </div>
  );
}
