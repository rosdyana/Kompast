import { type ButtonHTMLAttributes, forwardRef } from "react";
import clsx from "clsx";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "subtle" | "dark" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const base =
  "inline-flex flex-none select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-medium transition-[background-color,border-color,color,box-shadow] duration-100 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] hover:bg-accent-hover active:bg-accent",
  secondary: "bg-surface-3 text-text hover:bg-surface-4",
  outline: "border border-border-2 bg-surface text-text hover:bg-surface-2 active:bg-surface-3",
  ghost: "text-text-2 hover:bg-surface-3 hover:text-text active:bg-surface-4",
  subtle: "text-accent-text hover:bg-accent-soft",
  dark: "bg-text text-bg hover:opacity-90",
  danger: "bg-danger text-white hover:opacity-90",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[12px]",
  sm: "h-7 px-2.5 text-[13px]",
  md: "h-8 px-3 text-[14px]",
  lg: "h-10 px-4 text-[14px]",
};

const iconSizes: Record<ButtonSize, string> = {
  xs: "h-6 w-6",
  sm: "h-7 w-7",
  md: "h-8 w-8",
  lg: "h-10 w-10",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square, icon-only button — pass an aria-label. */
  icon?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "outline", size = "md", icon = false, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={clsx(base, variants[variant], icon ? clsx(iconSizes[size], "px-0") : sizes[size], className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

/** Icon-only ghost button — the toolbar/row-action workhorse. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "icon">>(
  ({ variant = "ghost", size = "sm", ...props }, ref) => <Button ref={ref} variant={variant} size={size} icon {...props} />,
);
IconButton.displayName = "IconButton";
