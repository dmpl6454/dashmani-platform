import crypto from "crypto";
import { prisma } from "@dashmani/db";
import type { JwtPayload } from "@dashmani/shared";
import { AppError } from "../middleware/error-handler";
import { issueEmployeeSession } from "./auth.service";
import { issueHrSession } from "./hr-auth.service";

/**
 * Connecting the portals (2026-10-26). All three STAFF portals sign in the same `users` row —
 * the staff portal (portal.digitalsukoon.com) and the sales portal with an `employee` token,
 * the HR portal with an `hr` token — so switching between them needs no second password: the
 * portal the user is on asks for a one-time HANDOFF code (POST /auth/handoff), sends the browser
 * to the target's /login#handoff=<code>, and that login page exchanges the code for its own
 * session (POST /auth/handoff/exchange). The code rides in the URL FRAGMENT, which browsers never
 * send to a server: it stays out of nginx / Cloudflare logs and out of every Referer header. Codes are 256-bit random, live 60 s, are bound to one
 * target portal and die on first use. They live in memory: the API is one pm2 fork process, and
 * a code lost to a restart is a code the user re-requests with one click.
 *
 * GET /auth/portals is the directory every portal's switcher renders: which staff portals this
 * account may enter (the staff and HR portals take every active employee; Sales needs the
 * `sales:view` permission — the same DB check the /sales routes make) plus the public sites.
 */

export type StaffPortal = "internal" | "hr" | "sales";
export const STAFF_PORTALS: readonly StaffPortal[] = ["internal", "hr", "sales"] as const;

const HANDOFF_TTL_MS = 60_000;
const trim = (u: string) => u.replace(/\/+$/, "");
const prod = () => process.env.NODE_ENV === "production";

/** Where each portal lives — the same env the CORS list reads (app.ts); localhost in dev. */
export function portalUrls() {
  return {
    internal: trim(process.env.INTERNAL_APP_URL || "http://localhost:3000"),
    hr: trim(process.env.HR_APP_URL || "http://localhost:3002"),
    sales: trim(process.env.SALES_APP_URL || "http://localhost:3006"),
    client: trim(process.env.CLIENT_APP_URL || "http://localhost:3001"),
    creators: trim(process.env.CREATORS_APP_URL || "http://localhost:3005"),
    jobs: trim(process.env.JOBS_APP_URL || (prod() ? "https://jobs.digitalsukoon.com" : "http://localhost:3003")),
    web: trim(process.env.WEB_APP_URL || (prod() ? "https://digitalsukoon.com" : "http://localhost:3004")),
  };
}

export interface PortalEntry { key: StaffPortal; name: string; blurb: string; url: string; access: boolean }
export interface PortalLink { key: "client" | "creators" | "jobs" | "web"; name: string; blurb: string; url: string }
export interface PortalDirectory { portals: PortalEntry[]; links: PortalLink[] }

async function canUseSales(userId: string): Promise<boolean> {
  const n = await prisma.userRole.count({
    where: { userId, role: { permissions: { some: { resource: "sales", action: "view" } } } },
  });
  return n > 0;
}

export async function listPortals(user: Pick<JwtPayload, "userId">): Promise<PortalDirectory> {
  const u = portalUrls();
  const sales = await canUseSales(user.userId);
  return {
    portals: [
      { key: "internal", name: "Staff portal", blurb: "People, accounts, campaigns, reports", url: u.internal, access: true },
      { key: "hr", name: "HR portal", blurb: "Attendance, leave, salary slips, documents", url: u.hr, access: true },
      { key: "sales", name: "Sales portal", blurb: "Inventory, quotes, orders, invoices", url: u.sales, access: sales },
    ],
    links: [
      { key: "client", name: "Client portal", blurb: "Where clients book campaigns", url: u.client },
      { key: "creators", name: "Creators", blurb: "The creator programme", url: u.creators },
      { key: "jobs", name: "Careers", blurb: "Open roles and internships", url: u.jobs },
      { key: "web", name: "digitalsukoon.com", blurb: "The public site", url: u.web },
    ],
  };
}

interface Pending { userId: string; target: StaffPortal; expiresAt: number }
const pending = new Map<string, Pending>();
function sweep(now = Date.now()) {
  for (const [code, p] of pending) if (p.expiresAt <= now) pending.delete(code);
}

/** A one-time code for `target`, as the URL the browser should be sent to. */
export async function createHandoff(user: Pick<JwtPayload, "userId">, target: StaffPortal) {
  const dir = await listPortals(user);
  const entry = dir.portals.find((p) => p.key === target);
  if (!entry) throw new AppError(400, "VALIDATION_ERROR", "Unknown portal");
  if (!entry.access) throw new AppError(403, "PORTAL_NO_ACCESS", `Your account cannot use the ${entry.name} — ask an admin for the role.`);
  sweep();
  const code = crypto.randomBytes(32).toString("hex");
  pending.set(code, { userId: user.userId, target, expiresAt: Date.now() + HANDOFF_TTL_MS });
  return { target, url: `${entry.url}/login#handoff=${code}`, expiresInSeconds: HANDOFF_TTL_MS / 1000 };
}

/** The target portal's login page turns the code into that portal's own session. */
export async function exchangeHandoff(code: string) {
  sweep();
  const p = pending.get(code);
  if (p) pending.delete(code); // one use, whatever happens next
  if (!p) throw new AppError(410, "HANDOFF_INVALID", "That sign-in link has expired or was already used. Go back and open the portal again.");
  const user = await prisma.user.findFirst({ where: { id: p.userId, deletedAt: null }, include: { roles: { include: { role: true } } } });
  if (!user || user.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");
  const session = p.target === "hr" ? await issueHrSession(user) : await issueEmployeeSession(user, false);
  return { target: p.target, ...session };
}

/** Tests only: age every pending code past its TTL. */
export function _expireHandoffsForTest() {
  for (const p of pending.values()) p.expiresAt = 0;
}
