/**
 * Fetch a user-supplied URL without turning the API into a proxy into our own network.
 *
 * Why this exists (security audit, 2026-10-28): `/admin/link-preview` and `/hr/preview`
 * fetched ANY URL a signed-in caller named, followed redirects, and read the body with no
 * size cap after the timeout had already been cleared. That allowed:
 *   - SSRF: `http://127.0.0.1:4000/…`, other local ports, the 169.254.169.254 metadata
 *     address, or a public URL that redirects to any of them;
 *   - memory exhaustion: a server that sends headers then streams forever grew the API
 *     process until pm2 or the kernel killed it, taking every portal down.
 *
 * Rules enforced here, on the first URL AND every redirect hop:
 *   - http or https only, default ports only (80 / 443);
 *   - the host must resolve, and EVERY address it resolves to must be public
 *     (loopback, private, link-local, CGNAT, multicast, reserved and IPv6 ULA refused);
 *   - at most `maxRedirects` hops, followed manually;
 *   - the whole exchange, body included, is bounded by `timeoutMs`, and reading stops at
 *     `maxBytes`.
 *
 * Known limit: the address is checked by our own lookup and fetch resolves again, so a
 * DNS answer that changes between the two (rebinding) is not caught. Closing that needs a
 * custom connect-time lookup; the checks here stop the direct and redirect forms.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True only for an address that is safe to connect to from the server. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED_V4.some(([base, bits]) => inV4(ip, base, bits));
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / translated forms: judge the embedded IPv4 address.
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (lower === "::" || lower === "::1") return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    if (lower.startsWith("2001:db8")) return false; // documentation
    return true;
  }
  return false;
}

/** Parse and check a URL; throws BlockedUrlError when it may not be fetched. */
export async function assertPublicHttpUrl(raw: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new BlockedUrlError("Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Only http(s) URLs");
  if (url.port && url.port !== "80" && url.port !== "443") throw new BlockedUrlError("Only default ports");
  if (url.username || url.password) throw new BlockedUrlError("Credentials in URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BlockedUrlError("Missing host");
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new BlockedUrlError("Host does not resolve");
    }
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new BlockedUrlError("Host is not a public address");
  }
  return url;
}

export type PublicFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
};

/**
 * GET a public URL and return at most `maxBytes` of its body as text.
 * Throws BlockedUrlError for a refused URL or redirect; other errors propagate.
 */
export async function fetchPublicText(raw: string, opts: PublicFetchOptions = {}): Promise<{ url: string; status: number; text: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 50_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = await assertPublicHttpUrl(raw);
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, { signal: controller.signal, redirect: "manual", headers: opts.headers });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= maxRedirects) throw new BlockedUrlError("Too many redirects");
        url = await assertPublicHttpUrl(new URL(res.headers.get("location")!, url));
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body) {
        const reader = res.body.getReader();
        while (size < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
        }
        await reader.cancel().catch(() => undefined);
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes);
      return { url: url.toString(), status: res.status, text: buf.toString("utf8") };
    }
  } finally {
    clearTimeout(timer);
  }
}
