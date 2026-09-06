import { useCallback, useRef, useState } from "react";

/**
 * Two-click "arm then confirm" pattern for destructive list-row actions
 * (column/property/automation-rule delete), used instead of window.confirm()
 * so the confirmation stays inside the page's own hand-styled surface: the
 * first click arms the row (a timeout disarms it automatically), the second
 * click within that window performs the actual delete.
 */
export function useConfirmArm(resetMs = 3000) {
  const [armedId, setArmedId] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = useCallback(
    (id: string) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setArmedId(id);
      timeoutRef.current = setTimeout(() => setArmedId((cur) => (cur === id ? null : cur)), resetMs);
    },
    [resetMs],
  );

  const disarm = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setArmedId(null);
  }, []);

  const isArmed = useCallback((id: string) => armedId === id, [armedId]);

  return { isArmed, arm, disarm };
}
