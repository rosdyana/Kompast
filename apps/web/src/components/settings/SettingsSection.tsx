import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Titled settings area: heading + description on top, content below. */
export function SettingsSection({
  title,
  description,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-10 last:mb-0", className)}>
      <div className="mb-4 flex flex-wrap items-start gap-3 border-b border-border pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="type-headline text-[17px]">{title}</h2>
          {description && <p className="mt-1 max-w-[640px] type-body text-text-2">{description}</p>}
        </div>
        {aside && <div className="flex flex-none items-center gap-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export { Switch } from "@kompast/ui/Switch";
