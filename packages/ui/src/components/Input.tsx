import { type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes, type ReactNode, forwardRef } from "react";
import clsx from "clsx";
import { Search, X } from "lucide-react";

/** Bare, borderless input — for use inside a wrapper that draws the frame. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={clsx("min-w-0 flex-1 border-none bg-transparent text-[14px] outline-none placeholder:text-text-3", className)}
    {...props}
  />
));
Input.displayName = "Input";

/** Standard bordered text field. */
export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={clsx("kp-input", className)} {...props} />
));
TextField.displayName = "TextField";

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={clsx("kp-input", className)} {...props} />
));
TextArea.displayName = "TextArea";

export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={clsx("kp-input kp-select", className)} {...props} />
));
NativeSelect.displayName = "NativeSelect";

/** Label + control + optional hint/error, stacked. */
export function FormField({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
  required?: boolean;
}) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-text-2">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : hint ? <p className="text-[12.5px] text-text-3">{hint}</p> : null}
    </div>
  );
}

export const SearchField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { wrapperClassName?: string; onClear?: () => void; clearLabel?: string }
>(({ className, wrapperClassName, onClear, clearLabel = "Clear", value, ...props }, ref) => (
  <div
    className={clsx(
      "flex h-8 items-center gap-2 rounded-[6px] border border-border-2 bg-surface px-2.5 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft)] hover:border-text-3",
      wrapperClassName,
      className,
    )}
  >
    <Search size={15} strokeWidth={2} className="flex-none text-text-3" />
    <Input ref={ref} value={value} {...props} />
    {onClear && value ? (
      <button type="button" onClick={onClear} aria-label={clearLabel} className="grid h-5 w-5 flex-none place-items-center rounded text-text-3 hover:text-text">
        <X size={14} strokeWidth={2} />
      </button>
    ) : null}
  </div>
));
SearchField.displayName = "SearchField";
