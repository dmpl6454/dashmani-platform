import { describe, it, expect, vi } from "vitest";
import {
  parseFbReelHtml,
  scrapeFacebookReelEngagement,
} from "../src/services/social-insights/facebook-scraper";

// Build a realistic-length reel HTML fixture. The parser requires >= 50KB to treat
// the body as a real reel page (a login wall / error shell is much smaller), so we
// pad to ~60KB. The engagement JSON keys are placed verbatim as the live reel HTML
// embeds them (verified live 2026-06-25).
function reelHtml(opts: {
  videoViewCount?: number;
  playCounts?: number[]; // carousel noise — must be IGNORED
  reactionCount?: number;
  totalCommentCount?: number;
  ogDescription?: string;
  ogTitle?: string;
}): string {
  const parts: string[] = ['<!DOCTYPE html><html><head><meta charset="utf-8">'];
  if (opts.ogTitle != null)
    parts.push(`<meta property="og:title" content="${opts.ogTitle}" />`);
  if (opts.ogDescription != null)
    parts.push(`<meta property="og:description" content="${opts.ogDescription}" />`);
  // Carousel reels carry play_count but NOT video_view_count. These must be ignored.
  for (const pc of opts.playCounts ?? []) parts.push(`{"play_count":${pc},"playable_duration":34}`);
  if (opts.reactionCount != null)
    parts.push(`"reaction_count":{"count":${opts.reactionCount},"is_empty":false}`);
  if (opts.totalCommentCount != null) parts.push(`"total_comment_count":${opts.totalCommentCount}`);
  // The TARGET reel's view count: appears exactly once, also as video_post_view_count.
  if (opts.videoViewCount != null)
    parts.push(`"video_post_view_count":${opts.videoViewCount},"video_view_count":${opts.videoViewCount}`);
  parts.push("</head><body>");
  parts.push("x".repeat(60_000)); // pad to a realistic full-page length
  parts.push("</body></html>");
  return parts.join("");
}

describe("parseFbReelHtml", () => {
  it("reads views from video_view_count (the TRUE count), NOT play_count", () => {
    const html = reelHtml({
      videoViewCount: 13547,
      playCounts: [43198, 2309, 5653], // carousel noise — first-match would be wrong
      reactionCount: 264,
      totalCommentCount: 8,
    });
    const r = parseFbReelHtml(html);
    expect(r.views).toBe(13547); // NOT 43198 (the loose first play_count)
    expect(r.likes).toBe(264);
    expect(r.comments).toBe(8);
  });

  it("returns all-null for a body shorter than the reel-page minimum (login wall / shell)", () => {
    const wall = '<html><body><form id="loginForm"></form>"video_view_count":99999</body></html>';
    expect(parseFbReelHtml(wall)).toEqual({ views: null, likes: null, comments: null, caption: null });
  });

  it("returns all-null for empty input", () => {
    expect(parseFbReelHtml("")).toEqual({ views: null, likes: null, comments: null, caption: null });
  });

  it("handles a reel with zero comments and present reactions", () => {
    const r = parseFbReelHtml(reelHtml({ videoViewCount: 4455, reactionCount: 78, totalCommentCount: 0 }));
    expect(r.views).toBe(4455);
    expect(r.likes).toBe(78);
    expect(r.comments).toBe(0);
  });

  it("leaves a metric null when its key is absent (partial data)", () => {
    const r = parseFbReelHtml(reelHtml({ videoViewCount: 100 })); // no reactions/comments
    expect(r.views).toBe(100);
    expect(r.likes).toBeNull();
    expect(r.comments).toBeNull();
  });

  it("PREFERS og:description for the caption (it carries the person's name)", () => {
    // Real case: og:title is just the Page name; og:description has the content.
    const r = parseFbReelHtml(
      reelHtml({
        videoViewCount: 200,
        ogTitle: "Paparazzi Reels",
        ogDescription: "Kriti Sanon Dance in Stage Glamour in event",
      }),
    );
    expect(r.caption).toBe("Kriti Sanon Dance in Stage Glamour in event");
  });

  it("falls back to og:title's post-pipe caption when og:description is empty", () => {
    const r = parseFbReelHtml(
      reelHtml({
        videoViewCount: 200,
        ogTitle: "43K views · 264 reactions | Veteran Actor Jeetendra Ji Fell Down",
        ogDescription: "",
      }),
    );
    // Strips the "43K views · 264 reactions | " engagement prefix.
    expect(r.caption).toBe("Veteran Actor Jeetendra Ji Fell Down");
  });

  it("decodes HTML entities in the caption (Devanagari, &amp;)", () => {
    const r = parseFbReelHtml(
      reelHtml({ videoViewCount: 1, ogDescription: "Rahul &amp; co &#x915;&#x94b; Bandra" }),
    );
    expect(r.caption).toBe("Rahul & co को Bandra");
  });
});

describe("scrapeFacebookReelEngagement", () => {
  it("rejects non-numeric ids without any fetch", async () => {
    const f = vi.fn();
    const r = await scrapeFacebookReelEngagement("pfbid0abc", f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
    expect(r).toEqual({ views: null, likes: null, comments: null, caption: null });
  });

  it("parses engagement + caption from a 200 reel response", async () => {
    const html = reelHtml({
      videoViewCount: 9859,
      reactionCount: 198,
      totalCommentCount: 0,
      ogDescription: "Rajpal Yadav at the prayer meet",
    });
    const f = vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const r = await scrapeFacebookReelEngagement("1345780967432337", f);
    expect(r).toEqual({ views: 9859, likes: 198, comments: 0, caption: "Rajpal Yadav at the prayer meet" });
  });

  it("fails open (all-null) on a non-200 response", async () => {
    const f = vi.fn(async () => new Response("", { status: 400 })) as unknown as typeof fetch;
    const r = await scrapeFacebookReelEngagement("123", f);
    expect(r).toEqual({ views: null, likes: null, comments: null, caption: null });
  });

  it("fails open when redirected to a login wall", async () => {
    // A Response whose url contains /login → treated as a wall, not parsed.
    const resp = new Response(reelHtml({ videoViewCount: 1 }), { status: 200 });
    Object.defineProperty(resp, "url", { value: "https://www.facebook.com/login/" });
    const f = vi.fn(async () => resp) as unknown as typeof fetch;
    const r = await scrapeFacebookReelEngagement("123", f);
    expect(r).toEqual({ views: null, likes: null, comments: null, caption: null });
  });

  it("fails open (all-null) when fetch throws", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await scrapeFacebookReelEngagement("123", f);
    expect(r).toEqual({ views: null, likes: null, comments: null, caption: null });
  });
});
