// Link Analytics intake — the pure parser shared by the API and the sales portal.
import { describe, it, expect } from "vitest";
import { linkAnalytics } from "@dashmani/shared";

const { parseLink, splitEntries, intake } = linkAnalytics;

describe("link analytics: parseLink", () => {
  it("Instagram post / reel / tv keep the case-sensitive shortcode and share one key", () => {
    const a = parseLink("https://www.instagram.com/reel/C9xYz_AbC12/?igsh=MWx0");
    const b = parseLink("instagram.com/p/C9xYz_AbC12");
    expect(a).toMatchObject({ ok: true, platform: "instagram", postType: "reel", postKey: "ig:C9xYz_AbC12", normalizedUrl: "https://www.instagram.com/reel/C9xYz_AbC12/" });
    expect(b.postKey).toBe(a.postKey);
    expect(parseLink("https://instagram.com/reel/c9xyz_abc12/").postKey).not.toBe(a.postKey);
    expect(parseLink("https://www.instagram.com/tv/ABCDE12345/").postType).toBe("video");
  });

  it("Instagram /<user>/reel/<code> carries the username for business discovery", () => {
    expect(parseLink("https://www.instagram.com/Some.Creator/reel/ABCDE12345/")).toMatchObject({ ok: true, accountHint: "some.creator", postKey: "ig:ABCDE12345" });
  });

  it("refuses Instagram profiles, stories and bad codes with a reason", () => {
    expect(parseLink("https://www.instagram.com/somecreator/")).toMatchObject({ ok: false, reason: "This is a profile link, not a post" });
    expect(parseLink("https://www.instagram.com/stories/somecreator/1234567890/").reason).toMatch(/Stories expire/);
    expect(parseLink("https://www.instagram.com/p/a!/").ok).toBe(false);
  });

  it("Facebook numeric forms are keyed by id; page slug kept", () => {
    expect(parseLink("https://www.facebook.com/reel/1234567890123")).toMatchObject({ ok: true, postType: "reel", postKey: "fb:1234567890123" });
    expect(parseLink("https://m.facebook.com/watch/?v=987654321012")).toMatchObject({ postType: "video", postKey: "fb:987654321012" });
    expect(parseLink("https://www.facebook.com/BollywoodSociety/posts/1122334455667")).toMatchObject({ postType: "post", postKey: "fb:1122334455667", accountHint: "BollywoodSociety" });
    expect(parseLink("https://www.facebook.com/BollywoodSociety/videos/some-title/556677889900/")).toMatchObject({ postType: "video", postKey: "fb:556677889900" });
    expect(parseLink("https://www.facebook.com/permalink.php?story_fbid=1234567890&id=100064")).toMatchObject({ postKey: "fb:1234567890" });
    expect(parseLink("https://www.facebook.com/photo/?fbid=99887766554")).toMatchObject({ postType: "photo", postKey: "fb:99887766554" });
  });

  it("opaque Facebook links are keyed by URL, never merged with each other", () => {
    const a = parseLink("https://www.facebook.com/share/r/1AbCdEf/?mibextid=xyz");
    const b = parseLink("https://www.facebook.com/share/r/2ZzZzZz/");
    expect(a).toMatchObject({ ok: true, opaque: true, postType: "reel", postKey: "fbx:https://www.facebook.com/share/r/1AbCdEf/" });
    expect(a.postKey).not.toBe(b.postKey);
    expect(parseLink("https://www.facebook.com/Page/posts/pfbid02abcDEF").opaque).toBe(true);
    expect(parseLink("https://fb.watch/abc123/")).toMatchObject({ ok: true, opaque: true, postType: "video" });
  });

  it("refuses other platforms, groups, profiles and non-links", () => {
    expect(parseLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ").reason).toMatch(/Only Facebook and Instagram/);
    expect(parseLink("https://www.facebook.com/groups/123/posts/456").reason).toMatch(/Group posts/);
    expect(parseLink("https://www.facebook.com/profile.php?id=1000").reason).toMatch(/profile/);
    expect(parseLink("https://www.facebook.com/SomePage").reason).toMatch(/Page or profile/);
    expect(parseLink("hello world").reason).toBe("Not a link");
    expect(parseLink("https://example.com/x").ok).toBe(false);
  });
});

describe("link analytics: splitEntries + intake", () => {
  it("paste keeps a non-link line as one invalid entry; CSV skips non-link cells", () => {
    const text = "https://www.instagram.com/p/AAAAA11111/\nnot a link\n\nhttps://www.facebook.com/reel/123456789 https://instagram.com/reel/BBBBB22222";
    expect(splitEntries(text)).toEqual(["https://www.instagram.com/p/AAAAA11111/", "not a link", "https://www.facebook.com/reel/123456789", "https://instagram.com/reel/BBBBB22222"]);
    const csv = 'url,brand\n"https://www.instagram.com/p/AAAAA11111/",Acme\nfoo,bar';
    expect(splitEntries(csv, "csv")).toEqual(["https://www.instagram.com/p/AAAAA11111/"]);
  });

  it("counts total / valid / invalid / unique / duplicate, against known keys too", () => {
    const entries = ["https://www.instagram.com/p/AAAAA11111/", "https://instagram.com/reel/AAAAA11111?igsh=1", "junk", "https://www.facebook.com/reel/123456789"];
    const r = intake(entries);
    expect(r.counts).toEqual({ total: 4, valid: 2, invalid: 1, unique: 2, duplicate: 1 });
    expect(r.entries[1]).toMatchObject({ validity: "duplicate", duplicateOfIndex: 0 });
    const kept = intake(entries, { keepDuplicates: true });
    expect(kept.counts).toEqual({ total: 4, valid: 3, invalid: 1, unique: 2, duplicate: 0 });
    const again = intake(["https://www.facebook.com/reel/123456789"], { knownKeys: ["fb:123456789"] });
    expect(again.counts.duplicate).toBe(1);
  });
});
