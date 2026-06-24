import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

const MODEL = "claude-haiku-4-5-20251001";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AppError(500, "AI_NOT_CONFIGURED", "AI service is not configured. Set ANTHROPIC_API_KEY.");
  }
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export interface ExtractedEntity {
  canonicalName: string;
  type: string; // PERSON | TOPIC | BRAND | OTHER
  confidence: number; // 0..1
  isNew: boolean;
}

/** Raw LLM call: (caption, title, knownNames) → raw JSON string. Injectable for tests. */
export type RawExtractFn = (caption: string, title: string, knownNames: string[]) => Promise<string>;

const defaultRawExtract: RawExtractFn = async (caption, title, knownNames) => {
  const client = getClient();
  const system = [
    "You extract the real-world PEOPLE, public figures, brands, and notable topics that a social-media post is ABOUT.",
    "You are given a post's TITLE and CAPTION (often Hindi/Hinglish, emoji, hashtags) and a list of ALREADY-KNOWN canonical names.",
    "Rules:",
    "- Resolve nicknames/aliases/handles to the real person. e.g. 'Bhaijaan','Sallu','@beingsalmankhan','सलमान' => 'Salman Khan'. 'SRK','King Khan' => 'Shah Rukh Khan'.",
    "- If a person/topic matches one in the KNOWN list, REUSE that exact canonicalName and set isNew=false.",
    "- Only set isNew=true for a genuinely new person/topic not in the KNOWN list.",
    "- type is one of PERSON, BRAND, TOPIC, OTHER. Prefer PERSON for named individuals.",
    "- Do NOT invent people not implied by the text. If nothing identifiable, return [].",
    "Return ONLY a strict JSON array (no prose, no markdown fences) of objects:",
    '[{"canonicalName": "Salman Khan", "type": "PERSON", "confidence": 0.95, "isNew": false}]',
  ].join("\n");
  const userPrompt = `KNOWN canonical names: ${JSON.stringify(knownNames)}\n\nTITLE: ${title || "(none)"}\nCAPTION: ${caption || "(none)"}`;
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
};

/**
 * Parse the LLM's JSON array of entities. Robust against the ways Haiku wraps its
 * reply: a bare array, a ```json/``` fence, a fence plus a prose preamble
 * ("Here is the JSON:\n```json\n[...]"), or trailing commentary after the array.
 * Strategy (in order):
 *   1. Direct JSON.parse of the trimmed string.
 *   2. Strip a leading/trailing markdown fence, then parse.
 *   3. Last resort: extract the substring from the FIRST '[' to the LAST ']' and
 *      parse that — immune to preamble prose, fence artifacts, and trailing text.
 * Throws only if all three fail OR the result isn't an array (caller marks the
 * row status='error'). This is shared by the cron + backfill, so hardening it
 * fixes forward extraction too — Haiku frequently returns ```json fences despite
 * the "no markdown fences" instruction.
 */
export function parseExtraction(raw: string): ExtractedEntity[] {
  const original = (raw || "").trim();

  const tryParse = (candidate: string): unknown | undefined => {
    const c = candidate.trim();
    if (!c) return undefined;
    try {
      return JSON.parse(c);
    } catch {
      return undefined;
    }
  };

  let data: unknown;

  // 1. Direct parse.
  data = tryParse(original);

  // 2. Strip a leading/trailing markdown fence.
  if (data === undefined) {
    const defenced = original
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    data = tryParse(defenced);
  }

  // 3. Last resort: carve out the first '[' .. last ']' span. Handles a prose
  //    preamble before the array and/or commentary after it.
  if (data === undefined) {
    const start = original.indexOf("[");
    const end = original.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      data = tryParse(original.slice(start, end + 1));
    }
  }

  if (data === undefined) {
    // Nothing parsed — let the caller mark the row error (same contract as before).
    throw new Error("extraction: no parseable JSON array in LLM reply");
  }
  if (!Array.isArray(data)) throw new Error("extraction not an array");
  return data
    .filter((d) => d && typeof d.canonicalName === "string" && d.canonicalName.trim())
    .map((d) => ({
      canonicalName: String(d.canonicalName).trim(),
      type: typeof d.type === "string" ? d.type.toUpperCase() : "PERSON",
      confidence: typeof d.confidence === "number" ? Math.max(0, Math.min(1, d.confidence)) : 1,
      isNew: !!d.isNew,
    }));
}

/** Make a lowercase alias from a canonicalName (used for fuzzy/alias search). */
function aliasOf(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Persist extracted entities for one LinkContent row:
 *  - upsert each Entity by canonicalName (create new, or merge the lowercased alias into existing)
 *  - create LinkContentEntity join rows (skipDuplicates)
 *  - stamp LinkContent.extractedAt
 * Alias merge is dedup-safe: after push, normalize aliases to DISTINCT via a raw UPDATE.
 */
export async function resolveAndPersist(linkContentId: string, extracted: ExtractedEntity[]): Promise<void> {
  for (const e of extracted) {
    const alias = aliasOf(e.canonicalName);
    const entity = await prisma.entity.upsert({
      where: { canonicalName: e.canonicalName },
      create: { canonicalName: e.canonicalName, type: e.type, aliases: [alias] },
      update: {}, // do not blow away type on every sighting
    });
    // dedup-safe alias merge: ensure the lowercased alias is present exactly once.
    // array_append then array(distinct) via raw SQL avoids the read-modify-write race.
    await prisma.$executeRaw`
      UPDATE entities
      SET aliases = ARRAY(SELECT DISTINCT unnest(array_append(aliases, ${alias})))
      WHERE id = ${entity.id} AND NOT (${alias} = ANY(aliases))
    `;
    await prisma.linkContentEntity.createMany({
      data: [{ linkContentId, entityId: entity.id, confidence: e.confidence }],
      skipDuplicates: true,
    });
  }
  await prisma.linkContent.update({
    where: { id: linkContentId },
    data: { extractedAt: new Date() },
  });
}

/**
 * Process one LinkContent row end-to-end. Never throws: a parse/LLM error marks the
 * row status='error' (which the status='ok' selector excludes → no re-pay) and returns "error".
 */
export async function extractOne(
  row: { id: string; title: string | null; caption: string | null },
  knownNames: string[],
  rawExtract: RawExtractFn = defaultRawExtract
): Promise<"ok" | "error" | "empty"> {
  try {
    const raw = await rawExtract(row.caption ?? "", row.title ?? "", knownNames);
    const extracted = parseExtraction(raw);
    await resolveAndPersist(row.id, extracted);
    return extracted.length ? "ok" : "empty";
  } catch (err) {
    console.error(`[entity-extraction] failed for linkContent ${row.id}:`, err instanceof Error ? err.message : err);
    try {
      await prisma.linkContent.update({ where: { id: row.id }, data: { status: "error" } });
    } catch (markErr) {
      console.error(`[entity-extraction] also failed to mark ${row.id} error:`, markErr);
    }
    return "error";
  }
}

/** Batch driver used by the cron + backfill script. Bounded by caller. */
export async function extractEntitiesFromContent(
  rows: Array<{ id: string; title: string | null; caption: string | null }>,
  rawExtract: RawExtractFn = defaultRawExtract
): Promise<{ ok: number; empty: number; error: number }> {
  let known = (await prisma.entity.findMany({ select: { canonicalName: true } })).map((e) => e.canonicalName);
  let ok = 0,
    empty = 0,
    error = 0;
  for (const row of rows) {
    const res = await extractOne(row, known, rawExtract);
    if (res === "ok") {
      ok++;
      // refresh known names so later rows in the same batch can reuse newly-created entities
      const fresh = await prisma.entity.findMany({ select: { canonicalName: true } });
      known = fresh.map((e) => e.canonicalName);
    } else if (res === "empty") {
      empty++;
    } else {
      error++;
    }
  }
  return { ok, empty, error };
}
