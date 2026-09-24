import { useEffect, useState } from "react";

/**
 * The viewer's current time, or null during SSR and the hydrating render.
 * The server renders in its own timezone (UTC in the Docker image) while
 * the browser renders in the viewer's, so anything that reads the clock
 * or the local timezone at render time (time-of-day greetings, "today")
 * must wait for this instead of calling `new Date()` directly — otherwise
 * the two renders disagree and React throws a hydration mismatch (#418).
 */
export function useClientNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  return now;
}
