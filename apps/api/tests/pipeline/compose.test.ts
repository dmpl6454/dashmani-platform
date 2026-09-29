/**
 * pipeline/compose.test.ts — the message tokeniser and composer rules (spec §9.6).
 *
 * These run in the HR bundle on every message and keystroke, so they must be LINEAR on
 * adversarial input and must never turn `javascript:` or pasted text into something live.
 */
import { describe, it, expect } from "vitest";
import {
  tokenizeBody,
  shiftRanges,
  findMentionTrigger,
  insertMention,
  serializeDraft,
  parseDraft,
  shouldEnterSend,
  composerLengthState,
  extractMentionIds,
  MENTION_NEUTRALIZER,
  PIPELINE_LIMITS,
  type MentionRange,
} from "@dashmani/shared";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("tokenizeBody", () => {
  it("splits text, @{uuid} mentions and http(s) links", () => {
    expect(tokenizeBody(`hi @{${A}} see https://example.com/a?b=1 ok`)).toEqual([
      { kind: "text", text: "hi " },
      { kind: "mention", id: A, raw: `@{${A}}` },
      { kind: "text", text: " see " },
      { kind: "url", href: "https://example.com/a?b=1", text: "example.com/a?b=1", raw: "https://example.com/a?b=1" },
      { kind: "text", text: " ok" },
    ]);
  });

  it("never turns javascript:, data: or other schemes into links", () => {
    for (const s of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "ftp://x.com", "vbscript:x"]) {
      expect(tokenizeBody(s).every((t) => t.kind === "text")).toBe(true);
    }
    expect(tokenizeBody("xhttps://evil.com").every((t) => t.kind === "text")).toBe(true);
  });

  it("trims trailing punctuation but keeps a balanced ')'", () => {
    const urls = (s: string) => tokenizeBody(s).filter((t) => t.kind === "url").map((t) => (t as { href: string }).href);
    expect(urls("(see https://x.com/a).")).toEqual(["https://x.com/a"]);
    expect(urls("go to https://x.com/a, then https://y.com!")).toEqual(["https://x.com/a", "https://y.com/"]);
    expect(urls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(urls("HTTPS://X.COM/Path")).toEqual(["https://x.com/Path"]);
  });

  it("renders link text from the parsed URL (punycode host)", () => {
    const t = tokenizeBody("https://bücher.de/x").find((x) => x.kind === "url") as { text: string };
    expect(t.text).toBe("xn--bcher-kva.de/x");
  });

  it("malformed @{…} stays text", () => {
    expect(tokenizeBody("@{not-a-uuid} @{").every((t) => t.kind === "text")).toBe(true);
  });

  it("is linear: a 1 MB adversarial input tokenises in under 50 ms", () => {
    const inputs = [
      "https://".repeat(131_072),
      "@{".repeat(524_288),
      "h".repeat(1_048_576),
      ("https://a.b/" + "(".repeat(50) + " ").repeat(16_000),
    ];
    tokenizeBody("warm https://x.com @{" + A + "}");
    for (const s of inputs) {
      const t0 = performance.now();
      tokenizeBody(s);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});

describe("mention ranges", () => {
  const r = (start: number, label: string, userId = A): MentionRange => ({ start, end: start + label.length, userId, label });

  it("shift when text before them changes", () => {
    const prev = "hi @Aisha ok";
    const ranges = [r(3, "@Aisha")];
    expect(shiftRanges(ranges, prev, "hello hi @Aisha ok")).toEqual([r(9, "@Aisha")]);
    expect(shiftRanges(ranges, prev, "i @Aisha ok")).toEqual([r(2, "@Aisha")]);
    expect(shiftRanges(ranges, prev, "hi @Aisha ok!!")).toEqual(ranges);
  });

  it("drop when their own text changes", () => {
    const ranges = [r(3, "@Aisha")];
    expect(shiftRanges(ranges, "hi @Aisha ok", "hi @Aish ok")).toEqual([]);
    expect(shiftRanges(ranges, "hi @Aisha ok", "hi @AishXa ok")).toEqual([]);
    expect(shiftRanges(ranges, "hi @Aisha ok", "hi ok")).toEqual([]);
  });

  it("finds the trigger only at the start or after whitespace, within 30 chars", () => {
    expect(findMentionTrigger("@ai", 3)).toEqual({ start: 0, query: "ai" });
    expect(findMentionTrigger("hi @Aisha K", 11)).toEqual({ start: 3, query: "Aisha K" });
    expect(findMentionTrigger("mail me@x", 9)).toBeNull();
    expect(findMentionTrigger("@" + "a".repeat(31), 32)).toBeNull();
    expect(findMentionTrigger("@a\nb", 4)).toBeNull();
    expect(findMentionTrigger("@Aisha ", 7, [r(0, "@Aisha")])).toBeNull();
  });

  it("insertMention replaces the query and records a range; two same-named users stay distinct", () => {
    const t1 = insertMention("ping @ai", [], { start: 5, query: "ai" }, 8, { id: A, name: "Aisha" });
    expect(t1.text).toBe("ping @Aisha ");
    const t2 = insertMention(t1.text + "@ai", t1.ranges, { start: 12, query: "ai" }, 15, { id: B, name: "Aisha" });
    expect(t2.text).toBe("ping @Aisha @Aisha ");
    expect(extractMentionIds(serializeDraft(t2.text, t2.ranges))).toEqual([A, B]);
  });

  it("pasted text is never tokenised", () => {
    const pasted = `look @{${B}} here`;
    const body = serializeDraft(pasted, []);
    expect(extractMentionIds(body)).toEqual([]);
    expect(body).toBe(`look @${MENTION_NEUTRALIZER}{${B}} here`);
  });
});

describe("drafts", () => {
  it("serializeDraft round-trips mentions through parseDraft", () => {
    const names: Record<string, string> = { [A]: "Aisha Khan", [B]: "Rahul" };
    const stored = `Hey @{${A}} and @{${B}}, see https://x.com`;
    const parsed = parseDraft(stored, (id) => names[id] ?? "former member");
    expect(parsed.text).toBe("Hey @Aisha Khan and @Rahul, see https://x.com");
    expect(serializeDraft(parsed.text, parsed.ranges)).toBe(stored);
  });
});

describe("shouldEnterSend", () => {
  const desktop = { finePointer: true, maxTouchPoints: 0 };
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
  it("sends on a real keyboard + mouse", () => expect(shouldEnterSend(enter, desktop)).toBe(true));
  it("not on touch", () => expect(shouldEnterSend(enter, { finePointer: false, maxTouchPoints: 5 })).toBe(false));
  it("not in iPhone Desktop Site mode (fine pointer but maxTouchPoints > 0)", () =>
    expect(shouldEnterSend(enter, { finePointer: true, maxTouchPoints: 5 })).toBe(false));
  it("not during IME composition or keyCode 229", () => {
    expect(shouldEnterSend({ ...enter, isComposing: true }, desktop)).toBe(false);
    expect(shouldEnterSend({ ...enter, keyCode: 229 }, desktop)).toBe(false);
  });
  it("not with Shift, and only for Enter", () => {
    expect(shouldEnterSend({ ...enter, shiftKey: true }, desktop)).toBe(false);
    expect(shouldEnterSend({ ...enter, key: "a" }, desktop)).toBe(false);
  });
  it("length states: counter above 3,600, error above 4,000", () => {
    expect(composerLengthState(3600, PIPELINE_LIMITS)).toBe("ok");
    expect(composerLengthState(3601, PIPELINE_LIMITS)).toBe("counter");
    expect(composerLengthState(4001, PIPELINE_LIMITS)).toBe("over");
  });
});
