import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  snapchatProvider,
  resolveSnapchatShareUrl,
  __setScraperFetchForTesting,
  __resetSnapchatStateForTesting,
} from "../src/services/social-insights/snapchat.provider";
import type { InsightTarget } from "../src/services/social-insights/types";

function target(linkId: string, url: string, targetId: string): InsightTarget {
  return { linkId, url, urlNormalized: url.toLowerCase(), targetId, employeeId: "e1", reportDate: new Date("2026-07-01") };
}

const goodHtml = (views: string, caption = "hi") =>
  `<html>${" ".repeat(60_000)}<script id="__NEXT_DATA__">${JSON.stringify({
    props: { pageProps: { spotlightFeed: { spotlightStories: [
      { story: {}, metadata: { engagementStats: { viewCount: views, shareCount: "3", commentCount: "2" }, videoMetadata: { embeddedTextCaption: caption } } },
    ] } } },
  })}</script></html>`;

beforeEach(() => {
  __resetSnapchatStateForTesting();
  __setScraperFetchForTesting(null);
});

describe("snapchatProvider", () => {
  it("slug is snapchat and isSupported is true (scraper needs no token)", () => {
    expect(snapchatProvider.slug).toBe("snapchat");
    expect(snapchatProvider.isSupported()).toBe(true);
  });

  it("extractTargetId returns the spotlight id from a resolved url, null for /t/ + story", () => {
    expect(snapchatProvider.extractTargetId("https://www.snapchat.com/spotlight/W7_abc12345")).toBe("W7_abc12345");
    expect(snapchatProvider.extractTargetId("https://snapchat.com/t/rfm4p1Y7")).toBeNull();
    expect(snapchatProvider.extractTargetId("https://www.snapchat.com/p/uuid/3137385781778432")).toBeNull();
  });

  it("fetchBatch scrapes a spotlight → ok with views/comments/shares/caption, likes null", async () => {
    __setScraperFetchForTesting(
      vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_abc12345", text: async () => goodHtml("500000") }) as unknown as typeof fetch
    );
    const res = await snapchatProvider.fetchBatch([target("l1", "https://www.snapchat.com/spotlight/W7_abc12345", "W7_abc12345")]);
    const r = res.get("l1")!;
    expect(r.status).toBe("ok");
    expect(r.views).toBe(500000);
    expect(r.comments).toBe(2);
    expect(r.shares).toBe(3);
    expect(r.likes).toBeNull();
    expect(r.caption).toBe("hi");
  });

  it("fetchBatch → not_found when the scrape yields no real signal", async () => {
    __setScraperFetchForTesting(
      vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_x", text: async () => "x".repeat(60_000) }) as unknown as typeof fetch
    );
    const res = await snapchatProvider.fetchBatch([target("l1", "https://www.snapchat.com/spotlight/W7_x", "W7_x")]);
    expect(res.get("l1")!.status).toBe("not_found");
  });

  it("fetchBatch short-circuits after N consecutive walls (block detection)", async () => {
    const walled = vi.fn().mockResolvedValue({ ok: false, url: "https://www.snapchat.com/spotlight/x", text: async () => "" });
    __setScraperFetchForTesting(walled as unknown as typeof fetch);
    const targets = Array.from({ length: 10 }, (_, i) => target(`l${i}`, `https://www.snapchat.com/spotlight/W7_id${i}0000`, `W7_id${i}0000`));
    await snapchatProvider.fetchBatch(targets);
    // wall limit default 5 → after 5 walls it stops calling fetch for the rest.
    expect(walled.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("harvestContent returns captions keyed sc:<id> for scraped spotlights", async () => {
    __setScraperFetchForTesting(
      vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_abc12345", text: async () => goodHtml("10", "caption text") }) as unknown as typeof fetch
    );
    await snapchatProvider.fetchBatch([target("l1", "https://www.snapchat.com/spotlight/W7_abc12345", "W7_abc12345")]);
    const harvested = snapchatProvider.harvestContent!();
    expect(harvested).toContainEqual({ canonicalKey: "sc:W7_abc12345", caption: "caption text", title: null });
  });
});

describe("resolveSnapchatShareUrl", () => {
  it("resolves a /t/ share that redirects to a /spotlight/ → clean spotlight url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      url: "https://www.snapchat.com/p/uuid/spotlight/W7_resolved123?locale=en_US",
    });
    const clean = await resolveSnapchatShareUrl("https://snapchat.com/t/abc", fetchImpl as unknown as typeof fetch);
    expect(clean).toBe("https://www.snapchat.com/spotlight/W7_resolved123");
  });

  it("returns null when a /t/ share resolves to a /p/<uuid>/<storyId> STORY (no spotlight)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      url: "https://www.snapchat.com/p/uuid/3137385781778432?chapterid=1",
    });
    expect(await resolveSnapchatShareUrl("https://snapchat.com/t/abc", fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null (fail-open) on a thrown fetch", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("net"));
    expect(await resolveSnapchatShareUrl("https://snapchat.com/t/abc", fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
