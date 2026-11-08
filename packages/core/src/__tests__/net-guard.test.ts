import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, isAddressAllowedForHost, assertOutboundUrlAllowed, guardedFetch, isRedirect, DisallowedOutboundUrlError } from "../net-guard";

describe("net-guard: address policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "198.18.0.1", // benchmarking
    "0.0.0.0",
    "224.0.0.1", // multicast
    "255.255.255.255",
    "::", // unspecified — connects to localhost on Linux
    "::1",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:169.254.169.254",
    "::127.0.0.1", // IPv4-compatible
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "2001:0:4136:e378::1", // Teredo
    "2001:db8::1", // documentation
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.215.14", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"])("allows public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("OUTBOUND_ALLOW_PRIVATE_HOSTS exempts a named host's private address, but never link-local", () => {
    const allow = new Set(["jira.corp.local"]);
    expect(isAddressAllowedForHost("jira.corp.local", "10.0.0.5", allow)).toBe(true);
    expect(isAddressAllowedForHost("JIRA.corp.local", "10.0.0.5", allow)).toBe(true);
    expect(isAddressAllowedForHost("jira.corp.local", "169.254.169.254", allow)).toBe(false);
    expect(isAddressAllowedForHost("other.corp.local", "10.0.0.5", allow)).toBe(false);
  });
});

describe("net-guard: URLs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "http://127.0.0.1/x",
    "http://[::1]/x",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0x7f000001/", // WHATWG URL normalizes to 127.0.0.1
    "http://2130706433/", // decimal form of 127.0.0.1
    "http://localhost:6379/",
    "file:///etc/passwd",
    "gopher://example.com/",
  ])("refuses %s before any request is made", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => assertOutboundUrlAllowed(url)).toThrow(DisallowedOutboundUrlError);
    await expect(guardedFetch(url)).rejects.toThrow(DisallowedOutboundUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("always sends redirect: manual and a guarded dispatcher, whatever the caller passed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await guardedFetch("https://example.com/hook", { method: "POST", redirect: "follow" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect(init.redirect).toBe("manual");
    expect(init.dispatcher).toBeDefined();
    expect(isRedirect(res)).toBe(true);
  });

  it("a hostname that resolves to loopback is refused at connect time (the DNS-rebinding defence), not just IP literals", async () => {
    // *.localtest.me is public DNS that answers 127.0.0.1 — exercises the
    // Agent's connect-time lookup (the DNS-rebinding defence), not the
    // IP-literal pre-check. Skips cleanly if this machine has no DNS.
    let resolvable = true;
    await import("node:dns/promises").then((d) => d.lookup("kompast.localtest.me")).catch(() => (resolvable = false));
    if (!resolvable) return;
    await expect(guardedFetch("http://kompast.localtest.me:59999/")).rejects.toThrow(DisallowedOutboundUrlError);
  });
});
