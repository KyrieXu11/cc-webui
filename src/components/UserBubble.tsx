import type { ImageAttachment } from "../lib/types";
import { splitAttachments } from "../lib/attachments";

interface Props {
  text: string;
  images?: ImageAttachment[];
  delay?: number;
  onPreviewImage?: (img: ImageAttachment, label: string) => void;
}

export default function UserBubble({
  text,
  images,
  delay = 0,
  onPreviewImage,
}: Props) {
  // 非图片附件是以「附件：- 路径 (名字)」写在正文里发给 agent 的（它要靠路径去读），
  // 气泡里只显示文件名卡片，完整路径放在悬停提示里。历史消息是同一段正文，一样处理。
  const { files, body } = splitAttachments(text);
  const hasText = body.trim().length > 0;
  const hasImages = images && images.length > 0;

  const triggerPreview = (img: ImageAttachment, i: number) => {
    const label = img.name ?? `image-${i + 1}`;
    onPreviewImage?.(img, label);
  };

  return (
    <div
      className="flex justify-end msg-enter"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="user-bubble max-w-[78%] max-md:max-w-[90%] px-4 py-3 text-[14.5px] leading-[1.6] flex flex-col gap-2">
        {hasImages && (
          <div className="flex flex-wrap gap-1.5">
            {images!.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name ?? `image-${i + 1}`}
                title={`${img.name ?? `image-${i + 1}`}\n(单击预览)`}
                onClick={(e) => {
                  e.preventDefault();
                  triggerPreview(img, i);
                }}
                onContextMenu={(e) => {
                  if (e.ctrlKey) {
                    e.preventDefault();
                    triggerPreview(img, i);
                  }
                }}
                className="max-w-[220px] max-h-[220px] rounded-panel object-cover border border-line-strong cursor-zoom-in hover:brightness-105 transition"
              />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <span
                key={f.path}
                title={f.path}
                className="user-attachment inline-flex items-center gap-1.5 max-w-full px-2.5 py-1.5 text-[12.5px] leading-tight"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 opacity-80">
                  <path
                    d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4.2-4.2"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="truncate">{f.name}</span>
              </span>
            ))}
          </div>
        )}
        {hasText && <div className="whitespace-pre-wrap break-words">{body}</div>}
      </div>
    </div>
  );
}
