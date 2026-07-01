import { describe, it, expect } from "vitest";
import {
  parseSnapchatProfileHtml,
  snapchatCandidateUrls,
  scrapeSnapchatFollowers,
  type FetchFn,
} from "../src/services/social-insights/snapchat-scraper";

// Minimum page length gate in the parser is 10_000 chars; pad fixtures past it.
const pad = (s: string) => s + " ".repeat(11_000);

describe("parseSnapchatProfileHtml — real /p/<uuid> public-profile shapes", () => {
  it("extracts the count from JSON-LD with OBJECT-form interactionType nested under mainEntity", () => {
    // This mirrors the LIVE snapchat.com/p/<uuid> page shape (2026-07-01):
    // ProfilePage → mainEntity(Organization) → interactionStatistic[FollowAction],
    // where interactionType is an OBJECT {"@type":"FollowAction"}, not a string URL.
    const html = pad(`<!doctype html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        mainEntity: {
          "@type": "Organization",
          name: "Bollywood Chronicle",
          interactionStatistic: [
            { "@type": "InteractionCounter", interactionType: { "@type": "FollowAction" }, userInteractionCount: 98100 },
          ],
        },
      })}</script></head><body>x</body>`);
    expect(parseSnapchatProfileHtml(html)).toBe(98100);
  });

  it("extracts the count from the QUOTED inline subscriberCount form", () => {
    const html = pad(`<html><body><script>window.__X={"displayNameStringId":"","subscriberCount":"147300","bio":"…"}</script></body>`);
    expect(parseSnapchatProfileHtml(html)).toBe(147300);
  });

  it("does NOT match the Hindi UI-template decoy (no digits) and returns null when no real count", () => {
    // The live page contains template strings like "{subscriberCount} फ़ॉलोअर" — these
    // must NOT be parsed as a count.
    const html = pad(`<html><body><script>window.__X={"JHt/mt":"{subscriberCount} फ़ॉलोअर","x":"y"}</script></body>`);
    expect(parseSnapchatProfileHtml(html)).toBeNull();
  });

  it("still handles the legacy string-URL interactionType form", () => {
    const html = pad(`<script type="application/ld+json">${JSON.stringify({
      "@type": "Person",
      interactionStatistic: [
        { interactionType: "https://schema.org/FollowAction", userInteractionCount: 5000 },
      ],
    })}</script>`);
    expect(parseSnapchatProfileHtml(html)).toBe(5000);
  });

  it("returns null on a short page (login wall / bot block)", () => {
    expect(parseSnapchatProfileHtml('<html>login</html>')).toBeNull();
  });
});

describe("snapchatCandidateUrls — profile_url is tried FIRST", () => {
  it("puts an http profile_url before the /add/ handle fallbacks", () => {
    const urls = snapchatCandidateUrls("bollywoodchronicle", "https://snapchat.com/t/R8osjxMG");
    expect(urls[0]).toBe("https://snapchat.com/t/R8osjxMG");
    expect(urls).toContain("https://www.snapchat.com/add/bollywoodchronicle");
  });

  it("ignores a non-http profile_url (bare handle) and uses handle fallbacks", () => {
    const urls = snapchatCandidateUrls("movified", "movified");
    expect(urls.every((u) => u.startsWith("https://"))).toBe(true);
    expect(urls[0]).toBe("https://www.snapchat.com/add/movified");
  });

  it("returns [] when there is neither an http profile_url nor a handle", () => {
    expect(snapchatCandidateUrls("", null)).toEqual([]);
  });
});

describe("scrapeSnapchatFollowers — fail-open + profile_url-first", () => {
  const okHtml = pad(`<script type="application/ld+json">${JSON.stringify({
    "@type": "ProfilePage",
    mainEntity: { interactionStatistic: [{ interactionType: { "@type": "FollowAction" }, userInteractionCount: 73400 }] },
  })}</script>`);

  it("resolves the count from the profile_url on the first try", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, url: "https://www.snapchat.com/p/uuid", text: async () => okHtml } as any;
    }) as unknown as FetchFn;
    const r = await scrapeSnapchatFollowers("intlfashion", fakeFetch, "https://snapchat.com/t/abc");
    expect(r.followers).toBe(73400);
    expect(calls[0]).toBe("https://snapchat.com/t/abc"); // profile_url tried FIRST
  });

  it("returns null (fail-open) when every candidate 404s — never zero", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 404, url: "x", text: async () => "" } as any)) as unknown as FetchFn;
    const r = await scrapeSnapchatFollowers("movified", fakeFetch, "https://t.snapchat.com/dead");
    expect(r.followers).toBeNull();
  });

  it("flags walled=true on a login-wall redirect", async () => {
    const fakeFetch = (async () => ({ ok: true, status: 200, url: "https://accounts.snapchat.com/accounts/login", text: async () => pad("x") } as any)) as unknown as FetchFn;
    const r = await scrapeSnapchatFollowers("x", fakeFetch, "https://snapchat.com/t/abc");
    expect(r.followers).toBeNull();
    expect(r.walled).toBe(true);
  });
});
