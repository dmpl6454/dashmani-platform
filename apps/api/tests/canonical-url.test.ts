import { describe, it, expect } from "vitest";
import { canonicalKey } from "@dashmani/shared";

describe("canonicalKey", () => {
  describe("Instagram — collapses tracking-token variants of the same post", () => {
    it("treats the same reel with different ?igsh tokens as one key (Kajal's real dupes)", () => {
      const a = canonicalKey("https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=MXE4YTh0b2Y4ajR2ZQ==");
      const b = canonicalKey("https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=SOME_OTHER_TOKEN_999");
      expect(a).toBe(b);
      expect(a).toBe("ig:DZJyjhBKN5-");
    });

    it("handles /reel, /reels, /p, /tv forms", () => {
      expect(canonicalKey("https://instagram.com/reel/ABC123/")).toBe("ig:ABC123");
      expect(canonicalKey("https://instagram.com/reels/ABC123/")).toBe("ig:ABC123");
      expect(canonicalKey("https://instagram.com/p/XYZ789/")).toBe("ig:XYZ789");
      expect(canonicalKey("https://instagram.com/tv/QWE456/")).toBe("ig:QWE456");
    });

    it("preserves shortcode case — distinct codes never merge", () => {
      // Instagram shortcodes are case-sensitive; lowercasing would merge distinct reels.
      expect(canonicalKey("https://instagram.com/reel/AbCdEf/")).not.toBe(
        canonicalKey("https://instagram.com/reel/abcdef/"),
      );
    });

    it("normalizes www. and m. hosts to the same key", () => {
      expect(canonicalKey("https://www.instagram.com/reel/ABC123/")).toBe(
        canonicalKey("https://m.instagram.com/reel/ABC123/"),
      );
    });

    it("keeps two DIFFERENT reels distinct", () => {
      expect(canonicalKey("https://instagram.com/reel/DZJcR8yq62P/?igsh=a")).not.toBe(
        canonicalKey("https://instagram.com/reel/DZJuo0ZKAaS/?igsh=b"),
      );
    });
  });

  describe("YouTube — unifies link forms, preserves id case", () => {
    it("collapses watch?v, youtu.be and /shorts/ for the same video", () => {
      const watch = canonicalKey("https://youtube.com/watch?v=dQw4w9WgXcQ");
      const short = canonicalKey("https://youtu.be/dQw4w9WgXcQ");
      const shorts = canonicalKey("https://www.youtube.com/shorts/dQw4w9WgXcQ");
      expect(watch).toBe("yt:dQw4w9WgXcQ");
      expect(short).toBe("yt:dQw4w9WgXcQ");
      expect(shorts).toBe("yt:dQw4w9WgXcQ");
    });

    it("preserves video-id case — ids differing only by case are different videos", () => {
      // YouTube ids are case-sensitive 11-char tokens. Lowercasing would drop a distinct video.
      const a = canonicalKey("https://youtube.com/watch?v=dQw4w9WgXcQ");
      const b = canonicalKey("https://youtube.com/watch?v=DQW4W9WGXCQ");
      expect(a).not.toBe(b);
    });
  });

  describe("Facebook — only numeric ids canonicalize; opaque shares stay distinct", () => {
    it("collapses numeric /reel/, /videos/ and watch?v= for the same id", () => {
      expect(canonicalKey("https://www.facebook.com/reel/123456789")).toBe("fb:123456789");
      expect(canonicalKey("https://m.facebook.com/reel/123456789")).toBe("fb:123456789");
      expect(canonicalKey("https://www.facebook.com/videos/123456789")).toBe("fb:123456789");
      expect(canonicalKey("https://www.facebook.com/watch?v=123456789")).toBe("fb:123456789");
    });

    it("keeps two DIFFERENT opaque /share/r/ links distinct (never over-collapse)", () => {
      const a = canonicalKey("https://www.facebook.com/share/r/16abcXYZ/");
      const b = canonicalKey("https://www.facebook.com/share/r/99zzzQQQ/");
      expect(a).not.toBe(b);
    });

    it("does not canonicalize pfbid / posts / story.php permalinks (fall through)", () => {
      const pfbid = "https://www.facebook.com/permalink.php?story_fbid=pfbid0abcDEF&id=100";
      const posts = "https://www.facebook.com/somepage/posts/pfbid0xyz";
      // They get the lowercased-full-url fallback, NOT an fb:<id> key.
      expect(canonicalKey(pfbid).startsWith("fb:")).toBe(false);
      expect(canonicalKey(posts).startsWith("fb:")).toBe(false);
      // And two different ones remain distinct.
      expect(canonicalKey(pfbid)).not.toBe(canonicalKey(posts));
    });
  });

  describe("Fallback — unrecognized input behaves exactly like the old key", () => {
    it("lowercases the full URL for unrecognized platforms", () => {
      expect(canonicalKey("https://www.linkedin.com/posts/foo_bar-activity-123")).toBe(
        "https://www.linkedin.com/posts/foo_bar-activity-123",
      );
    });

    it("returns trimmed-lowercased string for non-URL input", () => {
      expect(canonicalKey("  Not A URL  ")).toBe("not a url");
    });

    it("returns empty string for null/undefined/blank", () => {
      expect(canonicalKey(null)).toBe("");
      expect(canonicalKey(undefined)).toBe("");
      expect(canonicalKey("   ")).toBe("");
    });

    it("two different unrecognized URLs stay distinct", () => {
      expect(canonicalKey("https://example.com/a")).not.toBe(canonicalKey("https://example.com/b"));
    });
  });
});
