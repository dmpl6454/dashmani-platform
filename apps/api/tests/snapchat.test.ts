import { describe, it, expect } from "vitest";
import { extractSnapchatSpotlightId } from "@dashmani/shared";

describe("extractSnapchatSpotlightId", () => {
  it("extracts id from a clean /spotlight/<id> url", () => {
    expect(
      extractSnapchatSpotlightId(
        "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYa3JhbHR0Y3BpAZ6MCwRbAZ6MBHi6AAAAAQ"
      )
    ).toBe("W7_EDlXWTBiXAEEniNoMPwAAYa3JhbHR0Y3BpAZ6MCwRbAZ6MBHi6AAAAAQ");
  });

  it("extracts id from a /p/<uuid>/spotlight/<id> resolved url (with query)", () => {
    expect(
      extractSnapchatSpotlightId(
        "https://www.snapchat.com/p/4fcb9c20-b0da-45ec-abd7-0106bb9f21ec/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYZm10eXVpYXNuAZ6OrSwoAZ6Oq1abAAAAAQ?locale=en_US&sid=abc"
      )
    ).toBe("W7_EDlXWTBiXAEEniNoMPwAAYZm10eXVpYXNuAZ6OrSwoAZ6Oq1abAAAAAQ");
  });

  it("strips m./www. host prefixes", () => {
    expect(
      extractSnapchatSpotlightId("https://m.snapchat.com/spotlight/W7_ABCdefGHIjklMNOpqrsAAAAAQ")
    ).toBe("W7_ABCdefGHIjklMNOpqrsAAAAAQ");
  });

  it("returns null for a /t/<code> share link (unresolved — no spotlight id yet)", () => {
    expect(extractSnapchatSpotlightId("https://snapchat.com/t/rfm4p1Y7")).toBeNull();
  });

  it("returns null for a /p/<uuid>/<storyId> story url (not a spotlight)", () => {
    expect(
      extractSnapchatSpotlightId(
        "https://www.snapchat.com/p/4fcb9c20-b0da-45ec-abd7-0106bb9f21ec/3137385781778432?chapterid=3137385781778433"
      )
    ).toBeNull();
  });

  it("returns null for a non-snapchat host", () => {
    expect(extractSnapchatSpotlightId("https://www.youtube.com/spotlight/abc")).toBeNull();
  });

  it("returns null for null/empty/garbage", () => {
    expect(extractSnapchatSpotlightId(null)).toBeNull();
    expect(extractSnapchatSpotlightId("")).toBeNull();
    expect(extractSnapchatSpotlightId("not a url")).toBeNull();
  });
});
