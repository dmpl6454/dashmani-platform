import { describe, it, expect } from "vitest";
import { ipv4SmtpHost } from "../src/utils/smtp-host";

// Gmail rejects hr@digitalsukoon.com's logins from the prod box over IPv6 (535), while the
// same login over IPv4 succeeds (verified live 2026-09-30); nodemailer 8 picks IPv4 or IPv6 at
// random. These pin the helper that forces IPv4 while keeping TLS on the real hostname.
describe("ipv4SmtpHost", () => {
  it("connects to the first IPv4 address and keeps TLS on the real hostname", async () => {
    const r = await ipv4SmtpHost("smtp.gmail.com", async () => ["192.178.211.109", "74.125.24.108"]);
    expect(r).toEqual({ host: "192.178.211.109", tls: { servername: "smtp.gmail.com" } });
  });

  it("ignores anything that is not an IPv4 address", async () => {
    const r = await ipv4SmtpHost("smtp.gmail.com", async () => ["2404:6800:4000:1025::6d", "not-an-ip", "10.0.0.7"]);
    expect(r).toEqual({ host: "10.0.0.7", tls: { servername: "smtp.gmail.com" } });
  });

  it("falls back to the hostname when the A lookup fails, so a DNS hiccup never blocks sending", async () => {
    const r = await ipv4SmtpHost("smtp.gmail.com", async () => {
      throw Object.assign(new Error("queryA ETIMEOUT smtp.gmail.com"), { code: "ETIMEOUT" });
    });
    expect(r).toEqual({ host: "smtp.gmail.com" });
  });

  it("falls back to the hostname when there is no A record", async () => {
    expect(await ipv4SmtpHost("smtp.example.com", async () => [])).toEqual({ host: "smtp.example.com" });
  });

  it("passes a literal IP through untouched and never resolves it", async () => {
    let called = false;
    const resolve4 = async () => {
      called = true;
      return ["1.2.3.4"];
    };
    expect(await ipv4SmtpHost("127.0.0.1", resolve4)).toEqual({ host: "127.0.0.1" });
    expect(await ipv4SmtpHost("::1", resolve4)).toEqual({ host: "::1" });
    expect(called).toBe(false);
  });

  it("passes an empty host through (nodemailer's own default applies)", async () => {
    expect(await ipv4SmtpHost("", async () => ["1.2.3.4"])).toEqual({ host: "" });
  });
});
