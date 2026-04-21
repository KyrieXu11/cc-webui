export default function UserBubble({
  text,
  delay = 0,
}: {
  text: string;
  delay?: number;
}) {
  return (
    <div
      className="flex justify-end msg-enter"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="max-w-[78%] bg-blue text-white px-4 py-2.5 rounded-2xl text-[14.5px] leading-[1.6]">
        {text}
      </div>
    </div>
  );
}
