import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { loadEnv } from "@kompast/env";

/**
 * Global request middleware for every request Start handles (pages, server
 * functions, /api routes).
 *
 * CSRF: TanStack Start only applies its default CSRF middleware to server
 * functions when the project has NO start instance of its own
 * (start-server-core's createStartHandler: `startInstance ?
 * startOptions.requestMiddleware : [defaultCsrfMiddleware]`). Defining this
 * file therefore removes it unless it is listed here explicitly — keep
 * csrfMiddleware first.
 *
 * Security headers are set here, not only at the reverse proxy, so a
 * bring-your-own-proxy deployment still gets them. A header a route already
 * set (e.g. the sandbox CSP on /api/storage/download) is left alone.
 */
const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Built once per process from env (APP_URL, COLLAB_WS_URL, GCS_BUCKET are
 * fixed for the process lifetime).
 *
 * ENFORCED: directives that can't break rendering — framing, plugins,
 * <base> hijacking, form targets.
 *
 * REPORT-ONLY (`fullPolicy`): the complete source allow-list. It has not
 * been verified against every editor feature in a real browser yet
 * (BlockNote inline styles, Google Fonts, the collab socket, GCS uploads,
 * TanStack's inline hydration scripts — which is also why script-src still
 * needs 'unsafe-inline': a per-request nonce via the router's
 * `ssr.nonce` is the follow-up). Violations show in the browser console;
 * once a release runs clean, move it to the enforced header.
 */
function buildHeaders(): Record<string, string> {
  const env = loadEnv();
  const collabOrigin = originOf(env.COLLAB_WS_URL);
  const isHttps = env.APP_URL.startsWith("https://");

  const enforced = ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join("; ");

  const connectSrc = ["'self'", collabOrigin, env.GCS_BUCKET ? "https://storage.googleapis.com" : null].filter(Boolean).join(" ");
  const fullPolicy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    // Doc images can be any https URL a user pasted or a Notion import kept.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    `connect-src ${connectSrc}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    enforced,
  ].join("; ");

  return {
    "Content-Security-Policy": enforced,
    "Content-Security-Policy-Report-Only": fullPolicy,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...(isHttps ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

let securityHeaders: Record<string, string> | undefined;

const securityHeadersMiddleware = createMiddleware({ type: "request" }).server(async ({ next }) => {
  const result = await next();
  securityHeaders ??= buildHeaders();
  let { response } = result;
  try {
    for (const [name, value] of Object.entries(securityHeaders)) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
  } catch {
    // Immutable headers (e.g. a Response passed through from fetch()) — copy into a new Response.
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(securityHeaders)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return { ...result, response };
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, securityHeadersMiddleware],
}));
