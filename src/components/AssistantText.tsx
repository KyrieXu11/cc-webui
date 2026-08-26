import Markdown from "./Markdown";

export default function AssistantText({
  text,
  delay = 0,
}: {
  text: string;
  delay?: number;
}) {
  return (
    <div
      className="msg-enter text-[14.5px] leading-[1.8] text-fg max-w-[94%] md-body"
      style={{ animationDelay: `${delay}ms` }}
    >
      <Markdown text={text} />
    </div>
  );
}
