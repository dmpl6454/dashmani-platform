/**
 * Pipeline route validators (spec §3.4, §3.5). Used by the API (`validate(schema, source)`)
 * and by the HR portal for form checks, so they never disagree.
 *
 * ⚠️ Two rules that make these safe on the API main thread:
 *   1. Every free-text field is LENGTH-BOUNDED BEFORE any transform. Zod does not run a
 *      transform when the inner check failed, so a 1 MB `<`-only title is rejected by the
 *      `max(240)` check and never reaches the tag-stripping `safeString` (whose regex is
 *      quadratic on unmatched `<` on some branches).
 *   2. No regex lookbehind (this file ships in the HR bundle; older iOS Safari throws at
 *      parse time). The only regexes here are anchored fixed-shape patterns.
 *
 * Bodies and descriptions use `normalizeText`, never `safeString`: they are rendered as
 * React text only, and tag-stripping would delete legitimate text such as "a<b and c>d".
 */
import { z } from "zod";
import { safeString } from "../utils/sanitize";
import { normalizeText, stripBidi } from "../pipeline/text";
import { PIPELINE_LIMITS, PIPELINE_REACTION_KEYS } from "../pipeline/constants";

/** Postgres int4 ceiling — every cursor/seq/rev compared with an Int column stays under it. */
const INT4_MAX = 2_147_483_647;

// ── Primitives ──────────────────────────────────────────────────────────────────────

/** A lowercase UUID. Ids in this database are lowercase text. */
export const pipelineId = z
  .string()
  .max(36)
  .uuid()
  .transform((s) => s.toLowerCase());

/** Up to `max` ids, de-duplicated (after lowercasing) and in first-seen order. */
export function pipelineIdArray(max: number, min = 0) {
  return z
    .array(pipelineId)
    .min(min)
    .max(max)
    .transform((a) => [...new Set(a)]);
}

export const pipelineTitle = z
  .string()
  .max(PIPELINE_LIMITS.titleRawMax)
  .transform(stripBidi)
  .pipe(safeString)
  .pipe(z.string().min(1).max(PIPELINE_LIMITS.titleMax));

export const pipelineDescription = z.string().max(PIPELINE_LIMITS.descriptionMax).transform(normalizeText);

export const pipelineBody = z
  .string()
  .max(PIPELINE_LIMITS.bodyMax)
  .transform(normalizeText)
  .pipe(z.string().min(1, "Message is empty"));

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDay(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** An IST calendar day as `YYYY-MM-DD` (spec §2 rule 9: dates are `@db.Date`). */
export const pipelineDate = z
  .string()
  .max(10)
  .regex(DATE_SHAPE, "Use YYYY-MM-DD")
  .refine(isRealCalendarDay, "Not a real calendar day");

/** A nullable, optional date: `null` clears the field. */
const optionalDate = pipelineDate.nullable().optional();

const int4 = (min: number) => z.number().int().min(min).max(INT4_MAX);

/** Query-string integer: absent → `def`; present → an integer in [min, max]. */
function queryInt(min: number, max: number, def?: number) {
  return z
    .preprocess((v) => (v === undefined || v === "" ? undefined : v), z.coerce.number().int().min(min).max(max).optional())
    .transform((v) => (v === undefined ? def : v));
}

/** Error message a start-after-due refinement reports (the API maps it to 400 DATE_ORDER). */
export const DATE_ORDER = "DATE_ORDER";

function checkDateOrder(
  v: { startDate?: string | null; dueDate?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (v.startDate && v.dueDate && v.startDate > v.dueDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dueDate"], message: DATE_ORDER });
  }
}

export const reactionKeySchema = z.enum(PIPELINE_REACTION_KEYS);

// ── Params ──────────────────────────────────────────────────────────────────────────

export const projectParamsSchema = z.object({ id: pipelineId });
export const memberParamsSchema = z.object({ id: pipelineId, userId: pipelineId });
export const messageParamsSchema = z.object({ mid: pipelineId });
export const reactionParamsSchema = z.object({ mid: pipelineId, emoji: reactionKeySchema });

// ── Route #3: POST /pipeline/sync (§5.2) ─────────────────────────────────────────────

export const syncRequestSchema = z.object({
  clientBuild: int4(0),
  board: z.object({ v: int4(-1) }).optional(),
  mineH: z.string().max(64).optional(),
  project: z
    .object({
      id: pipelineId,
      rev: int4(0),
      hv: int4(0),
      ack: z
        .object({
          seq: int4(0),
          open: z.boolean().optional(),
          leaving: z.boolean().optional(),
          seen: pipelineIdArray(PIPELINE_LIMITS.seenIdsMax).optional(),
        })
        .optional(),
    })
    .optional(),
});

// ── Route #4: GET /pipeline/projects ─────────────────────────────────────────────────

/** `<ISO timestamp>,<uuid>` keyset cursor (the list's `nextCursor`, passed back verbatim). */
export const listCursorSchema = z
  .string()
  .max(100)
  .transform((s, ctx) => {
    const comma = s.lastIndexOf(",");
    const at = comma > 0 ? s.slice(0, comma) : "";
    const id = comma > 0 ? s.slice(comma + 1) : "";
    const time = Date.parse(at);
    const idOk = pipelineId.safeParse(id);
    if (!Number.isFinite(time) || !idOk.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cursor" });
      return z.NEVER;
    }
    return { at: new Date(time).toISOString(), id: idOk.data };
  });

export const listProjectsQuerySchema = z.object({
  view: z.enum(["archived", "deleted"]),
  cursor: listCursorSchema.optional(),
  limit: queryInt(1, PIPELINE_LIMITS.listPageMax, PIPELINE_LIMITS.listPageMax),
});

// ── Route #5: POST /pipeline/projects ────────────────────────────────────────────────

export const createProjectSchema = z
  .object({
    clientId: pipelineId,
    title: pipelineTitle,
    description: pipelineDescription.optional(),
    phaseId: pipelineId.optional(),
    startDate: optionalDate,
    dueDate: optionalDate,
    memberIds: pipelineIdArray(PIPELINE_LIMITS.membersPerRequestMax).optional(),
  })
  .superRefine(checkDateOrder);

// ── Route #6: GET /pipeline/projects/:id ─────────────────────────────────────────────

export const projectDetailQuerySchema = z.object({ around: pipelineId.optional() });

// ── Route #7: PATCH /pipeline/projects/:id ───────────────────────────────────────────

const editableFields = z.object({
  title: pipelineTitle.optional(),
  description: pipelineDescription.optional(),
  startDate: optionalDate,
  dueDate: optionalDate,
});

export const EDITABLE_PROJECT_FIELDS = ["title", "description", "startDate", "dueDate"] as const;

export const editProjectSchema = z
  .object({ changes: editableFields, base: editableFields })
  .superRefine((v, ctx) => {
    const changed = EDITABLE_PROJECT_FIELDS.filter((k) => v.changes[k] !== undefined);
    if (changed.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changes"], message: "Nothing to change" });
    }
    for (const k of changed) {
      if (v.base[k] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["base", k], message: "Missing base value" });
      }
    }
    checkDateOrder(v.changes, ctx);
  });

// ── Route #8: POST /pipeline/projects/:id/move ───────────────────────────────────────

export const moveProjectSchema = z.object({
  toPhaseId: pipelineId,
  afterId: pipelineId.nullable(),
  basePhaseId: pipelineId,
});

// ── Routes #9–11 ─────────────────────────────────────────────────────────────────────

/** archive / unarchive / restore take `{}`; unknown keys are dropped. */
export const emptyBodySchema = z.object({});

export const deleteProjectSchema = z.object({ confirmTitle: z.string().max(PIPELINE_LIMITS.titleRawMax) });

export const transferOwnerSchema = z.object({ userId: pipelineId });

// ── Routes #12–14 ────────────────────────────────────────────────────────────────────

export const addMembersSchema = z.object({
  userIds: pipelineIdArray(PIPELINE_LIMITS.membersPerRequestMax, 1),
});

export const followSchema = z.object({ following: z.boolean() });

// ── Routes #15–21 ────────────────────────────────────────────────────────────────────

export const messagesQuerySchema = z.object({
  before: queryInt(1, INT4_MAX),
  limit: queryInt(1, PIPELINE_LIMITS.messagesPageMax, PIPELINE_LIMITS.messagesPageDefault),
});

export const repliesQuerySchema = z.object({
  after: queryInt(0, INT4_MAX, 0),
  limit: queryInt(1, PIPELINE_LIMITS.messagesPageMax, PIPELINE_LIMITS.messagesPageDefault),
});

export const postMessageSchema = z.object({
  clientId: pipelineId,
  body: pipelineBody,
  parentId: pipelineId.optional(),
});

export const editMessageSchema = z.object({ body: pipelineBody });

export const reactionBodySchema = z.object({ on: z.boolean() });

export const readSchema = z.object({ seq: int4(0), leaving: z.boolean().optional() });
