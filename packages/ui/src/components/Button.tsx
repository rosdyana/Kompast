import { type ButtonHTMLAttributes, forwardRef } from "react";
import clsx from "clsx";

type Variant = "primary" | "dark" | "outline" | "ghost";

const base =
  "inline-flex items-center justify-center gap-2 rounded-[7px] text-[13px] font-medium transition-opacity disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white font-semibold hover:opacity-90",
  dark: "bg-text text-bg font-semibold hover:opacity-90",
  outline: "border border-border-2 bg-surface text-text-2 hover:bg-surface-3",
  ghost: "text-text-2 hover:bg-surface-3",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "outline", ...props }, ref) => (
    <button
      ref={ref}
      className={clsx(base, variants[variant], "px-3 py-1.5", className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
