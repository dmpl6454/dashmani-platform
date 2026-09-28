/**
 * Pipeline gates (spec §3.2 "Gates", §4).
 *
 *   G0 = authenticate → requirePipelineToken          (bootstrap uses G0 only)
 *   G  = G0 → requirePipelineAccess                    (every other route)
 *   +O = assertOwnerOrAdmin(tx, …) inside the action's transaction
 *
 * ⚠️ WHY AN ALLOWLIST. All portals sign access tokens with ONE JWT_SECRET and
 * `authenticate` checks only the signature, so on its own it admits internal-employee
 * tokens, client-portal access tokens AND client-portal REFRESH tokens — which are
 * `{userId}` with no `type` at all. PIPELINE_TOKEN_TYPES must therefore stay an ALLOWLIST
 * (`type` is undefined on client refresh tokens, so a denylist would admit them).
 * Phase 2 adds "employee"; both token types carry the same User.id.
 *
 * requirePipelineAccess reads memos only (zero statements on a hit): the schema verdict,
 * the settings (15 s), and the user's {active, isAdmin} (60 s). Outcomes:
 *   schema missing / mode off  → 403 PIPELINE_DISABLED   (client: "paused", re-checks)
 *   pilot and not listed       → 403 PIPELINE_NOT_IN_PILOT
 *   inactive / deleted / gone  → 403 ACCOUNT_INACTIVE
 *   settings unreadable        → 503 PIPELINE_BUSY        (never 403 — see settings.ts)
 * No requirePermission here (it would query the MAIN pool on every poll).
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { DEFAULT_ROLES, type PipelineDisabledReason } from "@dashmani/shared";
import { authenticate } from "./auth";
import { asyncHandler } from "../utils/async-handler";
import { getPipelineSettings, type PipelineSettings } from "../services/pipeline/settings";
import { getPipelineAccess, type PipelineAccess } from "../services/pipeline/access";
import { ensurePipelineSchemaChecked } from "../services/pipeline/self-check";
import { healPendingBoardBump } from "../services/pipeline/board";
import { PipelineError } from "../services/pipeline/errors";
import type { PipelineTx } from "../services/pipeline/db";

/** ⚠️ Must remain an ALLOWLIST: `type` is undefined on client-portal refresh tokens. */
export const PIPELINE_TOKEN_TYPES: readonly string[] = ["hr"];

export interface PipelineRequestContext {
  userId: string;
  settings: PipelineSettings;
  access: PipelineAccess;
}

declare global {
  namespace Express {
    interface Request {
      pipeline?: PipelineRequestContext;
    }
  }
}

function deny(res: Response, status: number, code: string, message: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ success: false, error: { code, message } });
}

/** G0's second half. Synchronous; a wrong token type is 403 FORBIDDEN, never 401. */
export function requirePipelineToken(req: Request, res: Response, next: NextFunction): void {
  const type = req.user?.type;
  if (typeof type !== "string" || !PIPELINE_TOKEN_TYPES.includes(type) || typeof req.user?.userId !== "string") {
    deny(res, 403, "FORBIDDEN", "This is available in the Employee Portal only");
    return;
  }
  next();
}

export type PipelineDenial =
  | { status: 403; code: "PIPELINE_DISABLED"; reason: Extract<PipelineDisabledReason, "off" | "paused"> }
  | { status: 403; code: "PIPELINE_NOT_IN_PILOT"; reason: "not_in_pilot" }
  | { status: 403; code: "ACCOUNT_INACTIVE"; reason: "inactive" };

const DENIAL_MESSAGE: Record<PipelineDenial["code"], string> = {
  PIPELINE_DISABLED: "Pipeline is paused",
  PIPELINE_NOT_IN_PILOT: "Pipeline isn't available for your account yet",
  ACCOUNT_INACTIVE: "Your account is inactive",
};

/**
 * The feature-level decision shared by the G gate (403s) and bootstrap (which answers
 * `{enabled:false, reason}` instead). Memo reads only; heals a pending board bump.
 * @throws PipelineError 503 PIPELINE_BUSY when settings or access cannot be read.
 */
export async function evaluatePipelineAccess(
  userId: string,
): Promise<{ ok: true; ctx: PipelineRequestContext } | { ok: false; denial: PipelineDenial }> {
  if (!(await ensurePipelineSchemaChecked())) {
    return { ok: false, denial: { status: 403, code: "PIPELINE_DISABLED", reason: "paused" } };
  }
  const settings = await getPipelineSettings();
  if (settings.mode === "off") {
    return { ok: false, denial: { status: 403, code: "PIPELINE_DISABLED", reason: "off" } };
  }
  if (settings.mode === "pilot" && !settings.pilotUserIds.has(userId.toLowerCase())) {
    return { ok: false, denial: { status: 403, code: "PIPELINE_NOT_IN_PILOT", reason: "not_in_pilot" } };
  }
  const access = await getPipelineAccess(userId);
  if (!access.active) {
    return { ok: false, denial: { status: 403, code: "ACCOUNT_INACTIVE", reason: "inactive" } };
  }
  await healPendingBoardBump();
  return { ok: true, ctx: { userId, settings, access } };
}

/** G's third half: sets `req.pipeline` or answers the 403 / 503. */
export const requirePipelineAccess: RequestHandler = asyncHandler(async (req, res, next) => {
  const result = await evaluatePipelineAccess(req.user!.userId);
  if (!result.ok) {
    deny(res, result.denial.status, result.denial.code, DENIAL_MESSAGE[result.denial.code]);
    return;
  }
  req.pipeline = result.ctx;
  next();
});

/** Bootstrap's gate. */
export const G0: RequestHandler[] = [authenticate, requirePipelineToken];
/** Every other pipeline route's gate. */
export const G: RequestHandler[] = [authenticate, requirePipelineToken, requirePipelineAccess];

// ── +O: owner or admin, checked FRESH in the action's transaction (spec §4.5) ────────

const ADMIN_ROLE_NAMES = [DEFAULT_ROLES.SUPER_ADMIN.name, DEFAULT_ROLES.ADMIN.name];

/** Admin status from the database at action time — never the JWT, never a memo. */
export async function isPipelineAdmin(tx: PipelineTx, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ is_admin: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ${userId} AND r.name = ANY(${ADMIN_ROLE_NAMES}::text[])
    ) AS is_admin`;
  return rows[0]?.is_admin === true;
}

/**
 * Owner = `owner_id` from the row the caller locked FOR UPDATE; admin = a fresh DB check.
 * @throws PipelineError 403 NOT_OWNER_OR_ADMIN when the actor is neither.
 */
export async function assertOwnerOrAdmin(
  tx: PipelineTx,
  opts: { actorId: string; ownerId: string },
): Promise<{ isOwner: boolean; isAdmin: boolean }> {
  const isOwner = opts.actorId === opts.ownerId;
  const isAdmin = await isPipelineAdmin(tx, opts.actorId);
  if (!isOwner && !isAdmin) {
    throw new PipelineError(403, "NOT_OWNER_OR_ADMIN", "Only the owner or an admin can do this");
  }
  return { isOwner, isAdmin };
}
