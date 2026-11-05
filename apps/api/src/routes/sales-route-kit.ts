import { Request, Response } from "express";
import { DEFAULT_COMPANY, isCompanyKey, type CompanyKey } from "@dashmani/shared";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requirePermission } from "../middleware/rbac";
import { AppError } from "../middleware/error-handler";
import type { SalesEntity } from "../services/sales/common";

// The pieces every /sales/* router shares (spec-00 §2.1): the gates, the request helpers and the
// download helper. Moved out of sales.routes.ts unchanged so the smart-invoicing feature routers
// (sales-accounts / -tally / -import / -bank .routes.ts) gate and parse exactly like it does.

// sales.digitalsukoon.com — staff only. `sales.view` reads; `sales.manage` writes (the Sales
// role and both admin roles hold both, see packages/db/prisma/seed.ts).
export const view = [authenticate, requireInternalUser, requirePermission("sales", "view")];
export const manage = [authenticate, requireInternalUser, requirePermission("sales", "manage")];
// The company's own GST identity and BANK DETAILS print on every invoice; a changed account number
// is how invoice fraud starts. Only Admin / Super Admin (who hold sales:approve) may change them.
export const admin = [authenticate, requireInternalUser, requirePermission("sales", "approve")];
export const staffId = (req: Request) => req.user!.userId;
export const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** ?company=dspl|dmpl. Lists without it show both companies; settings and the dashboard default to Digital Sukoon. */
export const companyQuery = (req: Request): CompanyKey | undefined => {
  const v = str(req.query.company);
  if (v === undefined) return undefined;
  if (!isCompanyKey(v)) throw new AppError(400, "BAD_COMPANY", "Unknown company");
  return v;
};
export const companyOf = (req: Request): CompanyKey => companyQuery(req) ?? DEFAULT_COMPANY;

/** The entity types GET /sales/events accepts. Pre-registered for every smart-invoicing feature; features never edit this list. */
export const ENTITY_TYPES: SalesEntity[] = [
  "quote",
  "order",
  "invoice",
  "payment",
  "credit_note",
  "settings",
  "client",
  "recurring",
  "filed_year",
  "tally_run",
  "import",
  "bank_account",
  "bank_statement",
  "bank_line",
];

/**
 * Send a generated file (Tally XML, an accounts CSV/PDF, an import report CSV). The name is
 * reduced to [\w.-] so it can never break the header; the portal reads it from
 * Content-Disposition (cross-origin, hence the expose header). Never cached, never sniffed.
 */
export function sendDownload(res: Response, body: Buffer, o: { contentType: string; filename: string; inline?: boolean }) {
  const name = o.filename.replace(/[^\w.-]+/g, "-");
  res.setHeader("Content-Type", o.contentType);
  res.setHeader("Content-Disposition", `${o.inline ? "inline" : "attachment"}; filename="${name}"`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(body.length));
  return res.send(body);
}
