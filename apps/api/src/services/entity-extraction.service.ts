import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

// Primary extractor: Claude Haiku (tuned prompt). Fallback: OpenAI gpt-4o-mini.
// WHY a fallback: the extraction LLM is a single point of failure — if the
// Anthropic account is rate-limited OR out of credit, EVERY extraction call throws.
// Before the fallback (2026-06-26 incident) that not only halted extraction, it
// (via the old extractOne catch) DEMOTED 13k+ valid captions to status='error',
// permanently hiding them from Link Search. The fallback keeps extraction running
// when one provider is down; the extractOne fix below ensures a provider outage can
// never again corrupt a caption's status.
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_MODEL = "gpt-4o-mini";

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // maxRetries:4 lets a brief 429/529 self-heal inside the SDK before we throw.
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
  return _client;
}

// Classify a final extraction failure as TRANSIENT (retry next run — the caption is
// fine, the provider was briefly unavailable) vs PERMANENT (this row/request will
// never succeed — a deterministic 400, an auth/credit-exhaustion error, or an
// unparseable reply). Handles BOTH providers' error shapes: Anthropic SDK error
// classes AND the OpenAI raw-fetch Error whose message carries "HTTP <code>".
// ⚠️ Out-of-credit (Anthropic 400 "credit balance too low" / OpenAI 401/429-quota) is
// treated as PERMANENT for the row — retrying it every cron would hot-loop forever on
// a billing problem. But because we have a FALLBACK provider, a single provider being
// out-of-credit doesn't reach here unless BOTH fail.
function isTransientError(err: unknown): boolean {
  // Anthropic SDK typed errors.
  if (
    err instanceof Anthropic.APIConnectionError || // includes connection timeout
    err instanceof Anthropic.RateLimitError || // 429
    err instanceof Anthropic.InternalServerError // 5xx incl. 529 overloaded
  ) {
    return true;
  }
  // OpenAI raw-fetch failures: our openaiExtract throws Error("openai: HTTP <code> …")
  // or an AbortError/TypeError on network failure. Treat 429/5xx + network as transient.
  const msg = err instanceof Error ? err.message : String(err);
  if (/^openai: HTTP (429|5\d\d)\b/.test(msg)) return true;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  if (/network|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)) return true;
  return false;
}

export interface ExtractedEntity {
  canonicalName: string;
  type: string; // PERSON | TOPIC | BRAND | OTHER
  confidence: number; // 0..1
  isNew: boolean;
}

/** Raw LLM call: (caption, title, knownNames) → raw JSON string. Injectable for tests. */
export type RawExtractFn = (caption: string, title: string, knownNames: string[]) => Promise<string>;

// The shared extraction instructions (provider-agnostic).
function buildSystemPrompt(): string {
  return [
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
}

function buildUserPrompt(caption: string, title: string, knownNames: string[]): string {
  return `KNOWN canonical names: ${JSON.stringify(knownNames)}\n\nTITLE: ${title || "(none)"}\nCAPTION: ${caption || "(none)"}`;
}

// Provider 1: Anthropic Haiku. Throws on any API error (rate-limit / out-of-credit /
// network) so the caller can fall through to OpenAI.
async function anthropicExtract(caption: string, title: string, knownNames: string[]): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("anthropic: ANTHROPIC_API_KEY not set");
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserPrompt(caption, title, knownNames) }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

// Provider 2: OpenAI gpt-4o-mini via raw fetch (no SDK dependency on the 2GB box).
// Throws on any non-200 / API error so the caller treats it as a failure (no demote).
async function openaiExtract(caption: string, title: string, knownNames: string[]): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("openai: OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 1024,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(caption, title, knownNames) },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

// Default extractor: try Anthropic (primary, tuned), fall back to OpenAI on ANY
// Anthropic failure. Throws only if BOTH providers fail — and even then the caller
// (extractOne) must NOT demote the caption's status (it'll just retry next cron).
const defaultRawExtract: RawExtractFn = async (caption, title, knownNames) => {
  // No provider configured at all → surface a clear, non-retryable config error.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new AppError(500, "AI_NOT_CONFIGURED", "No extraction provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  }
  // Primary: Anthropic. On failure (rate-limit / out-of-credit / network), fall back.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await anthropicExtract(caption, title, knownNames);
    } catch (anthropicErr) {
      if (!process.env.OPENAI_API_KEY) throw anthropicErr; // no fallback available
      // fall through to OpenAI
    }
  }
  return await openaiExtract(caption, title, knownNames);
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

// Terminal marker that does NOT demote status: stamp extractedAt=now() so the row
// EXITS the retry queue (same exit the "empty" path uses), while status stays 'ok' so
// the caption remains searchable-by-content + coverage-counted. Used for PERMANENT
// failures (deterministic parse error / non-transient API error) — never for transient
// ones (those stay pristine so they retry).
async function markDone(id: string): Promise<void> {
  try {
    await prisma.linkContent.update({ where: { id }, data: { extractedAt: new Date() } });
  } catch (markErr) {
    console.error(`[entity-extraction] also failed to stamp ${id} extractedAt:`, markErr);
  }
}

/**
 * Process one LinkContent row end-to-end. Never throws.
 *
 * ⚠️ CRITICAL (2026-06-26 fix): an extraction failure must NEVER demote the row's
 * link_content.status to 'error'. The CAPTION is captured — status='ok' is the TRUTH;
 * only the *tagging* failed. The old code set status='error' on any error, which (a)
 * hid a perfectly-good caption from Link Search and (b) evicted it from the retry
 * selector (status='ok' AND extractedAt IS NULL). When the Anthropic account ran out
 * of credit, that demoted 13k+ valid captions permanently.
 *
 * Failure handling now splits by cause:
 *  - TRANSIENT (rate-limit / 5xx / network, on BOTH providers) → return "retry", row
 *    left PRISTINE (status='ok', extractedAt=null) → retried next cron run.
 *  - PERMANENT (unparseable reply, or a deterministic 400 / auth / out-of-credit on
 *    both providers) → markDone(): stamp extractedAt to exit the queue (no hot-loop),
 *    KEEP status='ok' (caption stays searchable). return "error".
 */
export async function extractOne(
  row: { id: string; title: string | null; caption: string | null },
  knownNames: string[],
  rawExtract: RawExtractFn = defaultRawExtract
): Promise<"ok" | "error" | "empty" | "retry"> {
  let raw: string;
  try {
    raw = await rawExtract(row.caption ?? "", row.title ?? "", knownNames);
  } catch (err) {
    if (isTransientError(err)) {
      // Both providers briefly unavailable. Leave the row pristine → retried next run.
      console.warn(`[entity-extraction] transient LLM failure for ${row.id} (will retry next run):`, err instanceof Error ? err.message : err);
      return "retry";
    }
    // Permanent for this request (400 / auth / out-of-credit on both providers /
    // config). Exit the queue without demoting status — no re-pay hot-loop.
    console.error(`[entity-extraction] permanent LLM failure for ${row.id} (marking done, status stays ok):`, err instanceof Error ? err.message : err);
    await markDone(row.id);
    return "error";
  }
  try {
    const extracted = parseExtraction(raw);
    await resolveAndPersist(row.id, extracted); // stamps extractedAt on success
    return extracted.length ? "ok" : "empty";
  } catch (err) {
    // Unparseable reply / persist failure — permanent for this row. Same terminal mark.
    console.error(`[entity-extraction] permanent parse/persist failure for ${row.id} (marking done, status stays ok):`, err instanceof Error ? err.message : err);
    await markDone(row.id);
    return "error";
  }
}

/** Batch driver used by the cron + backfill script. Bounded by caller. */
export async function extractEntitiesFromContent(
  rows: Array<{ id: string; title: string | null; caption: string | null }>,
  rawExtract: RawExtractFn = defaultRawExtract
): Promise<{ ok: number; empty: number; error: number; retry: number }> {
  let known = (await prisma.entity.findMany({ select: { canonicalName: true } })).map((e) => e.canonicalName);
  let ok = 0,
    empty = 0,
    error = 0,
    retry = 0;
  for (const row of rows) {
    const res = await extractOne(row, known, rawExtract);
    if (res === "ok") {
      ok++;
      // refresh known names so later rows in the same batch can reuse newly-created entities
      const fresh = await prisma.entity.findMany({ select: { canonicalName: true } });
      known = fresh.map((e) => e.canonicalName);
    } else if (res === "empty") {
      empty++;
    } else if (res === "retry") {
      retry++;
    } else {
      error++;
    }
  }
  return { ok, empty, error, retry };
}
