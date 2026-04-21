import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  trigger: ReactNode;
  align?: "left" | "right";
  direction?: "down" | "up";
  width?: number;
  triggerClassName?: string;
  children: (api: { close: () => void }) => ReactNode;
}

export default function Popover({
  trigger,
  align = "left",
  direction = "down",
  width = 240,
  triggerClassName,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={
          triggerClassName ?? "inline-flex items-center focus:outline-none"
        }
      >
        {trigger}
      </button>
      {open && (
        <div
          style={{ minWidth: width }}
          className={`absolute z-50 ${align === "left" ? "left-0" : "right-0"} ${
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2"
          } bg-surface border border-line-strong rounded-lg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)]`}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}
