import dns from "node:dns";
import net from "node:net";
import { Agent } from "undici";
import { loadEnv } from "@kompast/env";

/**
 * Outbound-request guard for every fetch whose target a user (not the
 * operator) chooses: automation webhooks and JIRA sites/attachments. The
 * request originates from the server's own network position, so without
 * this a user can reach loopback services, the cloud metadata endpoint
 * (169.254.169.254), Postgres/Redis on the private network, etc.
 *
 * How it holds:
 *  - IP-literal URLs are checked before the request is sent.
 *  - Hostnames are checked at CONNECT time, inside the undici Agent's
 *    `lookup`: every address the name resolves to must be allowed, and the
 *    socket connects to that same vetted address. Checking once up front
 *    and then letting fetch resolve again would be open to DNS rebinding
 *    (first answer public, second answer 127.0.0.1).
 *  - `redirect: "manual"` always — a 3xx could point anywhere, and
 *    following it would skip the check. Callers treat 3xx as a failure
 *    (see isRedirect).
 *
 * Address policy is an allow-list, so anything unusual fails closed:
 * IPv4 must be outside the special-purpose ranges below; IPv6 must be
 * global unicast (2000::/3) and not 6to4 / Teredo / documentation — which
 * also excludes ::, ::1, fe80::/10, fc00::/7, multicast, IPv4-mapped
 * (::ffff:0:0/96), IPv4-compatible, and NAT64 (64:ff9b::/96), since none
 * of those are in 2000::/3.
 *
 * OUTBOUND_ALLOW_PRIVATE_HOSTS (comma-separated hostnames) exempts named
 * hosts from the private-range rule, for an on-prem JIRA on the internal
 * network. Link-local (incl. the metadata endpoint) is never exempt.
 *
 * Tests stub globalThis.fetch (CLAUDE.md: never real third-party HTTP), so
 * the Agent's lookup never runs there; the IP-literal check still does.
 */

export class DisallowedOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisallowedOutboundUrlError";
  }
}

const blockedV4 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (often routes internally)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}

const linkLocal = new net.BlockList();
linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
linkLocal.addSubnet("fe80::", 10, "ipv6");

const globalUnicastV6 = new net.BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");
const blockedInsideGlobalV6 = new net.BlockList();
blockedInsideGlobalV6.addSubnet("2001::", 32, "ipv6"); // Teredo (tunnels to arbitrary IPv4)
blockedInsideGlobalV6.addSubnet("2001:db8::", 32, "ipv6"); // documentation
blockedInsideGlobalV6.addSubnet("2002::", 16, "ipv6"); // 6to4 (embeds an IPv4 address)

/** Whether an IP address is a public, routable destination. Exported for tests. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return globalUnicastV6.check(address, "ipv6") && !blockedInsideGlobalV6.check(address, "ipv6");
  return false; // not an IP at all — fail closed
}

function isLinkLocal(address: string): boolean {
  const family = net.isIP(address);
  return family === 4 ? linkLocal.check(address, "ipv4") : family === 6 ? linkLocal.check(address, "ipv6") : true;
}

function privateHostAllowList(): Set<string> {
  const raw = loadEnv().OUTBOUND_ALLOW_PRIVATE_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether `address` (what `hostname` resolved to, or the literal itself) may be connected to. Exported for tests. */
export function isAddressAllowedForHost(hostname: string, address: string, allowPrivate: Set<string> = privateHostAllowList()): boolean {
  if (isPublicAddress(address)) return true;
  return allowPrivate.has(hostname.toLowerCase()) && !isLinkLocal(address);
}

/** URL brackets IPv6 literals ("[::1]"); net.isIP doesn't accept the brackets. */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * The connect-time check. Resolves every address, refuses if ANY is
 * disallowed (a name with one public and one internal answer is not
 * trustworthy), and hands the socket the vetted address.
 */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, family: typeof options === "object" ? options.family : undefined }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const bad = addresses.find((a) => !isAddressAllowedForHost(hostname, a.address));
    if (bad || addresses.length === 0) {
      return callback(new DisallowedOutboundUrlError(`${hostname} resolves to a disallowed address`), "", 4);
    }
    const first = addresses[0]!;
    if (typeof options === "object" && options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
    callback(null, first.address, first.family);
  });
};

let agent: Agent | null = null;
function guardedAgent(): Agent {
  agent ??= new Agent({ connect: { lookup: guardedLookup } });
  return agent;
}

/** Throws DisallowedOutboundUrlError unless `rawUrl` is http(s) and, if its host is an IP literal, that IP is allowed. */
export function assertOutboundUrlAllowed(rawUrl: string | URL): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DisallowedOutboundUrlError(`Only http(s) URLs are allowed, got ${url.protocol}`);
  const host = bareHostname(url);
  if (net.isIP(host) && !isAddressAllowedForHost(host, host)) throw new DisallowedOutboundUrlError(`${host} is a disallowed address`);
  if (host === "localhost" || host.endsWith(".localhost")) throw new DisallowedOutboundUrlError(`${host} is a disallowed address`);
  return url;
}

/**
 * fetch() for user-chosen targets. Same signature as fetch; always
 * `redirect: "manual"` (check isRedirect on the result). A connect-time
 * refusal surfaces as DisallowedOutboundUrlError rather than undici's
 * generic "fetch failed".
 */
export async function guardedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = assertOutboundUrlAllowed(input);
  try {
    // Forward the input in the form the caller gave it (string or URL) — only the check needs the parsed URL.
    return await globalThis.fetch(typeof input === "string" ? input : url, { ...init, redirect: "manual", dispatcher: guardedAgent() } as RequestInit);
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof DisallowedOutboundUrlError) throw cause;
    throw err;
  }
}

/** Node's fetch returns a manual-mode 3xx as-is (status intact); an opaqueredirect type is kept in case that ever changes. */
export function isRedirect(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}
