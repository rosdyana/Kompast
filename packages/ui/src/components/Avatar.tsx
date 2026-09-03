import clsx from "clsx";
import type { BadgeTone } from "./Badge";

const bgByTone: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-text-3",
  accent: "bg-accent-soft text-accent",
  indigo: "bg-indigo-soft text-indigo",
  green: "bg-green-soft text-green",
  amber: "bg-amber-soft text-amber",
  violet: "bg-violet-soft text-violet",
};

export interface AvatarProps {
  initials: string;
  tone?: BadgeTone;
  size?: number;
  title?: string;
  className?: string;
}

export function Avatar({ initials, tone = "violet", size = 22, title, className }: AvatarProps) {
  return (
    <div
      title={title}
      className={clsx(
        "grid flex-none place-items-center rounded-full text-[9.5px] font-bold",
        bgByTone[tone],
        className,
      )}
      style={{ width: size, height: size }}
    >
      {initials}
    </div>
  );
}
