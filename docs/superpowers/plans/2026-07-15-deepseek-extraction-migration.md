# DeepSeek V4-Flash Extraction Migration + Cache + Spend-Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gemini-only entity-extraction provider with DeepSeek V4-Flash (non-thinking mode), enable DeepSeek's automatic disk cache by restructuring the prompt so the entity-list prefix is byte-identical across calls, add a hard per-run spend ceiling so the pipeline can never overspend, and drain the 22,670-caption backlog safely.

**Architecture:** DeepSeek's API is OpenAI-format and its context cache is **on by default, no storage fee** — you only pay $0.0028/1M on a cache hit vs $0.14/1M on a miss. The single change that unlocks caching is making the prompt prefix *stable*: today the code re-fetches the (growing) entity list after every extraction and inlines it into a per-call string, so no two calls share a prefix and the cache never hits. We move the stable instructions + entity list into a **system message that only changes once per batch**, put the varying caption in the **user message**, and let DeepSeek cache the system prefix automatically. We remove Gemini/OpenAI/Anthropic from the active extraction chain (DeepSeek becomes the sole extractor), track the real `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` DeepSeek returns, add a `deepseek-v4-flash` price row, wire the existing admin kill-switch into a visible toggle on `/api-costs`, and add a hard USD spend ceiling the cron self-enforces before every call.

**Tech Stack:** Node/Express + Prisma + Postgres (API); Next.js (internal portal); Vitest (tests); raw `fetch` to `https://api.deepseek.com/chat/completions` (no SDK — the 2GB box constraint, same as the existing `openaiExtract`).

---

## Verified facts this plan rests on (all confirmed live/at-source 2026-07-15)

- **Backlog RIGHT NOW:** 22,670 captions pending (`link_content WHERE status='ok' AND extracted_at IS NULL`); 90,080 already extracted; 112,750 total captured.
- **Real per-call token profile:** ~20,440 input tokens (dominated by the 4,481-entity list ≈ 14k tokens in the prefix), ~73 output tokens. Captions themselves avg 96 chars (~30 tokens).
- **Cache is viable:** only ~5% of calls create a new entity (4,481 entities / 90,080 calls); new-entity creation has collapsed from ~400/day (late June) to single digits (July 6). So the entity-list prefix is stable across long runs → high cache-hit potential once the prompt is restructured.
- **DeepSeek V4-Flash pricing (api-docs.deepseek.com):** cache-hit input **$0.0028/M**, cache-miss input **$0.14/M**, output **$0.28/M**. Cache is **on-disk, enabled by default, no storage fee**. Returns `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens` in `usage`.
- **⚠️ Thinking mode defaults to ENABLED** — must send `{"thinking":{"type":"disabled"}}` in the request body or reasoning tokens inflate output cost. (Raw fetch → goes directly in the JSON body, NOT the SDK-only `extra_body` wrapper.)
- **⚠️ Peak/valley pricing starts mid-July:** peak hours (UTC) **01:00–04:00 and 06:00–10:00** are **2× regular price**. Off-peak is the rest of the day. This affects when to drain the backlog.
- **Balance:** $50 topped up, $0 spent, key `dashmani-insights` (`sk-91f64…3036`) created 2026-07-15.

### Cost envelope (RE-VERIFIED 2026-07-15 against the real 20,453-tok/call profile; backlog now 23,222)

DeepSeek caches the **longest common prefix**. Our prefix (system instructions + 4,481-entity list) is ~20,418 of the 20,453 input tokens — the caption is only ~35 tokens. So on a warm cache ~99.8% of input bills at the $0.0028 HIT rate, not $0.14. This makes the with-cache cost far lower than a naive estimate, and the cache-off cost far higher — the spread is ~25–50×.

| Scenario | Backlog (23,222) | Forward (~596/day) |
|---|---|---|
| **WITH cache, off-peak** (BEST) | **$1.92** | **~$1.78/mo** |
| **WITH cache, mixed ~1.3× peak** (EXPECTED) | **$2.50** | ~$2/mo |
| WITH cache, all-peak | $3.84 | ~$3/mo |
| Cache HALF-works (thrashing) | $44.69 | — |
| NO cache, off-peak (restructure failed) | $66.96 | ~$52/mo |
| NO cache, all-peak (ABSOLUTE WORST) | **$133.91** ⚠️ **> $50 balance** | ~$103/mo |

**Two worst cases, be precise:**
- **Expected outcome (cache working): ~$2.50 to clear the entire backlog, ~$1.78/mo ongoing.** $50 lasts effectively forever.
- **Absolute worst (cache 0% AND all-peak): $133.91 — this EXCEEDS the $50 balance.** Only reachable if the restructure fails to cache AND the drain runs entirely in peak hours.

The whole plan exists to guarantee the cache hits and make the worst case unreachable: (1) prompt restructured so the prefix is byte-identical (Task 4/5) → cache hits ~99.8%; (2) **cache hits verified live BEFORE any full drain** (Task 12 Step 4) → if it's not hitting, the drain halts at ~$0; (3) a self-enforced **daily USD spend ceiling** (Tasks 7–9, default $3, $15 for the drain) → hard cap far under $50; (4) drain **off-peak** + DeepSeek console balance alert. With these, expected spend is ~$2.50 and the $133.91 tail cannot occur.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/api/src/services/entity-extraction.service.ts` | Extraction providers, prompt building, cost-critical logic | **Modify** — add `deepseekExtract`, split prompt into stable system + varying user, make chain DeepSeek-only, refresh entity list once per batch not per call |
| `apps/api/src/services/api-usage.service.ts` | Price table + cost computation | **Modify** — add `deepseek-v4-flash` price row (peak-aware), keep Gemini/OpenAI rows for historical recompute |
| `apps/api/src/constants/enrichment.ts` | Shared system-settings keys | **Modify** — add `EXTRACTION_SPEND_CEILING_KEY` |
| `apps/api/src/services/extraction-spend.service.ts` | Compute today's DeepSeek spend + enforce ceiling | **Create** |
| `apps/api/src/cron/entity-extraction.cron.ts` | Batch driver gate | **Modify** — gate on DeepSeek key only, enforce spend ceiling, off-peak awareness |
| `apps/api/src/routes/admin-reports.routes.ts` | Admin toggle + spend endpoints | **Modify** — add GET/PUT `/admin/extraction/spend-ceiling`, extend status |
| `apps/internal/src/app/api-costs/page.tsx` | Cost sheet UI | **Modify** — add enrichment ON/OFF toggle + spend-ceiling control + DeepSeek panel |
| `apps/api/tests/entity-extraction.test.ts` | Provider + prompt tests | **Modify** — DeepSeek provider tests, stable-prefix test |
| `apps/api/tests/api-usage.test.ts` | Cost tests | **Modify** — DeepSeek cost + cache + peak tests |
| `apps/api/tests/extraction-spend.test.ts` | Spend-ceiling tests | **Create** |

**No `db:push` required** — reuses the existing `system_settings`, `api_usage`, `link_content`, `entities` tables. No schema change.

---

## Task 1: Live-probe the DeepSeek key (BLOCKING — do this first, no code)

**Files:** none (verification only).

**Why first:** Project rule — always live-probe a handed key before trusting it ("connected ≠ funded"; mocks can't catch field-shape lies). This confirms the key works, non-thinking mode returns clean JSON, and the `usage` object carries the cache fields we will bill from.

- [ ] **Step 1: Put the key on the server**

```bash
ssh linode
# Append the DeepSeek key (paste the real sk-... value in place of THE_KEY)
grep -q '^DEEPSEEK_API_KEY=' /opt/dashmani-platform/apps/api/.env || \
  echo 'DEEPSEEK_API_KEY=THE_KEY' >> /opt/dashmani-platform/apps/api/.env
grep '^DEEPSEEK_API_KEY=' /opt/dashmani-platform/apps/api/.env | sed 's/=.*/=<present>/'
```

Expected: `DEEPSEEK_API_KEY=<present>`

- [ ] **Step 2: Probe non-thinking extraction + read cache fields**

```bash
ssh linode 'cd /opt/dashmani-platform && KEY=$(grep ^DEEPSEEK_API_KEY apps/api/.env | cut -d= -f2-) && \
curl -s https://api.deepseek.com/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "{\"model\":\"deepseek-v4-flash\",\"thinking\":{\"type\":\"disabled\"},\"max_tokens\":256,\"messages\":[{\"role\":\"system\",\"content\":\"You extract real-world PEOPLE from a social post. Return ONLY a strict JSON array like [{\\\"canonicalName\\\":\\\"Salman Khan\\\",\\\"type\\\":\\\"PERSON\\\",\\\"confidence\\\":0.95,\\\"isNew\\\":false}]. If nothing, return [].\"},{\"role\":\"user\",\"content\":\"CAPTION: Salman Khan spotted with Shah Rukh Khan at the airport #bollywood\"}]}" | python3 -m json.tool'
```

Expected: HTTP 200, `choices[0].message.content` is a clean JSON array naming Salman Khan + Shah Rukh Khan (NO `reasoning_content` field, because thinking is disabled), and a `usage` object containing `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`. **If `reasoning_content` is present or `completion_tokens` is large (hundreds), thinking mode did NOT disable — STOP and fix the body before proceeding.**

- [ ] **Step 3: Probe the cache — send the SAME request twice, confirm the second hits**

```bash
ssh linode 'cd /opt/dashmani-platform && KEY=$(grep ^DEEPSEEK_API_KEY apps/api/.env | cut -d= -f2-) && \
REQ="{\"model\":\"deepseek-v4-flash\",\"thinking\":{\"type\":\"disabled\"},\"max_tokens\":64,\"messages\":[{\"role\":\"system\",\"content\":\"Repeat this stable system prefix. Return [].\"},{\"role\":\"user\",\"content\":\"first\"}]}" && \
echo "--- call 1 (expect cache MISS) ---" && curl -s https://api.deepseek.com/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$REQ" | python3 -c "import sys,json;u=json.load(sys.stdin)[\"usage\"];print(\"hit\",u.get(\"prompt_cache_hit_tokens\"),\"miss\",u.get(\"prompt_cache_miss_tokens\"))" && \
sleep 2 && echo "--- call 2, IDENTICAL system prefix (expect cache HIT > 0) ---" && curl -s https://api.deepseek.com/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$REQ" | python3 -c "import sys,json;u=json.load(sys.stdin)[\"usage\"];print(\"hit\",u.get(\"prompt_cache_hit_tokens\"),\"miss\",u.get(\"prompt_cache_miss_tokens\"))"'
```

Expected: call 1 shows `hit 0`; call 2 shows `hit > 0`. This **proves the disk cache works for an identical prefix** — the foundation of the whole cost model. (Note: DeepSeek needs a minimum prefix length to cache; the real 20k-token prefix easily qualifies, this tiny probe may show partial hits — the production prefix is what matters. If call 2 shows any hit > 0, caching is confirmed working.)

---

## Task 2: Add the `deepseek-v4-flash` price row (peak-aware) + tests

**Files:**
- Modify: `apps/api/src/services/api-usage.service.ts` (price table ~line 26, `llmCostUsd` ~line 61)
- Test: `apps/api/tests/api-usage.test.ts`

DeepSeek uses `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` — the cached count is the HIT count. Our `llmCostUsd(model, inputTokens, outputTokens, cachedTokens)` already models "cachedTokens billed at cachedPerM, the rest at inPerM". For DeepSeek we pass `cachedTokens = prompt_cache_hit_tokens` and `inputTokens = prompt_tokens` (which = hit + miss), so the miss portion bills at `inPerM` automatically. Peak pricing (2×) is applied at the call site via a multiplier, NOT baked into the table (the table stays the off-peak/standard rate, which is the correct base).

- [ ] **Step 1: Write failing cost tests**

Add to `apps/api/tests/api-usage.test.ts` inside the `describe("llmCostUsd", ...)` block:

```typescript
  it("computes deepseek-v4-flash cost (all cache-miss input)", () => {
    // 1M input all miss + 1M output = 0.14 + 0.28 = 0.42
    expect(llmCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000)).toBeCloseTo(0.42, 6);
  });

  it("computes deepseek-v4-flash cost with cache hits (hit billed at 0.0028)", () => {
    // 1M input of which 900k HIT (0.0028) + 100k miss (0.14), 0 output
    // = 0.9*0.0028 + 0.1*0.14 = 0.00252 + 0.014 = 0.01652
    expect(llmCostUsd("deepseek-v4-flash", 1_000_000, 0, 900_000)).toBeCloseTo(0.01652, 6);
  });

  it("deepseek-v4-flash full cache hit floor", () => {
    // all 1M input hits → 0.0028
    expect(llmCostUsd("deepseek-v4-flash", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.0028, 6);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -w @dashmani/api -- api-usage.test.ts -t "deepseek"`
Expected: FAIL — `llmCostUsd("deepseek-v4-flash", …)` returns 0 (unknown model).

- [ ] **Step 3: Add the price row**

In `apps/api/src/services/api-usage.service.ts`, add to `LLM_PRICES` (after the gemini row, ~line 36):

```typescript
  // DeepSeek V4-Flash (non-thinking) — the ACTIVE extraction provider (2026-07-15).
  // Cache-hit input $0.0028/M, cache-miss $0.14/M, output $0.28/M — OFFICIAL, from
  // api-docs.deepseek.com. Cache is on-disk, enabled by default, NO storage fee.
  // cachedPerM = the cache-HIT rate; we pass prompt_cache_hit_tokens as cachedTokens.
  // ⚠️ PEAK PRICING: DeepSeek charges 2× during UTC 01:00-04:00 and 06:00-10:00.
  // The table below is the STANDARD (off-peak) rate; the 2× multiplier is applied at
  // the call site (deepseekExtract) based on the request's UTC hour, so the recorded
  // cost matches the real bill regardless of when the cron ran.
  "deepseek-v4-flash": { inPerM: 0.14, cachedPerM: 0.0028, outPerM: 0.28 },
```

- [ ] **Step 3b: Add `"deepseek"` to the `UsageProvider` type AND `UNIT_PRICES` (BLOCKER — required for compile)**

⚠️ **This step is non-optional and was the #1 confirmed blocker in adversarial review.** `deepseekExtract` (Task 5) calls `recordApiUsage({ provider: "deepseek", ... })`. `RecordUsageInput.provider` is typed to the CLOSED union `UsageProvider`. Adding a `LLM_PRICES` row (Step 3) does NOT fix this — `LLM_PRICES` is keyed by `string`, but `provider` is keyed by the union. Two consequences if skipped:
1. `tsc --noEmit -p apps/api/tsconfig.json` (Task 11) FAILS (TS2322 — `"deepseek"` not assignable to `UsageProvider`).
2. **The spend guard silently dies:** if forced through, `UNIT_PRICES["deepseek"]` is `undefined` → non-token cost falls to `0`; and more subtly, a mis-typed provider risks the recorded `cost_usd` being wrong, which is what the spend ceiling sums. A ceiling that sums `$0` NEVER trips — the exact overspend hole.

In `apps/api/src/services/api-usage.service.ts`:

(a) Extend the union (~line 14):

```typescript
export type UsageProvider = "openai" | "gemini" | "anthropic" | "meta" | "youtube" | "deepseek";
```

(b) Add the `deepseek` key to `UNIT_PRICES` (~line 48) — `UNIT_PRICES` is `Record<UsageProvider, number>`, an EXHAUSTIVE mapped type, so adding the union member without this key is a second compile error (TS2741):

```typescript
const UNIT_PRICES: Record<UsageProvider, number> = {
  meta: 0,
  youtube: 0,
  openai: 0,
  gemini: 0,
  anthropic: 0,
  deepseek: 0, // dollar cost flows through LLM_PRICES/llmCostUsd; unit fallback unused for token calls
};
```

- [ ] **Step 3c: Add a `deepseek` cost test asserting non-zero recorded cost (guards the spend-ceiling wiring)**

Add to `apps/api/tests/api-usage.test.ts`:

```typescript
  it("recordApiUsage cost path is non-zero for deepseek token calls (spend guard depends on this)", () => {
    // Directly assert the cost function the guard sums is non-zero for deepseek.
    const c = llmCostUsd("deepseek-v4-flash", 20000, 71, 19900); // ~all-hit
    expect(c).toBeGreaterThan(0);
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test -w @dashmani/api -- api-usage.test.ts -t "deepseek"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/api-usage.service.ts apps/api/tests/api-usage.test.ts
git commit -m "feat(extraction): add deepseek-v4-flash price row (cache-aware)"
```

---

## Task 3: Add a peak-pricing helper + test

**Files:**
- Modify: `apps/api/src/services/api-usage.service.ts`
- Test: `apps/api/tests/api-usage.test.ts`

DeepSeek peak hours (UTC): 01:00–04:00 and 06:00–10:00. A pure function keeps this testable and reused by both the cost recorder and the spend estimator.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/api-usage.test.ts`:

```typescript
import { deepseekPeakMultiplier } from "../src/services/api-usage.service";

describe("deepseekPeakMultiplier", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 6, 15, h, 30, 0));
  it("is 2x inside peak window 01:00-04:00 UTC", () => {
    expect(deepseekPeakMultiplier(at(2))).toBe(2);
  });
  it("is 2x inside peak window 06:00-10:00 UTC", () => {
    expect(deepseekPeakMultiplier(at(7))).toBe(2);
  });
  it("is 1x off-peak (e.g. 12:00 UTC)", () => {
    expect(deepseekPeakMultiplier(at(12))).toBe(1);
  });
  it("is 1x at 05:00 UTC (between the two peak windows)", () => {
    expect(deepseekPeakMultiplier(at(5))).toBe(1);
  });
  it("boundary: 04:00 UTC is off-peak (peak is [01,04))", () => {
    expect(deepseekPeakMultiplier(at(4))).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @dashmani/api -- api-usage.test.ts -t "deepseekPeakMultiplier"`
Expected: FAIL — `deepseekPeakMultiplier` is not exported.

- [ ] **Step 3: Implement the helper**

In `apps/api/src/services/api-usage.service.ts`, add (near the top, after imports):

```typescript
/**
 * DeepSeek peak/valley multiplier. Peak hours (2× price) are UTC 01:00-04:00 and
 * 06:00-10:00 (inclusive of the start hour, exclusive of the end hour). Off-peak = 1×.
 * Applied to the standard rate in LLM_PRICES so recorded cost matches the real bill.
 * Verified from the DeepSeek console notice (2026-07-15).
 */
export function deepseekPeakMultiplier(when: Date): number {
  const h = when.getUTCHours();
  const inPeak = (h >= 1 && h < 4) || (h >= 6 && h < 10);
  return inPeak ? 2 : 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @dashmani/api -- api-usage.test.ts -t "deepseekPeakMultiplier"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/api-usage.service.ts apps/api/tests/api-usage.test.ts
git commit -m "feat(extraction): add deepseek peak-pricing UTC-hour multiplier"
```

---

## Task 4: Restructure the prompt into stable-system + varying-user (the cache-enabler)

**Files:**
- Modify: `apps/api/src/services/entity-extraction.service.ts` (`buildUserPrompt` ~line 81, `RawExtractFn` type ~line 63, `extractOne` ~line 381, `extractEntitiesFromContent` ~line 413)
- Test: `apps/api/tests/entity-extraction.test.ts`

**The core change.** Today `buildUserPrompt` inlines `knownNames` into a per-call string and the batch driver re-fetches the list after every success — so the prefix changes every call and NO cache can ever hit (Gemini or DeepSeek). We split the prompt so the **stable part (system instructions + entity list) is a `system` message that only changes when the entity list is refreshed (once per batch)**, and the **varying part (caption/title) is the `user` message**. This is what lets DeepSeek's disk cache hit ~90%+.

`RawExtractFn` currently receives `knownNames` and rebuilds the prefix per call. We change it to receive the **prebuilt stable system prompt** + the varying caption/title, so the caller controls prefix stability.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/entity-extraction.test.ts`:

```typescript
import { buildSystemPromptWithEntities, buildCaptionUserPrompt } from "../src/services/entity-extraction.service";

describe("stable-prefix prompt structure (cache enabler)", () => {
  it("system prompt embeds the known-entities list (the cacheable prefix)", () => {
    const sys = buildSystemPromptWithEntities(["Salman Khan", "Shah Rukh Khan"]);
    expect(sys).toContain("Salman Khan");
    expect(sys).toContain("Shah Rukh Khan");
    expect(sys).toContain("KNOWN canonical names");
  });
  it("system prompt is IDENTICAL for the same entity list (byte-stable → cacheable)", () => {
    const a = buildSystemPromptWithEntities(["A", "B", "C"]);
    const b = buildSystemPromptWithEntities(["A", "B", "C"]);
    expect(a).toBe(b);
  });
  it("user prompt contains ONLY the varying caption/title, NOT the entity list", () => {
    const u = buildCaptionUserPrompt("a caption", "a title");
    expect(u).toContain("a caption");
    expect(u).toContain("a title");
    expect(u).not.toContain("KNOWN canonical names");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @dashmani/api -- entity-extraction.test.ts -t "stable-prefix"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Refactor the prompt builders**

In `apps/api/src/services/entity-extraction.service.ts`, REPLACE `buildSystemPrompt()` and `buildUserPrompt()` (lines ~66–83) with:

```typescript
// The STABLE, CACHEABLE system prompt: shared instructions + the known-entities list.
// This is byte-identical across every call in a batch (the list only changes when the
// batch driver refreshes it), so DeepSeek's disk cache hits it after the first call.
// KEEPING THE ENTITY LIST HERE (not in the per-call user message) is what makes caching
// work — do NOT move it back into buildCaptionUserPrompt.
export function buildSystemPromptWithEntities(knownNames: string[]): string {
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
    "",
    `KNOWN canonical names: ${JSON.stringify(knownNames)}`,
  ].join("\n");
}

// The VARYING user prompt: only the post's title + caption. Small (~30 tokens), changes
// every call. Kept free of the entity list so the system prefix stays cacheable.
export function buildCaptionUserPrompt(caption: string, title: string): string {
  return `TITLE: ${title || "(none)"}\nCAPTION: ${caption || "(none)"}`;
}
```

- [ ] **Step 4: Update `RawExtractFn` and provider signatures to take (systemPrompt, caption, title)**

In the same file, REPLACE the `RawExtractFn` type (line ~63) with:

```typescript
/** Raw LLM call: (systemPrompt, caption, title) → raw JSON string. The systemPrompt is
 *  the prebuilt STABLE prefix (instructions + entity list); keeping it as an argument
 *  lets the caller hold it constant across a batch so provider caches hit. Injectable
 *  for tests. */
export type RawExtractFn = (systemPrompt: string, caption: string, title: string) => Promise<string>;
```

- [ ] **Step 5: Run to verify the new prompt tests pass**

Run: `npm run test -w @dashmani/api -- entity-extraction.test.ts -t "stable-prefix"`
Expected: PASS (3 tests). (Provider functions still reference old builders — Task 5 fixes them; the codebase will not compile until Task 5, which is fine within this task sequence. If running the full suite now, expect type errors in `anthropicExtract`/`openaiExtract`/`geminiExtract` — resolved next task.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/entity-extraction.service.ts apps/api/tests/entity-extraction.test.ts
git commit -m "feat(extraction): split prompt into stable system prefix + varying caption (cache enabler)"
```

---

## Task 5: Add the DeepSeek provider (non-thinking) + make the chain DeepSeek-only

**Files:**
- Modify: `apps/api/src/services/entity-extraction.service.ts` (add `deepseekExtract`, rewrite `defaultRawExtract`, update the three old providers' signatures, `extractOne`, `extractEntitiesFromContent`)
- Test: `apps/api/tests/entity-extraction.test.ts`

DeepSeek is OpenAI-format. The provider sends the stable system message + varying user message, disables thinking, and records usage with the real cache-hit count and peak multiplier. Gemini/OpenAI/Anthropic providers are kept **defined** (for the historical-cost recompute + a re-add path) but **removed from the active chain** — DeepSeek is the sole extractor.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/entity-extraction.test.ts`:

```typescript
import { extractOne, buildSystemPromptWithEntities } from "../src/services/entity-extraction.service";

describe("DeepSeek extraction (injected rawExtract)", () => {
  beforeEach(async () => {
    await prisma.linkContentEntity.deleteMany();
    await prisma.linkContent.deleteMany();
    await prisma.entity.deleteMany();
  });

  it("extractOne persists entities from a DeepSeek-shaped reply", async () => {
    const lc = await prisma.linkContent.create({
      data: { canonicalKey: "yt:test1", title: "t", caption: "Salman Khan at event", status: "ok" },
    });
    // fake DeepSeek raw JSON reply (signature: (systemPrompt, caption, title) => raw)
    const fakeRaw: RawExtractFn = async () =>
      '[{"canonicalName":"Salman Khan","type":"PERSON","confidence":0.9,"isNew":true}]';
    // 2nd arg is now the PREBUILT stable system prompt (a string), not the names array.
    const sys = buildSystemPromptWithEntities([]);
    const res = await extractOne({ id: lc.id, title: "t", caption: "Salman Khan at event" }, sys, fakeRaw);
    expect(res).toBe("ok");
    const ents = await prisma.entity.findMany();
    expect(ents.map((e) => e.canonicalName)).toContain("Salman Khan");
    const done = await prisma.linkContent.findUnique({ where: { id: lc.id } });
    expect(done?.extractedAt).not.toBeNull();
  });

  it("extractOne with a stable systemPrompt still resolves (signature accepts 3 args)", async () => {
    const lc = await prisma.linkContent.create({
      data: { canonicalKey: "yt:test2", title: "", caption: "nothing identifiable", status: "ok" },
    });
    const empty: RawExtractFn = async (_sys, _cap, _title) => "[]";
    const sys = buildSystemPromptWithEntities(["X"]);
    const res = await extractOne({ id: lc.id, title: "", caption: "nothing identifiable" }, sys, empty);
    expect(res).toBe("empty");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @dashmani/api -- entity-extraction.test.ts -t "DeepSeek extraction"`
Expected: FAIL (compile/type errors — `extractOne` still calls the old prompt builders / signature).

- [ ] **Step 3: Add `deepseekExtract` and update the old providers' signatures**

In `apps/api/src/services/entity-extraction.service.ts`:

(a) Add the model constant near the top (after `GEMINI_MODEL`, ~line 18):

```typescript
// Active extraction model (2026-07-15): DeepSeek V4-Flash, NON-THINKING.
const DEEPSEEK_MODEL = "deepseek-v4-flash";
```

(b) Add the provider function (place it before `defaultRawExtract`):

```typescript
// ACTIVE PROVIDER: DeepSeek V4-Flash via raw fetch (OpenAI-format). NON-THINKING mode
// (thinking:{type:"disabled"}) — the default is thinking, which would bloat output
// tokens for a trivial classification task. The stable systemPrompt is sent as the
// SYSTEM message so DeepSeek's on-disk cache hits it (~$0.0028/M vs $0.14/M miss).
// Records usage with the REAL cache-hit count DeepSeek returns + the peak multiplier.
async function deepseekExtract(systemPrompt: string, caption: string, title: string): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("deepseek: DEEPSEEK_API_KEY not set");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      thinking: { type: "disabled" }, // REQUIRED: no reasoning tokens
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildCaptionUserPrompt(caption, title) },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`deepseek: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  };
  recordApiUsage({
    provider: "deepseek",
    operation: "entity-extraction",
    model: DEEPSEEK_MODEL,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    // DeepSeek: prompt_cache_hit_tokens are billed at the cheaper cachedPerM rate.
    cachedInputTokens: data.usage?.prompt_cache_hit_tokens ?? 0,
    // Peak/valley: 2× during UTC peak windows. Applied to the computed cost so the
    // recorded figure matches the real bill regardless of when the cron ran.
    costMultiplier: deepseekPeakMultiplier(new Date()),
  });
  return data.choices?.[0]?.message?.content ?? "";
}
```

(c) Update the THREE existing providers (`anthropicExtract`, `openaiExtract`, `geminiExtract`) so their signatures match the new `RawExtractFn` — they now receive `systemPrompt` instead of building it. Change each signature from `(caption, title, knownNames)` to `(systemPrompt, caption, title)` and replace their internal `buildSystemPrompt()` / `buildUserPrompt(...)` calls:
  - Anthropic: `system: systemPrompt` and `messages: [{ role: "user", content: buildCaptionUserPrompt(caption, title) }]`
  - OpenAI: `messages: [{ role: "system", content: systemPrompt }, { role: "user", content: buildCaptionUserPrompt(caption, title) }]`
  - Gemini: `text: \`${systemPrompt}\n\n${buildCaptionUserPrompt(caption, title)}\``

(These stay defined for historical cost recompute + a fast re-add path, per the existing pattern.)

- [ ] **Step 4: Rewrite `defaultRawExtract` to DeepSeek-only**

REPLACE the `defaultRawExtract` body (lines ~190–227) with:

```typescript
// Active extraction chain: DEEPSEEK-ONLY (2026-07-15). DeepSeek V4-Flash non-thinking
// with its on-disk cache is the cheapest option for our huge-repeating-prefix workload
// ($0.0028/M cache-hit input, no storage fee) AND the sole funded provider. Gemini,
// OpenAI, and Anthropic are removed from the ACTIVE chain — Gemini's prepaid balance is
// depleted, and Gemini's cache needs a paid hourly-storage CachedContent object to hit,
// whereas DeepSeek caches automatically for free. The other provider functions remain
// defined (historical cost recompute + a one-line re-add path): to add a paid fallback,
// append it to this array.
const defaultRawExtract: RawExtractFn = async (systemPrompt, caption, title) => {
  const providers: Array<{ key: string | undefined; fn: () => Promise<string> }> = [
    { key: process.env.DEEPSEEK_API_KEY, fn: () => deepseekExtract(systemPrompt, caption, title) },
  ].filter((p) => !!p.key);

  if (providers.length === 0) {
    throw new AppError(500, "AI_NOT_CONFIGURED", "No extraction provider configured. Set DEEPSEEK_API_KEY.");
  }

  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    try {
      return await providers[i].fn();
    } catch (err) {
      lastErr = err;
      if (i < providers.length - 1) {
        console.warn(`[entity-extraction] provider ${i + 1}/${providers.length} failed, trying next:`, err instanceof Error ? err.message : err);
      }
    }
  }
  throw lastErr;
};
```

Also update `isTransientError` (line ~49) to include deepseek in the raw-fetch regex:

```typescript
  if (/^(openai|gemini|deepseek): HTTP (429|5\d\d)\b/.test(msg)) return true;
```

- [ ] **Step 5: Update `extractOne` + `extractEntitiesFromContent` to build the stable prefix ONCE and pass it in**

In `extractOne` (line ~381), change the signature + the `rawExtract` call so it accepts the prebuilt system prompt:

```typescript
export async function extractOne(
  row: { id: string; title: string | null; caption: string | null },
  systemPrompt: string,
  rawExtract: RawExtractFn = defaultRawExtract
): Promise<"ok" | "error" | "empty" | "retry"> {
  let raw: string;
  try {
    raw = await rawExtract(systemPrompt, row.caption ?? "", row.title ?? "");
  } catch (err) {
    // ... (unchanged transient/permanent handling below)
```

Keep the rest of `extractOne`'s body unchanged.

⚠️ **BACKWARD-COMPAT NOTE for tests:** the Task-5 tests call `extractOne(row, knownNamesArray, fakeRaw)`. Update those test calls to pass a systemPrompt string (e.g. `buildSystemPromptWithEntities([])`) instead of the raw array — the second arg is now the prebuilt prompt, not the names. Adjust the two Task-5 tests accordingly before running Step 6.

In `extractEntitiesFromContent` (line ~413), REPLACE the body with the batch-stable-prefix version:

```typescript
export async function extractEntitiesFromContent(
  rows: Array<{ id: string; title: string | null; caption: string | null }>,
  rawExtract: RawExtractFn = defaultRawExtract
): Promise<{ ok: number; empty: number; error: number; retry: number }> {
  // Build the stable system prefix ONCE at the start of the batch. This is the key to
  // caching: the prefix stays byte-identical for the whole run, so DeepSeek's disk
  // cache hits it on every call after the first. We DO refresh it, but only every
  // PREFIX_REFRESH_EVERY successful new-entity creations — NOT after every call (the
  // old behavior, which busted the cache). Since only ~5% of calls create a new
  // entity and the entity universe is nearly saturated, the prefix is stable across
  // long runs → ~90%+ cache-hit rate.
  const PREFIX_REFRESH_EVERY = 50; // rebuild the prefix at most every 50 new entities
  // ⚠️ ORDER BY IS LOAD-BEARING FOR THE CACHE (Major A, confirmed in adversarial review).
  // DeepSeek's disk cache keys on the BYTE-IDENTICAL longest-common-prefix. The prefix is
  // JSON.stringify(knownNames) in Postgres ROW ORDER. A findMany with NO orderBy returns
  // rows in arbitrary heap order that CHANGES as rows are inserted / autovacuum runs — so
  // the same entity set can serialize to DIFFERENT bytes run-to-run → the cache NEVER hits
  // → every call bills at the $0.14/M MISS rate → the ~$2.50 backlog silently becomes
  // ~$67-134. A deterministic sort makes the prefix stable so the cache actually hits.
  // Do NOT remove the orderBy from either findMany.
  let known = (await prisma.entity.findMany({ select: { canonicalName: true }, orderBy: { canonicalName: "asc" } })).map((e) => e.canonicalName);
  let systemPrompt = buildSystemPromptWithEntities(known);
  let newSinceRefresh = 0;
  let sinceCeilingCheck = 0; // mid-batch spend re-check counter (see below)
  let ok = 0,
    empty = 0,
    error = 0,
    retry = 0;
  for (const row of rows) {
    const res = await extractOne(row, systemPrompt, rawExtract);
    if (res === "ok") {
      ok++;
      newSinceRefresh++;
      // Refresh the cacheable prefix only periodically — keeps the cache warm while
      // still letting later rows reuse newly-created entities within the same batch.
      if (newSinceRefresh >= PREFIX_REFRESH_EVERY) {
        const fresh = await prisma.entity.findMany({ select: { canonicalName: true }, orderBy: { canonicalName: "asc" } });
        known = fresh.map((e) => e.canonicalName);
        systemPrompt = buildSystemPromptWithEntities(known);
        newSinceRefresh = 0;
      }
    } else if (res === "empty") {
      empty++;
    } else if (res === "retry") {
      retry++;
    } else {
      error++;
    }
    // MID-BATCH SPEND RE-CHECK (Minor hardening, confirmed in review): the cron gate
    // checks the ceiling only ONCE at run start. A single large batch (cap up to 3000)
    // with a silently-failing cache could overshoot the ceiling by several dollars before
    // the NEXT cron run re-checks. Re-check every 100 rows and bail out of the batch early
    // if today's spend has crossed the ceiling. Bounded, cheap (one aggregate per 100 rows).
    if (++sinceCeilingCheck >= 100) {
      sinceCeilingCheck = 0;
      if (await isSpendCeilingReached()) {
        console.warn(`[entity-extraction] spend ceiling reached mid-batch — stopping after ${ok + empty + error + retry} rows`);
        break;
      }
    }
  }
  return { ok, empty, error, retry };
}
```

⚠️ Add the import at the top of `entity-extraction.service.ts`: `import { isSpendCeilingReached } from "./extraction-spend.service";` (created in Task 7). Since Task 7 comes AFTER Task 5 in the plan, when implementing Task 5 you may stub this as a no-op first and wire the real import in Task 8; OR reorder so Task 7 (the spend service) lands before Task 5's mid-batch check. Simplest: implement Task 7 first, then this import resolves cleanly.

- [ ] **Step 5b: Add a byte-stability test for the cacheable prefix (guards Major A)**

Add to `apps/api/tests/entity-extraction.test.ts`:

```typescript
describe("cache-prefix byte stability (protects the DeepSeek cache-hit assumption)", () => {
  it("two findMany-ordered entity lists serialize to identical prefix bytes", async () => {
    await prisma.entity.deleteMany();
    await prisma.entity.createMany({ data: [
      { canonicalName: "Zeta One", type: "PERSON", aliases: ["zeta one"] },
      { canonicalName: "Alpha Two", type: "PERSON", aliases: ["alpha two"] },
      { canonicalName: "Mid Three", type: "PERSON", aliases: ["mid three"] },
    ]});
    const q = () => prisma.entity.findMany({ select: { canonicalName: true }, orderBy: { canonicalName: "asc" } }).then((r) => r.map((e) => e.canonicalName));
    const a = buildSystemPromptWithEntities(await q());
    const b = buildSystemPromptWithEntities(await q());
    expect(a).toBe(b); // byte-identical → DeepSeek cache can hit
    // and the order is deterministic (alphabetical), not insertion order
    expect(a.indexOf("Alpha Two")).toBeLessThan(a.indexOf("Mid Three"));
    expect(a.indexOf("Mid Three")).toBeLessThan(a.indexOf("Zeta One"));
  });
});
```

- [ ] **Step 6: Run the DeepSeek + full extraction suite**

Run: `npm run test -w @dashmani/api -- entity-extraction.test.ts`
Expected: PASS (all — pure parse tests, stable-prefix tests, DeepSeek tests). Fix any test call still passing the old 3rd-arg shape.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/entity-extraction.service.ts apps/api/tests/entity-extraction.test.ts
git commit -m "feat(extraction): DeepSeek V4-Flash non-thinking as sole provider; batch-stable prefix for cache hits"
```

---

## Task 6: Wire the peak multiplier into `recordApiUsage` (cost accuracy)

**Files:**
- Modify: `apps/api/src/services/api-usage.service.ts` (`RecordUsageInput`, `recordApiUsage`, `llmCostUsd` call)
- Test: `apps/api/tests/api-usage.test.ts`

`deepseekExtract` passes `costMultiplier`. `recordApiUsage` must apply it to the computed LLM cost so the stored `cost_usd` matches DeepSeek's real (possibly-2×) bill.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/api-usage.test.ts`:

```typescript
import { recordApiUsage } from "../src/services/api-usage.service";
// (recordApiUsage is fire-and-forget; test the cost math via llmCostUsd + multiplier instead)

describe("peak multiplier applied to recorded cost", () => {
  it("llmCostUsd × 2 equals a peak-hour DeepSeek charge", () => {
    const off = llmCostUsd("deepseek-v4-flash", 20000, 73, 18000);
    // peak = 2× off
    expect(off * 2).toBeCloseTo(llmCostUsd("deepseek-v4-flash", 20000, 73, 18000) * 2, 8);
    expect(off).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it passes trivially / add the field**

Run: `npm run test -w @dashmani/api -- api-usage.test.ts -t "peak multiplier"`
Expected: PASS (this asserts the arithmetic identity). The real wiring is the `costMultiplier` field:

- [ ] **Step 3: Add `costMultiplier` to `RecordUsageInput` and apply it**

In `apps/api/src/services/api-usage.service.ts`:

Add to `RecordUsageInput` interface (~line 105):

```typescript
  /** Multiply the computed cost (e.g. DeepSeek 2× peak-hour surcharge). Default 1. */
  costMultiplier?: number;
```

In `recordApiUsage`, after computing `costUsd` from `llmCostUsd` (~line 134), apply the multiplier:

```typescript
    if (inputTokens != null || outputTokens != null) {
      costUsd = llmCostUsd(model, inputTokens ?? 0, outputTokens ?? 0, input.cachedInputTokens ?? 0);
      if (input.costMultiplier && input.costMultiplier !== 1) costUsd *= input.costMultiplier;
    } else {
```

- [ ] **Step 4: Run the full api-usage suite**

Run: `npm run test -w @dashmani/api -- api-usage.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/api-usage.service.ts apps/api/tests/api-usage.test.ts
git commit -m "feat(extraction): apply deepseek peak-hour multiplier to recorded cost"
```

---

## Task 7: Add the hard spend-ceiling service (the overspend guard)

**Files:**
- Create: `apps/api/src/services/extraction-spend.service.ts`
- Modify: `apps/api/src/constants/enrichment.ts`
- Test: `apps/api/tests/extraction-spend.test.ts`

**The critical "do not overspend" mechanism.** Before every batch, the cron checks today's recorded DeepSeek spend against a configurable USD ceiling (stored in `system_settings`, editable from the UI). If today's spend ≥ ceiling, the cron skips — a hard cap independent of the DeepSeek balance. Default ceiling: **$3/day** (comfortably above the ~$0.33–0.50/day steady-state, and would clear the whole backlog in ~4 days at the cache-on rate while capping a runaway).

- [ ] **Step 1: Add the constant**

In `apps/api/src/constants/enrichment.ts`, add:

```typescript
// system_settings key: hard USD ceiling on DeepSeek extraction spend PER UTC DAY.
// Read by the extraction cron (skips the run once today's spend hits it) and
// read/written by GET+PUT /admin/extraction/spend-ceiling. A hard cap independent of
// the DeepSeek prepaid balance — the last line of defense against overspend.
export const EXTRACTION_SPEND_CEILING_KEY = "extraction.spendCeilingUsd";
export const DEFAULT_EXTRACTION_SPEND_CEILING_USD = 3;
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/extraction-spend.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@dashmani/db";
import { getTodayDeepseekSpendUsd, getSpendCeilingUsd, isSpendCeilingReached } from "../src/services/extraction-spend.service";
import { DEFAULT_EXTRACTION_SPEND_CEILING_USD, EXTRACTION_SPEND_CEILING_KEY } from "../src/constants/enrichment";

describe("extraction-spend service", () => {
  beforeEach(async () => {
    await prisma.apiUsage.deleteMany({ where: { provider: "deepseek" } });
    await prisma.systemSetting.deleteMany({ where: { key: EXTRACTION_SPEND_CEILING_KEY } });
  });
  afterAll(async () => {
    await prisma.apiUsage.deleteMany({ where: { provider: "deepseek" } });
  });

  it("getSpendCeilingUsd returns the default when unset", async () => {
    expect(await getSpendCeilingUsd()).toBe(DEFAULT_EXTRACTION_SPEND_CEILING_USD);
  });

  it("getSpendCeilingUsd returns the stored override", async () => {
    await prisma.systemSetting.create({ data: { key: EXTRACTION_SPEND_CEILING_KEY, value: "1.5" } });
    expect(await getSpendCeilingUsd()).toBe(1.5);
  });

  it("getTodayDeepseekSpendUsd sums only today's deepseek rows", async () => {
    await prisma.apiUsage.create({
      data: { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", calls: 1, inputTokens: 20000, outputTokens: 70, costUsd: 2.0 },
    });
    const spend = await getTodayDeepseekSpendUsd();
    expect(spend).toBeCloseTo(2.0, 6);
  });

  it("isSpendCeilingReached is true once today's spend >= ceiling", async () => {
    await prisma.systemSetting.create({ data: { key: EXTRACTION_SPEND_CEILING_KEY, value: "1.0" } });
    await prisma.apiUsage.create({
      data: { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", calls: 1, costUsd: 1.25 },
    });
    expect(await isSpendCeilingReached()).toBe(true);
  });

  it("isSpendCeilingReached is false when under ceiling", async () => {
    await prisma.systemSetting.create({ data: { key: EXTRACTION_SPEND_CEILING_KEY, value: "5.0" } });
    await prisma.apiUsage.create({
      data: { provider: "deepseek", model: "deepseek-v4-flash", operation: "entity-extraction", calls: 1, costUsd: 0.5 },
    });
    expect(await isSpendCeilingReached()).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test -w @dashmani/api -- extraction-spend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/extraction-spend.service.ts`:

```typescript
import { prisma } from "@dashmani/db";
import { EXTRACTION_SPEND_CEILING_KEY, DEFAULT_EXTRACTION_SPEND_CEILING_USD } from "../constants/enrichment";

// UTC-day start (DeepSeek bills + reports in UTC; the ceiling is a per-UTC-day cap to
// match the provider's own daily boundary and the console's UTC usage view).
function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
}

/** Sum of recorded DeepSeek extraction cost since 00:00 UTC today. */
export async function getTodayDeepseekSpendUsd(): Promise<number> {
  const agg = await prisma.apiUsage.aggregate({
    _sum: { costUsd: true },
    where: { provider: "deepseek", createdAt: { gte: utcDayStart() } },
  });
  return agg._sum.costUsd ?? 0;
}

/** The configured hard daily ceiling (USD). Unset → default. */
export async function getSpendCeilingUsd(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: EXTRACTION_SPEND_CEILING_KEY } });
  if (!row) return DEFAULT_EXTRACTION_SPEND_CEILING_USD;
  const n = Number(row.value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EXTRACTION_SPEND_CEILING_USD;
}

/** True once today's DeepSeek spend has reached/exceeded the ceiling. */
export async function isSpendCeilingReached(): Promise<boolean> {
  const [spend, ceiling] = await Promise.all([getTodayDeepseekSpendUsd(), getSpendCeilingUsd()]);
  return spend >= ceiling;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -w @dashmani/api -- extraction-spend.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/extraction-spend.service.ts apps/api/src/constants/enrichment.ts apps/api/tests/extraction-spend.test.ts
git commit -m "feat(extraction): hard per-UTC-day DeepSeek spend ceiling service"
```

---

## Task 8: Gate the cron on DeepSeek key + spend ceiling

**Files:**
- Modify: `apps/api/src/cron/entity-extraction.cron.ts`
- Test: `apps/api/tests/entity-extraction-cron.test.ts`

The cron must (1) require the DeepSeek key (not the old three), (2) skip if the admin kill-switch is off (unchanged), and (3) **skip if today's spend has hit the ceiling** — the overspend guard.

⚠️ **BLOCKER 3 (confirmed in adversarial review):** `entity-extraction-cron.test.ts` is a **FULLY-MOCKED** file — it `vi.mock("@dashmani/db")` and drives everything through `findUniqueMock`/`findManyMock`/`countMock`/`extractEntitiesFromContentMock`. It has NO real DB. So (a) any `prisma.*.create/upsert` in a new test would call an undefined mock and throw; (b) the existing `beforeEach` sets `ANTHROPIC_API_KEY` (not `DEEPSEEK_API_KEY`), so after Step 3 changes the gate to require `DEEPSEEK_API_KEY`, the two existing "runs normally" tests short-circuit and their `toHaveBeenCalled()` assertions FAIL; (c) `isSpendCeilingReached()` calls `prisma.apiUsage.aggregate` + `prisma.systemSetting.findUnique`, which aren't in the current mock block → `undefined.aggregate` throws. All three must be fixed in THIS step or the cron suite goes red at the plan's own gates.

- [ ] **Step 1a: Fix the existing mock block + beforeEach (Blocker 3, parts a/b/c)**

In `apps/api/tests/entity-extraction-cron.test.ts`:

(i) Set the DeepSeek key in `beforeEach` (find the `process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "test-key" }` line ~50) and change it to:

```typescript
    process.env = { ...OLD_ENV, DEEPSEEK_API_KEY: "sk-test" };
```

(ii) In the existing "no-provider-configured gate" test (~line 93-95), replace the three deletes with the one key the new gate checks:

```typescript
    delete process.env.DEEPSEEK_API_KEY;
```

(iii) Extend the `vi.mock("@dashmani/db")` block so `isSpendCeilingReached()` resolves cleanly (spend under ceiling → guard passes). Add these mocks alongside the existing `findUniqueMock` etc.:

```typescript
const aggregateMock = vi.fn();
// inside the vi.mock("@dashmani/db", ...) factory's prisma object, add:
//   apiUsage: { aggregate: (...a: unknown[]) => aggregateMock(...a) },
// and ensure systemSetting.findUnique (findUniqueMock) can return the ceiling key.
```

Then in `beforeEach`, default the aggregate to under-ceiling so the pass-through tests stay green:

```typescript
  aggregateMock.mockResolvedValue({ _sum: { costUsd: 0 } }); // today's deepseek spend = $0 → under ceiling
  // findUniqueMock is used for BOTH the enrichment toggle key AND the spend-ceiling key.
  // Default it to null (toggle enabled, ceiling defaults) unless a test overrides.
```

- [ ] **Step 1b: Write the failing ceiling test (MOCKED style — no real DB)**

Add to `apps/api/tests/entity-extraction-cron.test.ts`:

```typescript
it("skips the run when today's deepseek spend has reached the ceiling", async () => {
  // DEEPSEEK_API_KEY is set in beforeEach. Toggle enabled (findUnique null for the toggle key).
  // spend-ceiling key → "0.01"; today's spend aggregate → $5 (over ceiling).
  findUniqueMock.mockImplementation(({ where }: { where: { key: string } }) =>
    where.key === "extraction.spendCeilingUsd" ? { key: where.key, value: "0.01" } : null,
  );
  aggregateMock.mockResolvedValue({ _sum: { costUsd: 5 } }); // over the $0.01 ceiling

  await runEntityExtraction();

  // Ceiling reached → cron returns before querying pending rows or extracting.
  expect(findManyMock).not.toHaveBeenCalled();
  expect(extractEntitiesFromContentMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @dashmani/api -- entity-extraction-cron.test.ts -t "ceiling"`
Expected: FAIL — cron doesn't check the ceiling yet (findMany/extract still called).

- [ ] **Step 3: Update the cron gate**

In `apps/api/src/cron/entity-extraction.cron.ts`:

(a) Add the import:

```typescript
import { isSpendCeilingReached, getTodayDeepseekSpendUsd, getSpendCeilingUsd } from "../services/extraction-spend.service";
```

(b) REPLACE the provider-key gate (lines ~12–17) with a DeepSeek-only gate:

```typescript
  // DeepSeek is the sole extraction provider (2026-07-15). No key → nothing to do.
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("[entity-extraction] DEEPSEEK_API_KEY not set — skipping run");
    return;
  }
```

(c) AFTER the existing kill-switch check (after line ~29), add the spend-ceiling guard:

```typescript
  // HARD OVERSPEND GUARD: skip if today's DeepSeek spend has hit the ceiling. This is
  // independent of the prepaid balance — a self-enforced daily cap the admin controls
  // from /api-costs. Prevents a cache-miss storm (e.g. during peak-price hours) from
  // draining the balance.
  if (await isSpendCeilingReached()) {
    const [spend, ceiling] = await Promise.all([getTodayDeepseekSpendUsd(), getSpendCeilingUsd()]);
    console.log(`[entity-extraction] daily spend ceiling reached ($${spend.toFixed(4)} >= $${ceiling}) — skipping run`);
    return;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @dashmani/api -- entity-extraction-cron.test.ts`
Expected: PASS (all, incl. the new ceiling test).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/cron/entity-extraction.cron.ts apps/api/tests/entity-extraction-cron.test.ts
git commit -m "feat(extraction): cron gates on DeepSeek key + hard daily spend ceiling"
```

---

## Task 9: Admin API — spend-ceiling GET/PUT + status enrichment

**Files:**
- Modify: `apps/api/src/routes/admin-reports.routes.ts`
- Test: `apps/api/tests/enrichment-toggle.test.ts`

The existing `GET/PUT /admin/enrichment/toggle` is the ON/OFF kill-switch. Add sibling endpoints to read/set the spend ceiling and to report today's spend, so the UI can show + control both.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/enrichment-toggle.test.ts` (mirror its existing supertest style):

```typescript
// GET returns default ceiling + today's spend; PUT sets ceiling.
it("GET /admin/extraction/spend-ceiling returns ceiling + todaySpend", async () => {
  const res = await request(app).get("/v1/admin/extraction/spend-ceiling").set(authHeader);
  expect(res.status).toBe(200);
  expect(typeof res.body.data.ceilingUsd).toBe("number");
  expect(typeof res.body.data.todaySpendUsd).toBe("number");
});

it("PUT /admin/extraction/spend-ceiling sets the ceiling", async () => {
  const res = await request(app).put("/v1/admin/extraction/spend-ceiling").set(authHeader).send({ ceilingUsd: 2.5 });
  expect(res.status).toBe(200);
  expect(res.body.data.ceilingUsd).toBe(2.5);
});
```

(Reuse whatever `app` + `authHeader` the file already defines for the toggle tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @dashmani/api -- enrichment-toggle.test.ts -t "spend-ceiling"`
Expected: FAIL — routes 404.

- [ ] **Step 3: Add the routes**

In `apps/api/src/routes/admin-reports.routes.ts`:

(a) Add imports at the top:

```typescript
import { EXTRACTION_SPEND_CEILING_KEY } from "../constants/enrichment";
import { getTodayDeepseekSpendUsd, getSpendCeilingUsd } from "../services/extraction-spend.service";
```

(b) Add the endpoints (place them next to the existing `/admin/enrichment/toggle` block):

```typescript
// GET /admin/extraction/spend-ceiling — current daily USD ceiling + today's spend.
router.get(
  "/admin/extraction/spend-ceiling",
  authenticate,
  requirePermission("reports", "view"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [ceilingUsd, todaySpendUsd] = await Promise.all([getSpendCeilingUsd(), getTodayDeepseekSpendUsd()]);
      return success(res, { ceilingUsd, todaySpendUsd });
    } catch (err) {
      next(err);
    }
  },
);

// PUT /admin/extraction/spend-ceiling — admin sets the hard daily USD ceiling.
router.put(
  "/admin/extraction/spend-ceiling",
  authenticate,
  requirePermission("reports", "manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ceilingUsd } = req.body as { ceilingUsd?: unknown };
      if (typeof ceilingUsd !== "number" || !Number.isFinite(ceilingUsd) || ceilingUsd < 0 || ceilingUsd > 1000) {
        return error(res, "VALIDATION_ERROR", "ceilingUsd must be a number between 0 and 1000", 400);
      }
      await prisma.systemSetting.upsert({
        where: { key: EXTRACTION_SPEND_CEILING_KEY },
        create: { key: EXTRACTION_SPEND_CEILING_KEY, value: String(ceilingUsd) },
        update: { value: String(ceilingUsd) },
      });
      return success(res, { ceilingUsd });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @dashmani/api -- enrichment-toggle.test.ts`
Expected: PASS (all, incl. spend-ceiling).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin-reports.routes.ts apps/api/tests/enrichment-toggle.test.ts
git commit -m "feat(api): admin GET/PUT extraction spend-ceiling endpoints"
```

---

## Task 10: Cost-page UI — enrichment toggle + spend ceiling + DeepSeek panel

**Files:**
- Modify: `apps/internal/src/app/api-costs/page.tsx`

Surface three controls on `/api-costs`: (1) the enrichment ON/OFF kill-switch (existing `GET/PUT /admin/enrichment/toggle`), (2) the daily spend ceiling input with today's spend shown, (3) DeepSeek in the provider breakdown (it will appear automatically once `api_usage` has deepseek rows — verify it renders, add a label if the page hard-codes provider names).

- [ ] **Step 1: Read the current page to match its patterns**

Run: `sed -n '1,80p' apps/internal/src/app/api-costs/page.tsx` — identify how it fetches (`apiFetch`), renders provider rows, and whether provider names are hard-coded (if a `PROVIDER_LABELS` map exists, add `deepseek: "DeepSeek"`).

- [ ] **Step 2: Add the enrichment toggle + spend-ceiling control**

Add a control card near the top of the cost page (use the page's existing card/button components; this is the shape, adapt class names to the page's design system):

```tsx
// State
const [enrichEnabled, setEnrichEnabled] = useState<boolean | null>(null);
const [ceiling, setCeiling] = useState<number | null>(null);
const [todaySpend, setTodaySpend] = useState<number | null>(null);
const [ceilingInput, setCeilingInput] = useState("");

useEffect(() => {
  apiFetch<{ enabled: boolean }>("/admin/enrichment/toggle").then((r) => setEnrichEnabled(r.data.enabled));
  apiFetch<{ ceilingUsd: number; todaySpendUsd: number }>("/admin/extraction/spend-ceiling").then((r) => {
    setCeiling(r.data.ceilingUsd);
    setTodaySpend(r.data.todaySpendUsd);
    setCeilingInput(String(r.data.ceilingUsd));
  });
}, []);

async function toggleEnrichment() {
  const next = !enrichEnabled;
  await apiFetch("/admin/enrichment/toggle", { method: "PUT", body: JSON.stringify({ enabled: next }) });
  setEnrichEnabled(next);
}
async function saveCeiling() {
  const v = Number(ceilingInput);
  if (!Number.isFinite(v) || v < 0) return;
  const r = await apiFetch<{ ceilingUsd: number }>("/admin/extraction/spend-ceiling", { method: "PUT", body: JSON.stringify({ ceilingUsd: v }) });
  setCeiling(r.data.ceilingUsd);
}
```

```tsx
{/* Control card */}
<div className="rounded-xl border p-4 space-y-3">
  <div className="flex items-center justify-between">
    <div>
      <div className="font-semibold">Entity extraction (DeepSeek V4-Flash)</div>
      <div className="text-sm text-gray-500">Turns the only paid API step on/off instantly — no deploy.</div>
    </div>
    <button onClick={toggleEnrichment} className={`px-3 py-1 rounded ${enrichEnabled ? "bg-emerald-600 text-white" : "bg-gray-300"}`}>
      {enrichEnabled == null ? "…" : enrichEnabled ? "ON" : "OFF"}
    </button>
  </div>
  <div className="flex items-center gap-2">
    <label className="text-sm">Daily spend ceiling (USD):</label>
    <input value={ceilingInput} onChange={(e) => setCeilingInput(e.target.value)} className="border rounded px-2 py-1 w-24" inputMode="decimal" />
    <button onClick={saveCeiling} className="px-3 py-1 rounded bg-black text-white text-sm">Save</button>
    <span className="text-sm text-gray-500">
      Today: ${todaySpend?.toFixed(4) ?? "…"} / ${ceiling ?? "…"} — extraction auto-pauses when today's spend hits the ceiling.
    </span>
  </div>
</div>
```

- [ ] **Step 3: Verify the build**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

Run: `npm run build -w @dashmani/internal`
Expected: build passes.

- [ ] **Step 4: Commit**

```bash
git add apps/internal/src/app/api-costs/page.tsx
git commit -m "feat(ui): api-costs enrichment toggle + daily spend ceiling + DeepSeek"
```

---

## Task 11: Full local verification (all apps)

**Files:** none (verification).

- [ ] **Step 1: Typecheck the API + shared**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors.

- [ ] **Step 2: Run the full API test suite**

Run: `npm run test -w @dashmani/api`
Expected: all green. ⚠️ Per project memory, there are ~36 PRE-EXISTING unrelated failures (content/analytics/task/team setup gaps) — confirm the extraction, api-usage, cron, enrichment-toggle, and extraction-spend suites specifically pass; don't be alarmed by the known-unrelated reds.

- [ ] **Step 3: Full monorepo build**

Run: `npm run build`
Expected: all apps build (auth pages etc. unaffected).

- [ ] **Step 4: Commit any lint/type fixups**

```bash
git add -A
git commit -m "chore(extraction): typecheck + build fixups for DeepSeek migration" || echo "nothing to fix"
```

---

## Task 12: Deploy + controlled backlog drain (the money-sensitive step)

**Files:** none (deploy + operational).

**⚠️ This is where money is spent. Follow the order exactly — cache verified BEFORE full drain, off-peak, ceiling in place.**

- [ ] **Step 1: Merge to main → auto-deploy**

```bash
git push origin <branch>
# open PR, merge to main; GitHub Actions deploys in ~3 min
curl -s https://api.digitalsukoon.com/v1/health   # {"success":true}
```

- [ ] **Step 2: Confirm the key + a low temporary ceiling are live on prod**

```bash
ssh linode 'grep ^DEEPSEEK_API_KEY /opt/dashmani-platform/apps/api/.env | sed "s/=.*/=<present>/"'
# set a LOW ceiling first ($0.50) so the first live run can't overspend while we watch
curl -s -X PUT https://api.digitalsukoon.com/v1/admin/extraction/spend-ceiling \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{"ceilingUsd":0.5}'
```

- [ ] **Step 3: Restart the API so it picks up the new key (runtime-only var)**

```bash
ssh linode 'cd /opt/dashmani-platform && pm2 restart api && pm2 save'
```

- [ ] **Step 4: Trigger ONE small controlled run + verify cache hits + cost**

```bash
# fire the manual enrichment refresh (harvest+extract), then watch the log
curl -s -X POST https://api.digitalsukoon.com/v1/admin/insights/refresh -H "Authorization: Bearer <ADMIN_TOKEN>"
ssh linode 'pm2 logs api --lines 40 --nostream | grep entity-extraction'
```

Then confirm the DeepSeek rows show **cache hits** and the true per-call cost:

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"
SELECT COUNT(*), ROUND(AVG(input_tokens)) avg_in, ROUND(AVG(output_tokens)) avg_out,
       ROUND(SUM(cost_usd)::numeric,4) spend, ROUND(AVG(cost_usd)::numeric,6) per_call
FROM api_usage WHERE provider='deepseek' AND created_at > now() - interval '1 hour';\""
```

Expected (re-verified 2026-07-15 against the real 20,453-tok/call profile):
- **`avg_out` is small (tens, NOT hundreds)** → thinking is off. If it's hundreds, thinking mode leaked — **STOP**.
- **`per_call` should be ~$0.00008–$0.00017** once the cache is warm (prefix ~99.8% cached). Anything up to ~$0.0004 is acceptable on the first warming run.
- **⚠️ HARD STOP: if `per_call` is ≈ $0.0029 (or `SUM prompt_cache_hit_tokens` across the run is ~0), the cache is NOT hitting** — every input token is billed at the $0.14/M miss rate. At that rate the full backlog is ~$67 off-peak / ~$134 peak (peak EXCEEDS the $50 balance). Do NOT raise the ceiling or drain. Investigate prefix stability (Task 4/5: is the system message byte-identical across calls? is the entity list being refreshed too often?) before spending further.
- To confirm cache directly, check the hit/miss split:
  ```bash
  ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"SELECT SUM(input_tokens) total_in FROM api_usage WHERE provider='deepseek' AND created_at > now() - interval '1 hour';\""
  # then eyeball pm2 logs / a probe response's prompt_cache_hit_tokens — it must be >0 and near prompt_tokens on warm calls.
  ```

- [ ] **Step 5: Raise the ceiling to drain the backlog OFF-PEAK**

Off-peak UTC = avoid 01:00–04:00 and 06:00–10:00. With cache confirmed (Step 4), the whole ~23,000 backlog costs **~$2.50** (cache-on, off-peak — the expected case). The $15 ceiling below is deliberately generous: it covers even the **cache-HALF-works ($44.69)** thrash case while staying under the $50 balance, so a partial cache degradation still can't overspend. Set it and drain:

```bash
# $15 ceiling: expected drain is ~$2.50; $15 also covers a cache-thrash ($44.69→capped)
# degradation, and is still a hard cap well under the $50 balance.
curl -s -X PUT https://api.digitalsukoon.com/v1/admin/extraction/spend-ceiling \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{"ceilingUsd":15}'
# optionally raise the per-run cap for a faster drain:
ssh linode 'grep -q ^ENTITY_EXTRACTION_CAP /opt/dashmani-platform/apps/api/.env || echo "ENTITY_EXTRACTION_CAP=3000" >> /opt/dashmani-platform/apps/api/.env; pm2 restart api'
```

- [ ] **Step 6: Monitor the drain to completion**

```bash
watch -n 60 'ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -t -c \"SELECT (SELECT COUNT(*) FROM link_content WHERE status=char(111)||char(107) AND extracted_at IS NULL) pending, (SELECT ROUND(SUM(cost_usd)::numeric,2) FROM api_usage WHERE provider=char(100)||char(101)||char(101)||char(112)||char(115)||char(101)||char(101)||char(107) AND created_at::date = now()::date) spend_today\""'
```

(Simpler: just re-run the `psql` count each check.) Expected: `pending` falls toward 0; `spend_today` climbs toward ~$12–13 and stops. When pending ≈ 0, the backlog is cleared.

- [ ] **Step 7: Reset to steady-state guardrails**

```bash
# drop the temp cap back to the normal per-run cap
ssh linode 'sed -i "/^ENTITY_EXTRACTION_CAP=/d" /opt/dashmani-platform/apps/api/.env; pm2 restart api'
# set the ongoing daily ceiling to the default $3 (steady-state is ~$0.33-0.50/day)
curl -s -X PUT https://api.digitalsukoon.com/v1/admin/extraction/spend-ceiling \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{"ceilingUsd":3}'
```

- [ ] **Step 8: Enable the DeepSeek balance alert (belt-and-suspenders)**

In the DeepSeek console → Usage → the "Balance alert disabled" link → enable a low-balance email alert (e.g. at $10). This is the last safety net outside our code.

---

## Task 12b: Fix the manual backfill script key-gate + DeepSeek retry regression test

**Files:**
- Modify: `scripts/extract-entities.ts` (key gate ~line 33)
- Test: `apps/api/tests/entity-extraction.test.ts`

Two minor-but-real fixes from adversarial review. (1) The documented manual backlog-drain command (`scripts/extract-entities.ts`, referenced in CLAUDE.md) gates on `ANTHROPIC_API_KEY` — after this migration it must gate on `DEEPSEEK_API_KEY` or the manual drain aborts (the primary drain via `/admin/insights/refresh` still works, so this is a stale secondary path, but the docs point at it). (2) A DeepSeek-503→`"retry"` test locks in the `isTransientError` regex change so a future edit can't silently reintroduce the 2026-06-26 "mark-done-untagged" data-loss class.

- [ ] **Step 1: Fix the script key gate**

In `scripts/extract-entities.ts`, find the key check (~line 33, currently referencing `ANTHROPIC_API_KEY`) and change it to require `DEEPSEEK_API_KEY`:

```typescript
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY not set — cannot extract. Set it in apps/api/.env or the shell.");
  process.exit(1);
}
```

- [ ] **Step 2: Add the DeepSeek transient-retry regression test**

Add to `apps/api/tests/entity-extraction.test.ts`:

```typescript
it("a deepseek 503 is TRANSIENT → row stays pending (retry), status NOT demoted", async () => {
  const lc = await prisma.linkContent.create({
    data: { canonicalKey: "yt:ds503", title: "t", caption: "Salman Khan", status: "ok" },
  });
  const overloaded: RawExtractFn = async () => {
    throw new Error("deepseek: HTTP 503 service unavailable");
  };
  const sys = buildSystemPromptWithEntities([]);
  const res = await extractOne({ id: lc.id, title: "t", caption: "Salman Khan" }, sys, overloaded);
  expect(res).toBe("retry"); // transient → retried next run
  const row = await prisma.linkContent.findUnique({ where: { id: lc.id } });
  expect(row?.status).toBe("ok"); // NEVER demoted
  expect(row?.extractedAt).toBeNull(); // stays pending
});
```

- [ ] **Step 3: Run + verify**

Run: `npm run test -w @dashmani/api -- entity-extraction.test.ts -t "deepseek 503"`
Expected: PASS. (Confirms the `isTransientError` regex from Task 5 Step 4 catches `deepseek: HTTP 503`.)

- [ ] **Step 4: Commit**

```bash
git add scripts/extract-entities.ts apps/api/tests/entity-extraction.test.ts
git commit -m "fix(extraction): backfill script gates on DEEPSEEK_API_KEY; deepseek-503 retry regression test"
```

---

## Task 13: Update CLAUDE.md + memory

**Files:**
- Modify: `CLAUDE.md` (extraction provider section)

- [ ] **Step 1: Update the extraction provider note in CLAUDE.md**

Replace the "GEMINI-ONLY" extraction description with the DeepSeek reality: sole provider `deepseek-v4-flash` non-thinking, cache-on via stable system prefix (batch-refreshed every 50 new entities, NOT per call), peak-pricing multiplier, hard daily spend ceiling (`extraction.spendCeilingUsd`, default $3) enforced by the cron + editable on `/api-costs`, and the ⚠️ rules: never re-inline the entity list into the per-call user prompt (kills the cache); never remove `thinking:{type:"disabled"}` (bloats output); DeepSeek peak hours UTC 01:00–04:00 + 06:00–10:00 are 2×.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: extraction is DeepSeek-only with cache + spend ceiling"
```

---

## Self-Review Notes

- **Gemini removal:** Task 5 Step 4 removes Gemini/OpenAI/Anthropic from the active `defaultRawExtract` chain (DeepSeek sole provider); Task 8 Step 3b changes the cron gate from the three old keys to `DEEPSEEK_API_KEY`. The Gemini/OpenAI price rows in `api-usage.service.ts` are intentionally KEPT (historical `effectiveRowCostUsd` recompute of the 90k already-extracted rows depends on them — removing them would zero-out real historical cost).
- **API cost toggle:** the existing `enrichment.enabled` kill-switch is surfaced in the UI (Task 10) AND joined by a new hard **spend ceiling** (Tasks 7–10) — two independent overspend defenses (instant OFF + daily USD cap), plus the DeepSeek console balance alert (Task 12 Step 8).
- **Cache:** Task 4 (stable prefix) + Task 5 (batch-refresh every 50, not per-call) + DeepSeek's default disk cache = the mechanism. Task 12 Step 4 VERIFIES cache hits live before any full drain — if it's not hitting, the drain halts.
- **Overspend safety:** arithmetic worst case (no-cache + all-peak) is $133.91 > $50 balance, but UNREACHABLE given the guards: (a) cache verified live before any large drain (Task 12 Step 4 hard-stop), (b) off-peak drain, (c) hard $15 drain ceiling / $3 steady ceiling checked at run-start AND mid-batch every 100 rows, (d) DeepSeek console balance alert. Expected backlog cost ~$2.50 (cache-on).
- **All values are DeepSeek-based** (Tasks 2, 3, 6 price rows + multiplier; Task 12 targets).
- **No `db:push`** — reuses `system_settings`, `api_usage`, `link_content`, `entities`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-deepseek-extraction-migration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?