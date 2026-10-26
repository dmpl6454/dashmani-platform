import { describe, it, expect } from "vitest";
import { instagramEmbedUrl, extractInstagramShortcode } from "@dashmani/shared";

describe("instagramEmbedUrl", () => {
  it("builds the framable /embed/ page for reels, posts and IGTV", () => {
    expect(instagramEmbedUrl("https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=MXE4YTh0b2Y4ajR2ZQ==")).toBe(
      "https://www.instagram.com/reel/DZJyjhBKN5-/embed/",
    );
    expect(instagramEmbedUrl("https://instagram.com/reels/ABC123/")).toBe("https://www.instagram.com/reel/ABC123/embed/");
    expect(instagramEmbedUrl("https://m.instagram.com/p/XYZ789")).toBe("https://www.instagram.com/p/XYZ789/embed/");
    expect(instagramEmbedUrl("https://www.instagram.com/tv/QWE456/")).toBe("https://www.instagram.com/tv/QWE456/embed/");
    expect(instagramEmbedUrl("https://www.instagram.com/someuser/reel/AbCdEf/")).toBe(
      "https://www.instagram.com/reel/AbCdEf/embed/",
    );
  });

  it("preserves shortcode case", () => {
    expect(instagramEmbedUrl("https://instagram.com/REEL/AbCdEf/")).toBe("https://www.instagram.com/reel/AbCdEf/embed/");
  });

  it("returns null for anything that is not an Instagram post", () => {
    expect(instagramEmbedUrl(null)).toBeNull();
    expect(instagramEmbedUrl("")).toBeNull();
    expect(instagramEmbedUrl("not a url")).toBeNull();
    expect(instagramEmbedUrl("https://www.instagram.com/someuser/")).toBeNull();
    expect(instagramEmbedUrl("https://evil.example/reel/ABC123/")).toBeNull();
    expect(instagramEmbedUrl("https://instagram.com.evil.example/reel/ABC123/")).toBeNull();
    expect(instagramEmbedUrl("https://www.instagram.com/reel/bad%22code/")).toBeNull();
  });

  it("leaves extractInstagramShortcode unchanged", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=x")).toBe("DZJyjhBKN5-");
    expect(extractInstagramShortcode("https://youtube.com/watch?v=abc")).toBeNull();
  });
});
