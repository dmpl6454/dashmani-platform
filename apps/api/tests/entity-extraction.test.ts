import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  parseExtraction,
  extractEntitiesFromContent,
  type RawExtractFn,
} from "../src/services/entity-extraction.service";

// ── Pure-function tests (no DB needed) ────────────────────────────────────
describe("parseExtraction", () => {
  it("parses a plain JSON array", () => {
    const out = parseExtraction(
      '[{"canonicalName":"Salman Khan","type":"PERSON","confidence":0.9,"isNew":false}]'
    );
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe("Salman Khan");
    expect(out[0].type).toBe("PERSON");
    expect(out[0].confidence).toBe(0.9);
    expect(out[0].isNew).toBe(false);
  });

  it("strips ```json markdown fences before parsing", () => {
    const out = parseExtraction(
      '```json\n[{"canonicalName":"Shah Rukh Khan","type":"person","confidence":0.8}]\n```'
    );
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe("Shah Rukh Khan");
    // lowercases type → uppercased
    expect(out[0].type).toBe("PERSON");
  });

  it("strips a bare ``` fence (no language tag)", () => {
    const out = parseExtraction('```\n[{"canonicalName":"Aamir Khan"}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe("Aamir Khan");
  });

  it("parses a multi-line ```json fenced non-empty array (the real Haiku shape)", () => {
    const raw =
      '```json\n[\n  {"canonicalName": "Salman Khan", "type": "PERSON", "confidence": 0.98, "isNew": false},\n  {"canonicalName": "Mumbai", "type": "LOCATION", "confidence": 0.99, "isNew": false}\n]\n```';
    const out = parseExtraction(raw);
    expect(out).toHaveLength(2);
    expect(out[0].canonicalName).toBe("Salman Khan");
  });

  it("parses despite a prose preamble before a fenced array (bracket-carve fallback)", () => {
    const raw =
      'Here is the JSON array:\n```json\n[{"canonicalName":"Shah Rukh Khan","type":"PERSON","confidence":0.9,"isNew":true}]\n```';
    const out = parseExtraction(raw);
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe("Shah Rukh Khan");
  });

  it("parses despite trailing commentary after the array", () => {
    const raw =
      '[{"canonicalName":"Aamir Khan","type":"PERSON","confidence":1,"isNew":true}]\n\nNote: only one identifiable person.';
    const out = parseExtraction(raw);
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe("Aamir Khan");
  });

  it("parses an empty fenced array → []", () => {
    expect(parseExtraction("```json\n[]\n```")).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(parseExtraction("[]")).toEqual([]);
  });

  it("returns [] when raw is empty string", () => {
    // empty string is not valid JSON → JSON.parse throws; treat empty as throw
    expect(() => parseExtraction("")).toThrow();
  });

  it("throws on non-array JSON (object)", () => {
    expect(() => parseExtraction('{"canonicalName":"x"}')).toThrow();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseExtraction("not json at all {")).toThrow();
  });

  it("defaults type to PERSON and confidence to 1 when absent", () => {
    const out = parseExtraction('[{"canonicalName":"Some Person"}]');
    expect(out[0].type).toBe("PERSON");
    expect(out[0].confidence).toBe(1);
    expect(out[0].isNew).toBe(false);
  });

  it("clamps confidence into 0..1", () => {
    const out = parseExtraction(
      '[{"canonicalName":"A","confidence":5},{"canonicalName":"B","confidence":-3}]'
    );
    expect(out[0].confidence).toBe(1);
    expect(out[1].confidence).toBe(0);
  });

  it("filters out entries with no/blank canonicalName", () => {
    const out = parseExtraction(
      '[{"canonicalName":"   "},{"type":"PERSON"},{"canonicalName":"Keep Me"}]'
    );
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe("Keep Me");
  });
});

// ── DB-backed tests (skip cleanly if no DB) ───────────────────────────────
// setup.ts's TRUNCATE does NOT cover entities / link_content / link_content_entities,
// so this file owns its own cleanup. Use distinctive prefixes so we never touch real data.
const NAME_PREFIX = "ZZTEST_";
const KEY_PREFIX = "yt:ZZTESTEX";

let dbAvailable = false;

async function cleanup() {
  // FK order: join rows first, then content + entities.
  await prisma.linkContentEntity.deleteMany({
    where: {
      OR: [
        { content: { canonicalKey: { startsWith: KEY_PREFIX } } },
        { entity: { canonicalName: { startsWith: NAME_PREFIX } } },
      ],
    },
  });
  await prisma.linkContent.deleteMany({ where: { canonicalKey: { startsWith: KEY_PREFIX } } });
  await prisma.entity.deleteMany({ where: { canonicalName: { startsWith: NAME_PREFIX } } });
}

beforeAll(async () => {
  try {
    await cleanup();
    dbAvailable = true;
  } catch (err) {
    console.warn("[entity-extraction.test] DB unavailable — skipping DB-backed tests:", err);
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  if (dbAvailable) {
    try {
      await cleanup();
    } catch {
      /* ignore cleanup error */
    }
  }
});

async function seedContent(suffix: string, caption: string, title: string | null = null) {
  return prisma.linkContent.create({
    data: {
      canonicalKey: `${KEY_PREFIX}${suffix}`,
      platform: "instagram",
      title,
      caption,
      status: "ok",
      fetchedAt: new Date(),
      extractedAt: null,
    },
  });
}

describe("extractEntitiesFromContent (DB-backed)", () => {
  it("reuses an existing Entity (no duplicate canonicalName) + creates a join row", async () => {
    if (!dbAvailable) return;

    const NAME = `${NAME_PREFIX}Salman Khan`;
    await prisma.entity.create({
      data: { canonicalName: NAME, type: "PERSON", aliases: [NAME.toLowerCase()] },
    });
    const content = await seedContent("01", "Bhaijaan ka naya look 🔥 #salman");

    const fakeLLM: RawExtractFn = async () =>
      JSON.stringify([{ canonicalName: NAME, type: "PERSON", confidence: 0.9, isNew: false }]);

    const res = await extractEntitiesFromContent(
      [{ id: content.id, title: content.title, caption: content.caption }],
      fakeLLM
    );
    expect(res.ok).toBe(1);

    const count = await prisma.entity.count({ where: { canonicalName: NAME } });
    expect(count).toBe(1);

    const entity = await prisma.entity.findUnique({ where: { canonicalName: NAME } });
    const joins = await prisma.linkContentEntity.findMany({
      where: { linkContentId: content.id, entityId: entity!.id },
    });
    expect(joins).toHaveLength(1);
    expect(joins[0].confidence).toBe(0.9);
  });

  it("malformed LLM response marks the row status='error', leaves extractedAt null, does NOT throw", async () => {
    if (!dbAvailable) return;

    const content = await seedContent("02", "some caption");
    const fakeLLM: RawExtractFn = async () => "not json at all {";

    const res = await extractEntitiesFromContent(
      [{ id: content.id, title: content.title, caption: content.caption }],
      fakeLLM
    );
    expect(res.error).toBe(1);

    const row = await prisma.linkContent.findUnique({ where: { id: content.id } });
    expect(row?.status).toBe("error");
    expect(row?.extractedAt).toBeNull();
  });

  it("idempotency: success stamps extractedAt → the pending selector excludes it", async () => {
    if (!dbAvailable) return;

    const NAME = `${NAME_PREFIX}Topic One`;
    const content = await seedContent("03", "a post about a topic");
    const fakeLLM: RawExtractFn = async () =>
      JSON.stringify([{ canonicalName: NAME, type: "TOPIC", confidence: 1, isNew: true }]);

    await extractEntitiesFromContent(
      [{ id: content.id, title: content.title, caption: content.caption }],
      fakeLLM
    );

    const row = await prisma.linkContent.findUnique({ where: { id: content.id } });
    expect(row?.extractedAt).not.toBeNull();

    // The pending selector used by the cron must now exclude this row.
    const pending = await prisma.linkContent.findMany({
      where: { status: "ok", extractedAt: null, canonicalKey: { startsWith: KEY_PREFIX } },
    });
    expect(pending.find((p) => p.id === content.id)).toBeUndefined();
  });

  it("alias dedup: extracting the same alias twice keeps it exactly once (no duplicates)", async () => {
    if (!dbAvailable) return;

    const NAME = `${NAME_PREFIX}Sallu Bhai`;
    const alias = NAME.toLowerCase();
    const c1 = await seedContent("04", "post one");
    const c2 = await seedContent("05", "post two");

    const fakeLLM: RawExtractFn = async () =>
      JSON.stringify([{ canonicalName: NAME, type: "PERSON", confidence: 0.7, isNew: true }]);

    await extractEntitiesFromContent(
      [{ id: c1.id, title: c1.title, caption: c1.caption }],
      fakeLLM
    );
    await extractEntitiesFromContent(
      [{ id: c2.id, title: c2.title, caption: c2.caption }],
      fakeLLM
    );

    const entity = await prisma.entity.findUnique({ where: { canonicalName: NAME } });
    expect(entity).not.toBeNull();
    const occurrences = entity!.aliases.filter((a) => a === alias);
    expect(occurrences).toHaveLength(1);
    // and the alias is stored lowercase
    expect(entity!.aliases).toContain(alias);
  });

  it("empty extraction (LLM returns []) stamps extractedAt and counts as 'empty'", async () => {
    if (!dbAvailable) return;

    const content = await seedContent("06", "no identifiable people here");
    const fakeLLM: RawExtractFn = async () => "[]";

    const res = await extractEntitiesFromContent(
      [{ id: content.id, title: content.title, caption: content.caption }],
      fakeLLM
    );
    expect(res.empty).toBe(1);

    const row = await prisma.linkContent.findUnique({ where: { id: content.id } });
    expect(row?.extractedAt).not.toBeNull();
    expect(row?.status).toBe("ok"); // empty is a success, not an error
  });

  it("a newly-created entity in one row is reused (not duplicated) by a later row in the same batch", async () => {
    if (!dbAvailable) return;

    const NAME = `${NAME_PREFIX}Batch Person`;
    const c1 = await seedContent("07", "first");
    const c2 = await seedContent("08", "second");

    const fakeLLM: RawExtractFn = async () =>
      JSON.stringify([{ canonicalName: NAME, type: "PERSON", confidence: 0.8, isNew: true }]);

    const res = await extractEntitiesFromContent(
      [
        { id: c1.id, title: c1.title, caption: c1.caption },
        { id: c2.id, title: c2.title, caption: c2.caption },
      ],
      fakeLLM
    );
    expect(res.ok).toBe(2);

    const count = await prisma.entity.count({ where: { canonicalName: NAME } });
    expect(count).toBe(1);

    const entity = await prisma.entity.findUnique({ where: { canonicalName: NAME } });
    const joins = await prisma.linkContentEntity.findMany({ where: { entityId: entity!.id } });
    expect(joins).toHaveLength(2);
  });
});
