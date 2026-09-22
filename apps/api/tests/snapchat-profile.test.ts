import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSnapchatProfilePage,
  scrapeSnapchatProfile,
  snapchatProfileUrl,
} from "../src/services/social-insights/snapchat-profile";

/**
 * Fixtures mirror the LIVE `snapchat.com/@<handle>` shape, measured 2026-09-22 across all
 * 36 handles in the estate. The page is a Next.js shell around __NEXT_DATA__; every field
 * name and sentinel value below was observed on a real page.
 */
const MIN = 100_000; // parser's page-size floor
const pad = (s: string) => s + " ".repeat(Math.max(0, MIN + 1_000 - s.length));

function page(opts: {
  username?: string;
  title?: string;
  subscriberCount?: string;
  badge?: number;
  bio?: string;
  hasSpotlightHighlights?: boolean;
  views?: Array<string | null>;
  /** Other creators' profiles Snapchat embeds on 7 of 34 real pages. */
  relatedSubscriberCounts?: string[];
  emptyHighlights?: boolean;
}) {
  const views = opts.views ?? [];
  const data = {
    props: {
      pageProps: {
        locale: "en-US",
        userProfile: {
          $case: "publicProfileInfo",
          publicProfileInfo: {
            username: opts.username ?? "testhandle",
            title: opts.title ?? "Test Channel",
            badge: opts.badge ?? 1,
            subscriberCount: opts.subscriberCount ?? "12345",
            bio: opts.bio ?? "a bio",
            profilePictureUrl: "https://cf-st.sc-cdn.net/pic.png",
            // Default it to match the posts supplied — a fixture that claims Spotlight
            // content while supplying none is the *stripped-response* signature, which
            // the parser correctly rejects. Tests that want that case set it explicitly.
            hasSpotlightHighlights: opts.hasSpotlightHighlights ?? views.length > 0,
            businessProfileId: "4fcb9c20-b0da-45ec-abd7-0106bb9f21ec",
            relatedAccountsInfo: (opts.relatedSubscriberCounts ?? []).map((c, i) => ({
              publicProfileInfo: { username: `stranger${i}`, subscriberCount: c },
            })),
          },
        },
        spotlightHighlights: opts.emptyHighlights
          ? []
          : views.map((_, i) => ({ storyId: { value: `snap${i}` } })),
        spotlightStoryMetadata: opts.emptyHighlights
          ? []
          : views.map((v) => ({
              videoMetadata: {
                viewCount: v,
                // ⚠️ a DIFFERENT number that is always "0" on real pages — must never be
                // mistaken for the channel's own follower count.
                creator: { personCreator: { username: "someone", followerCount: "0" } },
              },
            })),
      },
    },
  };
  return pad(
    `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      data,
    )}</script></body></html>`,
  );
}

describe("parseSnapchatProfilePage — withheld values must be null, never 0", () => {
  it('maps subscriberCount "0" to null (the withhold sentinel, proven on 7 of 34 live profiles)', () => {
    const r = parseSnapchatProfilePage(page({ username: "bollywoodchroni", subscriberCount: "0" }), "bollywoodchroni");
    expect(r.ok).toBe(true);
    expect(r.followers).toBeNull(); // NOT 0
  });

  it('maps subscriberCount "-1" to null', () => {
    const r = parseSnapchatProfilePage(page({ username: "x", subscriberCount: "-1" }), "x");
    expect(r.followers).toBeNull();
  });

  it("reads a published subscriberCount exactly", () => {
    const r = parseSnapchatProfilePage(page({ username: "bollywodsociety", subscriberCount: "152500" }), "bollywodsociety");
    expect(r.followers).toBe(152500);
  });

  it('treats BOTH "0" and "-1" per-post views as withheld, and sums only the published ones', () => {
    // Real shape: papscentral publishes some and withholds others on the same page.
    const r = parseSnapchatProfilePage(
      page({ username: "papscentral", views: ["4463", "0", "-1", "4412", "0"] }),
      "papscentral",
    );
    expect(r.recentViews).toBe(4463 + 4412);
    expect(r.viewsCovered).toBe(2);
    expect(r.postsSeen).toBe(5);
  });

  it("returns recentViews null (not 0) when a channel publishes no view counts at all", () => {
    // Nine real channels are in exactly this state, e.g. paparazzireel: 31 posts, all "0".
    const r = parseSnapchatProfilePage(
      page({ username: "paparazzireel", views: ["0", "0", "0", "-1"] }),
      "paparazzireel",
    );
    expect(r.recentViews).toBeNull();
    expect(r.viewsCovered).toBe(0);
    expect(r.postsSeen).toBe(4);
  });
});

describe("parseSnapchatProfilePage — identity is asserted before anything is stored", () => {
  it("refuses a page whose username is not the handle we asked for", () => {
    const r = parseSnapchatProfilePage(page({ username: "someoneelse", subscriberCount: "999" }), "ourchannel");
    expect(r.ok).toBe(false);
    expect(r.followers).toBeNull();
    expect(r.error).toMatch(/identity mismatch/i);
  });

  it("accepts a case-different username (Snapchat lowercases on redirect)", () => {
    const r = parseSnapchatProfilePage(page({ username: "justbollywood", subscriberCount: "131700" }), "JustBollywood");
    expect(r.ok).toBe(true);
    expect(r.followers).toBe(131700);
  });

  it("NEVER picks up a related account's subscriberCount", () => {
    // 7 of 34 real profiles embed other creators. Here OUR count is withheld while three
    // strangers' counts sit on the same page — a loose parser stores one of theirs.
    const r = parseSnapchatProfilePage(
      page({ username: "paparazzze", subscriberCount: "0", relatedSubscriberCounts: ["88888", "77777", "66666"] }),
      "paparazzze",
    );
    expect(r.followers).toBeNull();
  });
});

describe("parseSnapchatProfilePage — the stripped-but-200 response", () => {
  it("flags a page that claims Spotlight content but returned none, instead of recording zero posts", () => {
    const r = parseSnapchatProfilePage(
      page({ username: "bollydazzle", subscriberCount: "146200", hasSpotlightHighlights: true, emptyHighlights: true }),
      "bollydazzle",
    );
    expect(r.partial).toBe(true);
    expect(r.ok).toBe(false); // caller must keep its previous values
  });

  it("does NOT flag a profile that genuinely has no Spotlight content", () => {
    const r = parseSnapchatProfilePage(
      page({ username: "quiet", subscriberCount: "10", hasSpotlightHighlights: false, emptyHighlights: true }),
      "quiet",
    );
    expect(r.partial).toBe(false);
    expect(r.ok).toBe(true);
  });
});

describe("parseSnapchatProfilePage — gates", () => {
  it("rejects a page under the size floor (a 404 body is ~6KB)", () => {
    const r = parseSnapchatProfilePage("<html>tiny</html>", "x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too small/);
  });

  it("returns a miss, not a throw, on malformed __NEXT_DATA__", () => {
    const html = pad('<script id="__NEXT_DATA__" type="application/json">{not json</script>');
    const r = parseSnapchatProfilePage(html, "x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not parse/);
  });
});

// ── 2026-09-08: this parser runs on the API main thread. It must be LINEAR. ────
// These pages are 234KB–885KB shells around a ~460KB blob and are exactly the input class
// that pinned the event loop for 5h44m. There is no regex over page HTML in this module;
// these tests are what keeps it that way.
describe("parseSnapchatProfilePage is linear on hostile input", () => {
  const MB = 1024 * 1024;
  const timed = <T>(fn: () => T) => {
    const t0 = performance.now();
    const value = fn();
    return { value, ms: performance.now() - t0 };
  };

  it("a 3MB <script opener with no closing > finishes fast and returns a miss", () => {
    const html = '<html><script id="__NEXT_DATA__" ' + "x".repeat(3 * MB);
    const r = timed(() => parseSnapchatProfilePage(html, "x"));
    expect(r.value.ok).toBe(false);
    expect(r.ms).toBeLessThan(1500);
  });

  it("10,000 __NEXT_DATA__ openers with no closers finish fast", () => {
    const html = "<html>" + '<script id="__NEXT_DATA__">'.repeat(10_000) + "y".repeat(2 * MB);
    const r = timed(() => parseSnapchatProfilePage(html, "x"));
    expect(r.value.ok).toBe(false);
    expect(r.ms).toBeLessThan(1500);
  });

  it("a 3MB body with no script tag at all finishes fast", () => {
    const html = "<html>" + "z".repeat(3 * MB);
    const r = timed(() => parseSnapchatProfilePage(html, "x"));
    expect(r.value.ok).toBe(false);
    expect(r.ms).toBeLessThan(1500);
  });

  it("a real-sized page (≈800KB) still parses correctly and quickly", () => {
    const big = page({ username: "big", subscriberCount: "235700", views: ["100", "200"] }) + "q".repeat(700_000);
    const r = timed(() => parseSnapchatProfilePage(big, "big"));
    expect(r.value.followers).toBe(235700);
    expect(r.ms).toBeLessThan(1500);
  });
});

describe("scrapeSnapchatProfile — fail-open and wall handling", () => {
  afterEach(() => vi.unstubAllEnvs());

  const res = (init: Partial<Response> & { body?: string }) =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      url: init.url ?? "https://www.snapchat.com/@x",
      text: async () => init.body ?? "",
    }) as unknown as Response;

  it("a 404 is a real answer about the handle, NOT a wall (2 of 36 handles are like this)", async () => {
    const r = await scrapeSnapchatProfile("nosuchhandle", (async () => res({ ok: false, status: 404 })) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.walled).toBe(false); // must not trip the consecutive-wall short-circuit
  });

  it("a non-404 HTTP failure IS a wall", async () => {
    const r = await scrapeSnapchatProfile("x", (async () => res({ ok: false, status: 429 })) as typeof fetch);
    expect(r.walled).toBe(true);
  });

  it("a redirect to a login page is a wall", async () => {
    const r = await scrapeSnapchatProfile(
      "x",
      (async () => res({ url: "https://accounts.snapchat.com/login", body: page({ username: "x" }) })) as typeof fetch,
    );
    expect(r.walled).toBe(true);
  });

  it("never throws on a network error", async () => {
    const r = await scrapeSnapchatProfile("x", (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNRESET/);
  });

  it("honours the kill switch, read at CALL time so tests can toggle it", async () => {
    vi.stubEnv("SC_SCRAPER_ENABLED", "0");
    const spy = vi.fn();
    const r = await scrapeSnapchatProfile("x", spy as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("parses a good response end to end", async () => {
    const r = await scrapeSnapchatProfile(
      "papscentral",
      (async () => res({ body: page({ username: "papscentral", subscriberCount: "134700", views: ["4463", "0"] }) })) as typeof fetch,
    );
    expect(r.ok).toBe(true);
    expect(r.followers).toBe(134700);
    expect(r.recentViews).toBe(4463);
    expect(r.viewsCovered).toBe(1);
    expect(r.postsSeen).toBe(2);
  });
});

describe("snapchatProfileUrl", () => {
  it("builds the canonical URL and pins the language", () => {
    expect(snapchatProfileUrl("@Foo")).toBe("https://www.snapchat.com/@Foo?locale=en-US");
  });
});

// ── Findings from the adversarial pre-merge review ────────────────────────────

describe("failure modes are classified so the caller can respond correctly", () => {
  const res = (init: { ok?: boolean; status?: number; url?: string; body?: string }) =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      url: init.url ?? "https://www.snapchat.com/@x",
      text: async () => init.body ?? "",
    }) as unknown as Response;

  it("counts a TIMEOUT as a wall, so the short-circuit is not keyed on the one mode that never sets it", async () => {
    // Snapchat degrading by hanging rather than answering 429 is the likelier shape. If a
    // timeout did not set `walled`, the sync would walk all 36 profiles paying the full
    // 12s timeout on each with no brake.
    const r = await scrapeSnapchatProfile("x", (async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch);
    expect(r.walled).toBe(true);
    expect(r.error).toMatch(/timeout/);
  });

  it("marks a 404 as notFound and NOT as a wall", async () => {
    const r = await scrapeSnapchatProfile("nope", (async () => res({ ok: false, status: 404 })) as typeof fetch);
    expect(r.notFound).toBe(true);
    expect(r.walled).toBe(false); // two real handles are permanently in this state
  });

  it("a connection reset is a wall, not a channel-level fault", async () => {
    const r = await scrapeSnapchatProfile("x", (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch);
    expect(r.walled).toBe(true);
  });
});
