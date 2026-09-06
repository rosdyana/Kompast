import type { HTMLAttributes } from "react";
import clsx from "clsx";

const WIDTHS = {
  narrow: "max-w-[520px]",
  standard: "max-w-[640px]",
  wide: "max-w-[760px]",
  reading: "max-w-[820px]",
  dense: "max-w-[1080px]",
} as const;

export type PageContainerWidth = keyof typeof WIDTHS;

export interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  width: PageContainerWidth;
}

/**
 * Shared page chrome: one horizontal/vertical padding rhythm (px-8 pt-9
 * pb-16) and one of five named content widths, so a page's reading measure
 * is a deliberate choice instead of an accidental one-off pixel value.
 */
export function PageContainer({ width, className, ...props }: PageContainerProps) {
  return <div className={clsx("mx-auto px-8 pb-16 pt-9", WIDTHS[width], className)} {...props} />;
}
