import type { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

/** Bordered surface for grouped content (settings sections, panels). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("rounded-[10px] border border-border bg-surface", className)} {...props} />;
}

/** Card header row: title on the left, actions on the right. */
export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex items-start gap-3 border-b border-border px-4 py-3", className)}>
      <div className="min-w-0 flex-1">
        <h2 className="type-headline">{title}</h2>
        {description && <p className="mt-0.5 type-small text-text-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
    </div>
  );
}
