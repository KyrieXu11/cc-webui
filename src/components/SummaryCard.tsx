interface Props {
  title: string;
  body: string;
  delay?: number;
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i} className="text-fg font-semibold font-mono text-[13.5px]">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

export default function SummaryCard({ title, body, delay = 0 }: Props) {
  return (
    <div
      className="msg-enter bg-surface border border-line-strong rounded-lg p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1 h-4 rounded-sm bg-blue/70" />
        <div className="text-[15px] font-semibold text-fg tracking-tight">
          {title}
        </div>
      </div>
      <div className="text-[14px] leading-[1.85] text-muted">
        {body.split("\n").map((line, i) => (
          <p key={i} className="mb-2 last:mb-0">
            {renderInline(line)}
          </p>
        ))}
      </div>
    </div>
  );
}
