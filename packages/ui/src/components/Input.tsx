import { type InputHTMLAttributes, forwardRef } from "react";
import clsx from "clsx";
import { Search } from "lucide-react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={clsx(
        "min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none placeholder:text-text-3",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export function SearchField({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div
      className={clsx(
        "flex items-center gap-1.5 rounded-[7px] border border-border bg-surface px-2.5 py-1.5",
        className,
      )}
    >
      <Search size={15} strokeWidth={1.75} className="flex-none text-text-3" />
      <Input {...props} />
    </div>
  );
}
