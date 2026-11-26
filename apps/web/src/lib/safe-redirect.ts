/**
 * Where /login may send someone after sign-in. Only a same-origin path is
 * accepted ("/s/abc", "/docs/x?y=1"); anything that a browser could read as
 * another origin ("//evil.test", "/\evil.test", "https://…", control
 * characters) is dropped, so `?redirect=` can't become an open redirect.
 */
export function safeRedirectPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//") || value.startsWith("/\\")) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value, "http://kompast.invalid");
    if (url.origin !== "http://kompast.invalid") return undefined;
    return url.pathname + url.search + url.hash;
  } catch {
    return undefined;
  }
}
