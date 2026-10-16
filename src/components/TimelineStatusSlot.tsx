import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface TimelineStatusProps {
  statusSlot?: HTMLElement | null;
  statusMetaSlot?: HTMLElement | null;
  activityId?: string;
  onActivityChange?: (id: string, active: boolean) => void;
  onStatusClick?: () => void;
}

// 活动检测仍属于原思考组件；只把同一份状态展示搬到摘要，不再创建第二个时钟。
export function useTimelineActivity(active: boolean, id?: string, onChange?: TimelineStatusProps["onActivityChange"]) {
  useEffect(() => { if (id) onChange?.(id, active); }, [active, id, onChange]);
  useEffect(() => () => { if (id) onChange?.(id, false); }, [id, onChange]);
}

export function inTimelineSlot(content: ReactNode, slot?: HTMLElement | null, onClick?: () => void) {
  // Portal 沿 React 树冒泡，不经过视觉上的摘要按钮；主动转交点击，整行仍能展开。
  return slot ? createPortal(<span className="timeline-status-slot-content" onClick={onClick ? event => { event.stopPropagation(); onClick(); } : undefined}>{content}</span>, slot) : content;
}
