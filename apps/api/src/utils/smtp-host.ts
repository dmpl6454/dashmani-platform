import { promises as dns } from "node:dns";
import net from "node:net";

export interface SmtpHostOptions {
  host: string;
  /** Present only when `host` was swapped for an IP: keeps TLS SNI and certificate checks on the real name. */
  tls?: { servername: string };
}

/**
 * SMTP host options that make nodemailer connect over **IPv4**.
 *
 * Why this exists (verified live on the production box, 2026-09-30):
 * - Gmail rejects `hr@digitalsukoon.com`'s app-password login from the box over **IPv6**
 *   with a misleading `535 5.7.8 Username and Password not accepted`.
 * - The identical login over **IPv4** succeeds.
 * - nodemailer 8 resolves BOTH families and connects to a RANDOM address from the combined
 *   list (`lib/shared/index.js`, `formatDNSValue`), so about half of every email the platform
 *   sent failed — password resets and HR mail included, not only pipeline mail.
 *
 * We resolve an A record ourselves and connect to that address. `tls.servername` keeps the
 * STARTTLS handshake's SNI and certificate verification on the real hostname, so nothing about
 * transport security changes.
 *
 * Falls back to the hostname (nodemailer's own resolution) when the A lookup fails or returns
 * nothing, so a DNS hiccup degrades to the old behaviour instead of failing every send.
 */
export async function ipv4SmtpHost(
  host: string,
  resolve4: (hostname: string) => Promise<string[]> = (hostname) => dns.resolve4(hostname),
): Promise<SmtpHostOptions> {
  if (!host || net.isIP(host)) return { host };
  try {
    const ip = (await resolve4(host)).find((a) => net.isIPv4(a));
    if (ip) return { host: ip, tls: { servername: host } };
  } catch {
    // Fall through: nodemailer resolves the hostname itself, as it did before.
  }
  return { host };
}
