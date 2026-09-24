import type { HTMLAttributes } from "react";
import clsx from "clsx";

const WIDTHS = {
  narrow: "max-w-[560px]",
  standard: "max-w-[720px]",
  wide: "max-w-[880px]",
  reading: "max-w-[900px]",
  dense: "max-w-[1200px]",
  full: "max-w-none",
} as const;

export type PageContainerWidth = keyof typeof WIDTHS;

export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  width: PageContainerWidth;
}

/** Shared page chrome: one padding rhythm and a named content width. */
export function PageContainer({ width, className, ...props }: PageContainerProps) {
  return <div className={clsx("mx-auto w-full px-5 pb-16 pt-6 sm:px-8 sm:pt-8", WIDTHS[width], className)} {...props} />;
}
