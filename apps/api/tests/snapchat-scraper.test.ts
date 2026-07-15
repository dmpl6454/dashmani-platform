import { describe, it, expect, vi } from "vitest";
import {
  parseSnapchatProfileHtml,
  snapchatCandidateUrls,
  scrapeSnapchatFollowers,
  parseSnapchatSpotlightHtml,
  scrapeSnapchatSpotlightEngagement,
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

// ── Snapchat Spotlight engagement (views/comments/shares/caption) ────────────
// A separate scraper from the follower-count one above: reads a public
// /spotlight/<id> page's __NEXT_DATA__ blob for per-post engagement stats.

// Minimal __NEXT_DATA__ fixture mirroring the real shape (spotlightStories[0] = target).
function spotlightFixture(stats: Record<string, string>, caption = "a fun clip", extra: object = {}) {
  const nextData = {
    props: {
      pageProps: {
        spotlightFeed: {
          spotlightStories: [
            {
              story: { snapList: [{ snapUrls: { mediaUrl: "https://x" } }] },
              metadata: {
                engagementStats: stats,
                videoMetadata: { embeddedTextCaption: caption, description: caption },
                ...extra,
              },
            },
            // a neighbor with DIFFERENT numbers — must be ignored
            {
              story: {},
              metadata: {
                engagementStats: { viewCount: "999", shareCount: "9", commentCount: "9", boostCount: "9", recommendCount: "9" },
                videoMetadata: { embeddedTextCaption: "neighbor caption" },
              },
            },
          ],
        },
      },
    },
  };
  // Pad to exceed MIN length so the parser accepts it.
  const spotlightPad = " ".repeat(60_000);
  return `<html><head></head><body>${spotlightPad}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

describe("parseSnapchatSpotlightHtml", () => {
  it("reads engagementStats from spotlightStories[0] (the target, NOT a neighbor)", () => {
    const html = spotlightFixture({ viewCount: "10651854", shareCount: "69071", commentCount: "11289", boostCount: "194573", recommendCount: "10066" });
    const r = parseSnapchatSpotlightHtml(html);
    expect(r.views).toBe(10651854);
    expect(r.shares).toBe(69071);
    expect(r.comments).toBe(11289);
    expect(r.caption).toBe("a fun clip");
  });

  it("returns all-null for html shorter than the minimum", () => {
    const r = parseSnapchatSpotlightHtml("<html>short</html>");
    expect(r).toEqual({ views: null, likes: null, comments: null, shares: null, caption: null });
  });

  it("returns all-null when __NEXT_DATA__ is missing", () => {
    const r = parseSnapchatSpotlightHtml("x".repeat(60_000));
    expect(r.views).toBeNull();
    expect(r.caption).toBeNull();
  });

  it("treats viewCount -1 as null (ephemeral Story sentinel, not a real count)", () => {
    const html = spotlightFixture({ viewCount: "-1", shareCount: "0", commentCount: "0", boostCount: "0", recommendCount: "0" });
    const r = parseSnapchatSpotlightHtml(html);
    expect(r.views).toBeNull();
  });

  it("also maps a -1 sentinel on shares/comments to null, not just views", () => {
    const html = spotlightFixture({ viewCount: "5", shareCount: "-1", commentCount: "-1", boostCount: "0", recommendCount: "0" });
    const r = parseSnapchatSpotlightHtml(html);
    expect(r.shares).toBeNull();
    expect(r.comments).toBeNull();
    expect(r.views).toBe(5);
  });

  it("treats an empty-string stat as null, not zero (Number('') === 0 trap)", () => {
    const html = spotlightFixture({ viewCount: "", shareCount: "3", commentCount: "2", boostCount: "0", recommendCount: "0" });
    const r = parseSnapchatSpotlightHtml(html);
    expect(r.views).toBeNull();
    expect(r.shares).toBe(3);
  });

  it("likes is always null (Snapchat exposes no like metric for Spotlight)", () => {
    const html = spotlightFixture({ viewCount: "100", shareCount: "1", commentCount: "1", boostCount: "1", recommendCount: "1" });
    expect(parseSnapchatSpotlightHtml(html).likes).toBeNull();
  });

  it("falls back to description when embeddedTextCaption is absent", () => {
    const nextData = {
      props: { pageProps: { spotlightFeed: { spotlightStories: [
        { story: {}, metadata: { engagementStats: { viewCount: "5" }, videoMetadata: { description: "desc only" } } },
      ] } } },
    };
    const html = `<html>${" ".repeat(60_000)}<script id="__NEXT_DATA__">${JSON.stringify(nextData)}</script></html>`;
    expect(parseSnapchatSpotlightHtml(html).caption).toBe("desc only");
  });
});

describe("scrapeSnapchatSpotlightEngagement (fail-open)", () => {
  it("returns all-null for an empty spotlight id (no fetch)", async () => {
    const r = await scrapeSnapchatSpotlightEngagement("", vi.fn());
    expect(r).toEqual({ views: null, likes: null, comments: null, shares: null, caption: null });
  });

  it("returns walled on a non-200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, url: "https://www.snapchat.com/spotlight/x", text: async () => "" });
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.walled).toBe(true);
    expect(r.views).toBeNull();
  });

  it("returns walled on a login redirect", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, url: "https://accounts.snapchat.com/accounts/login", text: async () => "x".repeat(60_000) });
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.walled).toBe(true);
  });

  it("parses a good 200 response", async () => {
    const html = `<html>${" ".repeat(60_000)}<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { spotlightFeed: { spotlightStories: [ { story: {}, metadata: { engagementStats: { viewCount: "42" }, videoMetadata: { embeddedTextCaption: "hi" } } } ] } } } })}</script></html>`;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_abc12345", text: async () => html });
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.views).toBe(42);
    expect(r.caption).toBe("hi");
    expect(r.walled).toBeFalsy();
  });

  it("returns walled on a thrown/timeout", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.walled).toBe(true);
  });
});
