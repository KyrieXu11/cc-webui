import type { ImageAttachment } from "../lib/types";

export default function UserBubble({
  text,
  images,
  delay = 0,
}: {
  text: string;
  images?: ImageAttachment[];
  delay?: number;
}) {
  const hasText = text.trim().length > 0;
  const hasImages = images && images.length > 0;

  return (
    <div
      className="flex justify-end msg-enter"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="max-w-[78%] bg-blue text-white px-4 py-2.5 rounded-2xl text-[14.5px] leading-[1.6] flex flex-col gap-2">
        {hasImages && (
          <div className="flex flex-wrap gap-1.5">
            {images!.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name ?? `image-${i + 1}`}
                className="max-w-[220px] max-h-[220px] rounded-lg object-cover border border-white/20"
              />
            ))}
          </div>
        )}
        {hasText && <div className="whitespace-pre-wrap break-words">{text}</div>}
      </div>
    </div>
  );
}
