import { useState, type ReactNode } from "react";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";

/** Confirmation step for destructive actions (revoke, remove, transfer). */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => Promise<void> | void;
  destructive?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      closeLabel={cancelLabel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} onClick={confirm} disabled={busy} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <p className="type-body text-text-2">{body}</p>}
      {error && <p className="mt-3 rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
}
