/**
 * pipeline/shared-pipeline.test.ts — the pure pipeline modules in @dashmani/shared.
 *
 * These run on the API AND in the HR bundle, so every one of them must be linear on
 * adversarial input (the 2026-09-08 main-thread-hang class) and must use no regex
 * lookbehind (older iOS Safari throws at PARSE time and takes the whole page down).
 *
 *   rank.ts      — vendored CC0 fractional indexing; ordering is plain code-unit
 *                  comparison (= Postgres COLLATE "C"), never localeCompare.
 *   mentions.ts  — `@{uuid}` tokens, unique, capped at 20.
 *   text.ts      — normalizeText / stripBidi / notificationSnippet (§3.5, §7.9).
 *   validators   — length bounds BEFORE any transform, dates, deduped id arrays, emoji.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  keyBetween,
  nKeysBetween,
  compareRank,
  rankNeedsRebalance,
  RANK_MAX_LENGTH,
  extractMentionIds,
  MentionLimitError,
  MAX_MENTIONS,
  normalizeText,
  stripBidi,
  notificationSnippet,
  truncateGraphemes,
  pipelineValidators as v,
  PIPELINE_REACTION_KEYS,
} from "@dashmani/shared";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHARED_PIPELINE = path.resolve(__dirname, "../../../../packages/shared/src/pipeline");

describe("rank (fractional indexing)", () => {
  it("keyBetween(null, null) returns a key", () => {
    const k = keyBetween(null, null);
    expect(typeof k).toBe("string");
    expect(k.length).toBeGreaterThan(0);
  });

  it("keyBetween(a, b) sorts strictly between a and b under compareRank", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(compareRank(a, b)).toBe(-1);
    let lo = a;
    let hi = b;
    // Repeatedly bisect toward the low end and the high end: every key stays strictly inside.
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(lo, hi);
      expect(compareRank(lo, mid)).toBe(-1);
      expect(compareRank(mid, hi)).toBe(-1);
      if (i % 2 === 0) hi = mid;
      else lo = mid;
    }
  });

  it("keys generated in order are already sorted, and nKeysBetween returns N ordered keys", () => {
    const keys = nKeysBetween(null, null, 50);
    expect(keys).toHaveLength(50);
    const sorted = [...keys].sort(compareRank);
    expect(sorted).toEqual(keys);
    const inner = nKeysBetween(keys[10], keys[11], 7);
    expect(inner).toHaveLength(7);
    for (const k of inner) {
      expect(compareRank(keys[10], k)).toBe(-1);
      expect(compareRank(k, keys[11])).toBe(-1);
    }
  });

  it("1,000 successive inserts at the top stay within 64 characters (or report a rebalance)", () => {
    let top = keyBetween(null, null);
    const all = [top];
    for (let i = 0; i < 1000; i++) {
      top = keyBetween(null, top);
      all.push(top);
    }
    expect(Math.max(...all.map((k) => k.length))).toBeLessThanOrEqual(RANK_MAX_LENGTH);
    expect(all.some(rankNeedsRebalance)).toBe(false);
    // Newest-first insertion order is the reverse of rank order.
    expect([...all].sort(compareRank)).toEqual([...all].reverse());
  });

  it("repeated inserts into one shrinking gap eventually report that a rebalance is needed", () => {
    // Always dropping a card directly under the same card bisects one gap forever, so
    // the key grows (~1 character per 6 inserts). The helper must flag it before a key
    // longer than the VarChar(64) column could be written.
    const lo = keyBetween(null, null);
    let hi = keyBetween(lo, null);
    let flaggedAt = -1;
    for (let i = 0; i < 1000; i++) {
      const k = keyBetween(lo, hi);
      expect(compareRank(lo, k)).toBe(-1);
      expect(compareRank(k, hi)).toBe(-1);
      if (rankNeedsRebalance(k)) {
        flaggedAt = i;
        expect(k.length).toBe(RANK_MAX_LENGTH + 1);
        break;
      }
      expect(k.length).toBeLessThanOrEqual(RANK_MAX_LENGTH);
      hi = k;
    }
    expect(flaggedAt).toBeGreaterThan(0);
    expect(rankNeedsRebalance("a".repeat(RANK_MAX_LENGTH + 1))).toBe(true);
    expect(rankNeedsRebalance("a0")).toBe(false);
  });

  it("compareRank orders by code unit (COLLATE \"C\"), unlike a locale compare", () => {
    // In C collation every uppercase letter sorts before every lowercase letter.
    expect(compareRank("Zz", "a0")).toBe(-1);
    expect(compareRank("a0", "a0")).toBe(0);
    expect(compareRank("b", "a")).toBe(1);
    expect(["a0", "Zz", "a1", "Zy"].sort(compareRank)).toEqual(["Zy", "Zz", "a0", "a1"]);
  });

  it("rejects an inverted or equal range", () => {
    expect(() => keyBetween("a1", "a0")).toThrow();
    expect(() => keyBetween("a0", "a0")).toThrow();
  });

  it("the pipeline sources never use localeCompare or a regex lookbehind", () => {
    for (const f of fs.readdirSync(SHARED_PIPELINE)) {
      const src = fs.readFileSync(path.join(SHARED_PIPELINE, f), "utf8");
      expect(src.includes(".localeCompare("), `${f} uses localeCompare`).toBe(false);
      expect(/\(\?<[=!]/.test(src), `${f} uses a regex lookbehind`).toBe(false);
    }
    const validators = fs.readFileSync(
      path.resolve(SHARED_PIPELINE, "../validators/pipeline.ts"),
      "utf8",
    );
    expect(/\(\?<[=!]/.test(validators)).toBe(false);
  });
});

describe("mentions", () => {
  it("returns the unique ids in first-seen order", () => {
    const a = U(1);
    const b = U(2);
    expect(extractMentionIds(`hi @{${a}} and @{${b}} and again @{${a}}`)).toEqual([a, b]);
  });

  it("ignores malformed tokens", () => {
    const a = U(3);
    const body = [
      "@{not-a-uuid}",
      `@{${a}`, // unterminated
      `@${a}`, // no braces
      `@{${a.slice(0, 35)}}`, // one short
      `@{${a}x}`, // one long
      "@{zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz}",
      "@{",
      "@",
    ].join(" ");
    expect(extractMentionIds(body)).toEqual([]);
  });

  it("allows 20 unique ids and throws MENTION_LIMIT at 21", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `@{${U(i + 1)}}`).join(" ");
    expect(extractMentionIds(twenty)).toHaveLength(MAX_MENTIONS);
    const twentyOne = `${twenty} @{${U(99)}}`;
    try {
      extractMentionIds(twentyOne);
      throw new Error("expected MentionLimitError");
    } catch (err) {
      expect(err).toBeInstanceOf(MentionLimitError);
      expect((err as MentionLimitError).code).toBe("MENTION_LIMIT");
    }
    // Repeats of one id do not count toward the limit.
    expect(extractMentionIds(Array.from({ length: 50 }, () => `@{${U(7)}}`).join(" "))).toEqual([U(7)]);
  });

  it("scans a 1 MB adversarial input in under 50 ms", () => {
    const inputs = ["@{".repeat(500_000), "@".repeat(1_000_000), `@{${"0".repeat(40)}`.repeat(25_000)];
    for (const input of inputs) {
      const t0 = performance.now();
      expect(extractMentionIds(input)).toEqual([]);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});

describe("text", () => {
  it("stripBidi removes every bidi control listed in §3.5", () => {
    const controls = ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "‎", "‏", "؜"];
    expect(stripBidi(`a${controls.join("")}b`)).toBe("ab");
  });

  it("normalizeText strips bidi and C0 controls (except \\n and \\t), applies NFC, converts CRLF and trims", () => {
    const decomposed = "é"; // é as e + combining acute
    const input = `  ‮hello\u0000\u0007 ${decomposed}\r\nline2\tTab‏  `;
    expect(normalizeText(input)).toBe(`hello é\nline2\tTab`);
    expect(normalizeText("a\r\n\r\nb")).toBe("a\n\nb");
    expect(normalizeText("   ")).toBe("");
  });

  it("notificationSnippet renders mentions as names and collapses whitespace", () => {
    const id = U(5);
    expect(notificationSnippet(`a @{${id}} b`, { [id]: "Priya" }, 10)).toBe("a @Priya b");
    expect(notificationSnippet(`a\n\n  @{${id}}\t b`, new Map([[id, "Priya"]]), 100)).toBe("a @Priya b");
  });

  it("notificationSnippet truncates on a grapheme boundary with an ellipsis", () => {
    const id = U(6);
    expect(notificationSnippet(`a @{${id}} b`, { [id]: "Priya" }, 6)).toBe("a @Pr…");
    // A family emoji is ONE grapheme of 11 code units — it is never split.
    const family = "👨‍👩‍👧‍👦";
    const out = notificationSnippet(`${family}${family}${family}`, {}, 2);
    expect(out).toBe(`${family}…`);
    // Devanagari conjuncts are kept whole.
    const hindi = notificationSnippet("नमस्ते दुनिया", {}, 4);
    expect(hindi.endsWith("…")).toBe(true);
    expect(truncateGraphemes("abc", 3)).toBe("abc");
    expect(truncateGraphemes("abcd", 3)).toBe("ab…");
  });

  it("notificationSnippet never contains `@{` or a lone surrogate", () => {
    const outputs = [
      notificationSnippet(`@{${U(9)}} unknown user`, {}, 100),
      notificationSnippet("typed by hand: @{abc and @{", {}, 100),
      notificationSnippet("lone \uD800 high and \uDC00 low", {}, 100),
      notificationSnippet("😀😀\uD83D", {}, 100),
      notificationSnippet(`${"😀".repeat(30)}`, {}, 5),
      notificationSnippet("‮spoof‬", {}, 100),
    ];
    for (const s of outputs) {
      expect(s.includes("@{")).toBe(false);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
          i++;
        } else {
          expect(c >= 0xdc00 && c <= 0xdfff).toBe(false);
        }
      }
      expect(/[‪-‮⁦-⁩‎‏؜]/.test(s)).toBe(false);
    }
    expect(outputs[0]).toBe("@someone unknown user");
  });
});

describe("validators", () => {
  it("a title over 240 characters is rejected before the tag-stripping transform runs", () => {
    const t0 = performance.now();
    const r = v.pipelineTitle.safeParse("<".repeat(1_000_000));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].code).toBe("too_big");
  });

  it("title: bidi and tags stripped, 1–120 characters after the transform", () => {
    expect(v.pipelineTitle.parse("  ‮Diwali <b>campaign</b> ")).toBe("Diwali campaign");
    expect(v.pipelineTitle.safeParse("<i></i>").success).toBe(false);
    expect(v.pipelineTitle.safeParse("x".repeat(121)).success).toBe(false);
    expect(v.pipelineTitle.safeParse("x".repeat(120)).success).toBe(true);
  });

  it("body: over 4,000 characters fails; empty after normalisation fails; normalised on success", () => {
    expect(v.pipelineBody.safeParse("x".repeat(4001)).success).toBe(false);
    expect(v.pipelineBody.safeParse("x".repeat(4000)).success).toBe(true);
    expect(v.pipelineBody.safeParse(" ‮ \r\n ").success).toBe(false);
    expect(v.pipelineBody.parse("hi\r\nthere\u0000")).toBe("hi\nthere");
    // 1 MB of '<' is rejected by the length bound in well under 50 ms.
    const t0 = performance.now();
    expect(v.pipelineBody.safeParse("<".repeat(1_000_000)).success).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(v.pipelineDescription.safeParse("x".repeat(5001)).success).toBe(false);
    expect(v.pipelineDescription.parse("")).toBe("");
  });

  it("dates must be real calendar days in YYYY-MM-DD, and start must not be after due", () => {
    expect(v.pipelineDate.safeParse("2026-02-29").success).toBe(false);
    expect(v.pipelineDate.safeParse("2028-02-29").success).toBe(true);
    expect(v.pipelineDate.safeParse("2026-13-01").success).toBe(false);
    expect(v.pipelineDate.safeParse("2026-9-1").success).toBe(false);
    expect(v.pipelineDate.safeParse("2026-09-01T00:00:00Z").success).toBe(false);
    const base = { clientId: U(1), title: "T" };
    expect(v.createProjectSchema.safeParse({ ...base, startDate: "2026-10-02", dueDate: "2026-10-01" }).success).toBe(false);
    expect(v.createProjectSchema.safeParse({ ...base, startDate: "2026-10-01", dueDate: "2026-10-01" }).success).toBe(true);
    const bad = v.createProjectSchema.safeParse({ ...base, startDate: "2026-10-05", dueDate: "2026-10-01" });
    expect(!bad.success && bad.error.issues.some((i) => i.message === "DATE_ORDER")).toBe(true);
  });

  it("id arrays are de-duplicated (after the 20 cap), lowercased and uuid-checked", () => {
    const a = U(1);
    const b = U(2);
    const r = v.createProjectSchema.parse({ clientId: U(9), title: "T", memberIds: [a, a.toUpperCase(), b, b] });
    expect(r.memberIds).toEqual([a, b]);
    expect(v.addMembersSchema.safeParse({ userIds: [] }).success).toBe(false);
    expect(v.addMembersSchema.safeParse({ userIds: Array.from({ length: 21 }, (_, i) => U(i)) }).success).toBe(false);
    expect(v.addMembersSchema.parse({ userIds: [b, b] }).userIds).toEqual([b]);
    expect(v.addMembersSchema.safeParse({ userIds: ["not-a-uuid"] }).success).toBe(false);
  });

  it("an emoji outside the 8 keys fails", () => {
    expect(PIPELINE_REACTION_KEYS).toHaveLength(8);
    for (const k of PIPELINE_REACTION_KEYS) expect(v.reactionParamsSchema.safeParse({ mid: U(1), emoji: k }).success).toBe(true);
    expect(v.reactionParamsSchema.safeParse({ mid: U(1), emoji: "skull" }).success).toBe(false);
    expect(v.reactionParamsSchema.safeParse({ mid: U(1), emoji: "👍" }).success).toBe(false);
  });

  it("the sync request is bounded (int4 cursors, ≤ 50 seen ids, ≤ 64-character mineH)", () => {
    const ok = v.syncRequestSchema.safeParse({
      clientBuild: 1,
      board: { v: -1 },
      mineH: "3f9a",
      project: { id: U(1), rev: 0, hv: 0, ack: { seq: 5, seen: [U(2), U(2)] } },
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.project?.ack?.seen).toEqual([U(2)]);
    expect(v.syncRequestSchema.safeParse({ clientBuild: 1, board: { v: -2 } }).success).toBe(false);
    expect(v.syncRequestSchema.safeParse({ clientBuild: 1, mineH: "x".repeat(65) }).success).toBe(false);
    expect(v.syncRequestSchema.safeParse({ clientBuild: 1, project: { id: U(1), rev: 2 ** 31, hv: 0 } }).success).toBe(false);
    expect(
      v.syncRequestSchema.safeParse({
        clientBuild: 1,
        project: { id: U(1), rev: 0, hv: 0, ack: { seq: 0, seen: Array.from({ length: 51 }, (_, i) => U(i)) } },
      }).success,
    ).toBe(false);
    expect(v.syncRequestSchema.safeParse({}).success).toBe(false);
  });

  it("an edit must name at least one field and carry a base for every changed field", () => {
    expect(v.editProjectSchema.safeParse({ changes: {}, base: {} }).success).toBe(false);
    expect(v.editProjectSchema.safeParse({ changes: { title: "New" }, base: {} }).success).toBe(false);
    expect(v.editProjectSchema.safeParse({ changes: { title: "New" }, base: { title: "Old" } }).success).toBe(true);
    expect(v.editProjectSchema.safeParse({ changes: { dueDate: null }, base: { dueDate: "2026-10-01" } }).success).toBe(true);
  });
});
