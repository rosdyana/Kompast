import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { CheckCircle2, AlertCircle, X } from "lucide-react";

export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  tone?: "success" | "error" | "info";
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<{ show: (t: ToastInput) => void }>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

/** Bottom-left transient confirmations ("KPT-12 created · View"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.durationMs ?? 5000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {mounted &&
        createPortal(
          <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-4 z-[80] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
            {items.map((t) => (
              <div
                key={t.id}
                role="status"
                className="kp-anim-pop pointer-events-auto flex items-start gap-2.5 rounded-[8px] border border-border bg-surface px-3 py-2.5 text-text shadow-kp"
              >
                {t.tone === "error" ? (
                  <AlertCircle size={17} strokeWidth={2} className="mt-px flex-none text-danger" />
                ) : (
                  <CheckCircle2 size={17} strokeWidth={2} className={clsx("mt-px flex-none", t.tone === "info" ? "text-accent" : "text-green")} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium leading-snug">{t.title}</p>
                  {t.description && <p className="mt-0.5 text-[12.5px] leading-snug text-text-2">{t.description}</p>}
                </div>
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                    className="flex-none rounded-[5px] px-1.5 py-0.5 text-[13px] font-medium text-accent-text hover:bg-accent-soft"
                  >
                    {t.action.label}
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismiss(t.id)}
                  className="grid h-5 w-5 flex-none place-items-center rounded text-text-3 hover:bg-surface-3 hover:text-text"
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}
