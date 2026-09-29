import { describe, it, expect } from "vitest";
import { safeString, safeStringMin, stripTagsLinear } from "@dashmani/shared";

/**
 * P11 — linear `safeString`.
 *
 * The old transform was `s.replace(/<[^>]*>/g, "").trim()`. On input with a `<` that has
 * no later `>`, V8's backtracking engine rescans the rest of the string from EVERY `<`,
 * which is O(n²): measured locally, 40 KB of "<" took 1.9 s and 80 KB took 5.3 s, all of it
 * synchronous on the API's single main thread (the 2026-09-08 hang class). 32 validators
 * use it on free-text fields, express.json() accepts 10 MB bodies, and every caller's
 * `.max()` runs only after the transform has already seen the whole string.
 *
 * The replacement must be BYTE-IDENTICAL to the regex, so the old expression is kept here
 * as the oracle and every case is compared against it.
 */
const OLD_STRIP = (s: string) => s.replace(/<[^>]*>/g, "");
const OLD_SAFE = (s: string) => OLD_STRIP(s).trim();

/** Deterministic PRNG (mulberry32) so a failing case reproduces exactly. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brackets are over-weighted so tags, unmatched "<" and stray ">" are all common.
// Whitespace kinds that String.prototype.trim() removes are included (tab, newline,
// NBSP, U+2028) because trim runs after the strip and must see the same string.
const ALPHABET = [
  "<", "<", "<", "<", ">", ">", ">", ">",
  "a", "b", "z", "Q", "0", " ", " ", " ",
  "\t", "\n", " ", " ", "é", "😀", "/", "=", "\"",
];

function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * (maxLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

const EDGE_CASES = [
  "", " ", "<", ">", "<>", "><", "<<", ">>", "<<>>", "<><>", "a<b", "a>b", "a<b>c",
  "a>b<c", "<a", "a>", "< >", "<\n>", "  <b>bold</b>  ", "<script>alert(1)</script>x",
  "x <img src=x onerror=alert(1)> y", "1 < 2 and 3 > 2", "a < b", "<<a>", "<a<b>c>",
  "text<", "text <b>", " <i>x</i> ", "<😀>😀", "\n\t<p>\n</p>\t\n",
];

describe("P11 linear safeString", () => {
  it("stripTagsLinear matches the old regex on the hand-picked edge cases", () => {
    for (const s of EDGE_CASES) {
      expect(stripTagsLinear(s), JSON.stringify(s)).toBe(OLD_STRIP(s));
      expect(safeString.parse(s), JSON.stringify(s)).toBe(OLD_SAFE(s));
    }
  });

  it("property: 2,000 generated strings (length 0–200) are byte-identical to the old regex", () => {
    const rand = mulberry32(0x5afe5);
    for (let i = 0; i < 2000; i++) {
      const s = randomString(rand, 200);
      expect(stripTagsLinear(s), JSON.stringify(s)).toBe(OLD_STRIP(s));
      expect(safeString.parse(s), JSON.stringify(s)).toBe(OLD_SAFE(s));
    }
  });

  it("property: 200 longer strings (length 0–5,000) are byte-identical to the old regex", () => {
    const rand = mulberry32(0xb16);
    for (let i = 0; i < 200; i++) {
      const s = randomString(rand, 5000);
      expect(safeString.parse(s)).toBe(OLD_SAFE(s));
    }
  });

  it("safeStringMin keeps its transform and its minimum-length refinement", () => {
    const min3 = safeStringMin(3);
    expect(min3.parse("  <b>abc</b>  ")).toBe("abc");
    expect(min3.safeParse("<b>ab</b>").success).toBe(false);
    const rand = mulberry32(0x3171);
    for (let i = 0; i < 500; i++) {
      const s = randomString(rand, 60);
      const expected = OLD_SAFE(s);
      const res = min3.safeParse(s);
      expect(res.success, JSON.stringify(s)).toBe(expected.length >= 3);
      if (res.success) expect(res.data).toBe(expected);
    }
  });

  it("1 MB of '<' (no closing '>') finishes in under 50 ms", () => {
    const big = "<".repeat(1024 * 1024);
    const t0 = performance.now();
    const out = safeString.parse(big);
    const ms = performance.now() - t0;
    expect(out).toBe(big); // an unmatched "<" is kept verbatim, exactly as the regex did
    expect(ms).toBeLessThan(50);
  });

  it("1 MB of alternating tags and text stays linear (under 250 ms)", () => {
    // ~116k spans. Measured ~15 ms locally; the looser bound keeps a slower CI runner from
    // flaking while still catching any O(n²) regression (that would take seconds).
    const big = "<b>x</b> ".repeat(Math.ceil((1024 * 1024) / 9));
    const t0 = performance.now();
    const out = safeString.parse(big);
    const ms = performance.now() - t0;
    expect(out).toBe(OLD_SAFE(big)); // this shape is linear for the regex too
    expect(ms).toBeLessThan(250);
  });
});
