import { prisma } from "@dashmani/db";
import type { Creator, CreatorAsset, CreatorConnection, Prisma } from "@dashmani/db";
import { CREATOR_STATUSES, type CreatorStatus } from "@dashmani/shared/src/validators/creator";
import { AppError } from "../../middleware/error-handler";
import { likeLiteral } from "../../utils/like-literal";
import { scrubSecrets } from "../../utils/token-crypto";
import { scrubPayoutSecrets } from "../../utils/payout-scrub";
import { toAssetView, toConnectionView, toCreatorMe, isPublishable, liveConnectionWhere, LIVE_CONNECTION_STATUSES } from "./creator-view";
import { syncNetworkDuplicates } from "./creator-discovery.service";
import { sendCreatorEmail, esc, button, creatorLink } from "./creator-email";
import {
  BANK_CHANGE_HOLD_MS,
  bankChangeBlocksRelease,
  bankChangePending,
  decodeSetupError,
  toPayoutAccountView,
  type PayoutAccountView,
} from "./payout-account-view";
import { routeAvailable } from "./payout-account.service";

// Staff review queue for the creator portal (internal portal → /creators).
// ⚠️ Every response goes through creator-view.ts builders plus the admin extras below — never a
// token column (*_enc), the password hash or payout details. Status changes are guarded
// `updateMany WHERE status IN (…)` + count, so two staff clicking at once cannot both win.

/** At most this many creators per list call (the tabs narrow it further). */
const LIST_LIMIT = 500;

const ASSET_LIST_SELECT = {
  kind: true,
  followerCount: true,
  canPublish: true,
  networkDuplicateOf: true,
  disconnectedAt: true,
} as const;

/** The connection that describes the creator now: the newest live grant, else the newest at all. */
function currentConnection<T extends Pick<CreatorConnection, "status" | "createdAt">>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const byNewest = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return byNewest.find((c) => c.status !== "REVOKED") ?? byNewest[0];
}

function searchWhere(q: string | undefined) {
  const term = q?.trim().slice(0, 120);
  if (!term) return {};
  // Prisma sends `contains` + insensitive as ILIKE '%v%' WITHOUT escaping % and _ (see like-literal.ts).
  const pattern = likeLiteral(term);
  return {
    OR: [
      { name: { contains: pattern, mode: "insensitive" as const } },
      { email: { contains: pattern, mode: "insensitive" as const } },
    ],
  };
}

export async function listCreators(opts: { status?: string; q?: string }) {
  const status = opts.status && (CREATOR_STATUSES as readonly string[]).includes(opts.status) ? opts.status : undefined;
  const search = searchWhere(opts.q);

  const [rows, grouped] = await Promise.all([
    prisma.creator.findMany({
      where: { ...search, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      select: {
        id: true,
        name: true,
        email: true,
        country: true,
        status: true,
        submittedAt: true,
        createdAt: true,
        assets: { select: ASSET_LIST_SELECT },
        connections: { select: { status: true, createdAt: true } },
      },
    }),
    // Tab counts follow the search box but not the selected tab.
    prisma.creator.groupBy({ by: ["status"], where: search, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(CREATOR_STATUSES.map((s) => [s, 0])) as Record<CreatorStatus, number>;
  for (const g of grouped) {
    if ((CREATOR_STATUSES as readonly string[]).includes(g.status)) counts[g.status as CreatorStatus] = g._count._all;
  }

  const creators = rows.map((c) => {
    const live = c.assets.filter((a) => a.disconnectedAt == null);
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      country: c.country,
      status: c.status,
      submittedAt: c.submittedAt ? c.submittedAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
      pages: live.length,
      publishablePages: live.filter(isPublishable).length,
      followers: live.reduce((sum, a) => sum + (a.followerCount ?? 0), 0),
      connectionStatus: currentConnection(c.connections)?.status ?? null,
    };
  });
  // The review queue first; otherwise newest first (Array.sort is stable, so createdAt order holds).
  creators.sort((a, b) => Number(b.status === "in_review") - Number(a.status === "in_review"));

  return { creators, counts };
}

function toAdminCreator(c: Creator, reviewedByName: string | null) {
  return {
    ...toCreatorMe(c),
    // Staff always see the last review note (the creator only sees it while it explains their state).
    reviewNote: c.reviewNote,
    reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null,
    reviewedById: c.reviewedById,
    reviewedByName,
    closedAt: c.closedAt ? c.closedAt.toISOString() : null,
    payoutHint: null, // Phase C
  };
}

async function toAdminAssetViews(assets: CreatorAsset[]) {
  const dupIds = [...new Set(assets.map((a) => a.networkDuplicateOf).filter((x): x is string => !!x))];
  const network = dupIds.length
    ? await prisma.metaAsset.findMany({ where: { id: { in: dupIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(network.map((n) => [n.id, n.name]));
  return assets.map((a) => ({
    ...toAssetView(a),
    tasks: a.tasks,
    // "Already on our network": the duplicate exists even when its network row has since gone.
    networkDuplicateOfName: a.networkDuplicateOf ? nameOf.get(a.networkDuplicateOf) ?? null : null,
  }));
}
export type AdminAssetView = Awaited<ReturnType<typeof toAdminAssetViews>>[number];

export async function getCreatorDetail(id: string) {
  const c = await prisma.creator.findUnique({
    where: { id },
    include: {
      connections: true,
      assets: { orderBy: [{ disconnectedAt: { sort: "asc", nulls: "first" } }, { kind: "asc" }, { name: "asc" }] },
    },
  });
  if (!c) throw new AppError(404, "NOT_FOUND", "Creator not found");
  const [reviewer, payout] = await Promise.all([
    c.reviewedById ? prisma.user.findUnique({ where: { id: c.reviewedById }, select: { name: true } }) : null,
    readPayoutAccount(c.id),
  ]);
  const { connections, assets, ...creator } = c;
  const conn = currentConnection(connections);
  return {
    creator: toAdminCreator(creator, reviewer?.name ?? null),
    connection: conn ? toConnectionView(conn) : null,
    assets: await toAdminAssetViews(assets),
    ...payout,
  };
}
export type AdminCreatorDetail = Awaited<ReturnType<typeof getCreatorDetail>>;

// ── Payout account (Razorpay Route bank connect) ─────────────────────────────

// What staff see of a creator's payout account. ⚠️ PRIVACY: the creator's PAN, bank account number,
// IFSC, name and address are never stored by us, so none of them can be here. The view is built from an
// explicit allow-list of columns (PAYOUT_ROW_SELECT) and an explicit list of output keys: Razorpay ids,
// status, requirement references and reason CODES, a masked hint and timestamps. Never `last_error`
// itself (only the short code decoded from it), never the raw `requirements` JSON.

const PAYOUT_ROW_SELECT = {
  razorpayAccountId: true,
  razorpayStakeholderId: true,
  razorpayProductId: true,
  setupStep: true,
  activationStatus: true,
  requirements: true,
  destinationHint: true,
  termsVersion: true,
  activatedAt: true,
  bookableAfter: true,
  bankChangeRequestedAt: true,
  bankChangeClearedAt: true,
  accountCreatedAt: true,
  setupLockedUntil: true,
  lastError: true,
  lastCheckedAt: true,
  updatedAt: true,
} as const;

type PayoutRow = Prisma.CreatorPayoutAccountGetPayload<{ select: typeof PAYOUT_ROW_SELECT }>;

/** The view the creator gets, plus what only staff need to chase a stuck account in Razorpay. */
export interface AdminPayoutAccountView extends PayoutAccountView {
  razorpayAccountId: string | null;
  razorpayStakeholderId: string | null;
  razorpayProductId: string | null;
  /** A short code such as DETAILS_REJECTED; never Razorpay's text. */
  lastErrorCode: string | null;
  lastCheckedAt: string | null;
  accountCreatedAt: string | null;
  /** A bank change the creator asked for that staff have not marked processed yet. */
  bankChangePending: boolean;
  /**
   * Releases for this creator are paused by a bank change: from the request until staff mark it
   * processed, plus 72 hours. `resumesAt` is set only once it has been marked processed.
   */
  releaseHold: { active: boolean; resumesAt: string | null };
}

/**
 * Razorpay ids look like acc_xxx / sth_xxx / acc_prd_xxx: a lower-case prefix, then a short random token.
 * Anything else is not an id, so it is not shown. The prefix is what keeps a bare number (an account
 * number written into the wrong column by mistake) from passing as one.
 */
const RAZORPAY_ID_RE = /^[a-z]{2,5}(?:_[a-z]{2,5})?_[A-Za-z0-9]{4,40}$/;
const razorpayIdOrNull = (v: string | null) => (v && RAZORPAY_ID_RE.test(v) ? v : null);
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function toAdminPayoutAccountView(row: PayoutRow, now: Date = new Date()): AdminPayoutAccountView {
  const pending = bankChangePending(row);
  const holding = bankChangeBlocksRelease(row, now);
  return {
    ...toPayoutAccountView(row, now)!,
    razorpayAccountId: razorpayIdOrNull(row.razorpayAccountId),
    razorpayStakeholderId: razorpayIdOrNull(row.razorpayStakeholderId),
    razorpayProductId: razorpayIdOrNull(row.razorpayProductId),
    lastErrorCode: decodeSetupError(row.lastError)?.code ?? null,
    lastCheckedAt: isoOrNull(row.lastCheckedAt),
    accountCreatedAt: isoOrNull(row.accountCreatedAt),
    bankChangePending: pending,
    releaseHold: {
      active: holding,
      resumesAt: holding && !pending ? new Date(row.bankChangeClearedAt!.getTime() + BANK_CHANGE_HOLD_MS).toISOString() : null,
    },
  };
}

/**
 * The payout part of GET /admin/creators/:id. ⚠️ A failed read must NOT look like "no payout account":
 * it answers `payoutAccountError: true` (and a null account), and the screen says it could not load.
 * It also must not take the review page down with it, which is why it is caught here at all: the
 * review queue works while payouts are dark, and the payout tables are applied by hand before a deploy.
 */
async function readPayoutAccount(creatorId: string) {
  const payoutRouteEnabled = routeAvailable();
  try {
    const row = await prisma.creatorPayoutAccount.findUnique({ where: { creatorId }, select: PAYOUT_ROW_SELECT });
    return { payoutAccount: row ? toAdminPayoutAccountView(row) : null, payoutRouteEnabled, payoutAccountError: false };
  } catch (e) {
    console.warn(`[creator-admin] could not read the payout account of ${creatorId}: ${scrubPayoutSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    return { payoutAccount: null, payoutRouteEnabled, payoutAccountError: true };
  }
}

function bankChangeProcessedEmail(name: string) {
  return {
    subject: "Your bank account change was processed",
    title: "Bank change processed",
    body:
      `<p style="margin:0 0 12px">Hi ${esc(name)},</p>` +
      `<p style="margin:0 0 12px">Our team has completed the bank account change you asked for.</p>` +
      `<p style="margin:0 0 12px">For your protection, payments to you stay paused until 72 hours after this change. After that they go to the new account as normal.</p>` +
      `<p style="margin:0 0 12px">We never ask for bank details by email. If you did not ask for this change, reply to this email right away.</p>` +
      `<p style="margin:18px 0">${button(creatorLink("/payouts"), "Open your payouts page")}</p>`,
  };
}

/**
 * Staff action: the bank change Razorpay support carried out is done (POST …/payout-account/bank-change/cleared).
 * Releases for this creator stay paused for 72 hours more (bankChangeBlocksRelease reads the timestamp).
 *
 * ⚠️ ONE WINNER. The write matches both timestamps as they were READ, so two clicks (two staff, two
 * tabs) cannot both clear one request, and a request the creator made again in between is not cleared
 * by a click that was about the earlier one: the loser gets 409 and the creator is emailed once. The
 * audit row is written in the same transaction, so it never disagrees with the column.
 */
export async function markBankChangeProcessed(creatorId: string, staffId: string) {
  const creator = await prisma.creator.findUnique({ where: { id: creatorId }, select: { id: true, name: true, email: true } });
  if (!creator) throw new AppError(404, "NOT_FOUND", "Creator not found");
  const none = () =>
    new AppError(409, "NO_BANK_CHANGE_REQUEST", "This creator has no bank change request waiting. It may already have been marked processed.");

  const row = await prisma.creatorPayoutAccount.findUnique({
    where: { creatorId },
    select: { id: true, bankChangeRequestedAt: true, bankChangeClearedAt: true },
  });
  if (!row || !row.bankChangeRequestedAt || !bankChangePending(row)) throw none();

  // Never earlier than the request itself, so a clock that disagrees by a few milliseconds cannot
  // leave the request looking pending after a click that reported success.
  const at = new Date(Math.max(Date.now(), row.bankChangeRequestedAt.getTime()));
  const won = await prisma.$transaction(async (tx) => {
    const res = await tx.creatorPayoutAccount.updateMany({
      where: { id: row.id, bankChangeRequestedAt: row.bankChangeRequestedAt, bankChangeClearedAt: row.bankChangeClearedAt },
      data: { bankChangeClearedAt: at },
    });
    if (res.count !== 1) return false;
    // creator_payout_events is keyed by payout; a bank change belongs to the ACCOUNT, so the account's
    // id goes in payout_id (a plain id, no foreign key). The note carries no figures on purpose:
    // the payout scrubber would mask any run of five digits, dates included.
    await tx.creatorPayoutEvent.create({
      data: {
        payoutId: row.id,
        kind: "bank_change_cleared",
        actorType: "staff",
        actorId: staffId,
        note: scrubPayoutSecrets("Staff marked the bank change request processed. Releases for this creator stay paused for 72 hours."),
      },
    });
    return true;
  });
  if (!won) throw none();

  // The change stands even when the email cannot be sent; the screen says so instead of claiming delivery.
  let emailSent = false;
  try {
    const mail = bankChangeProcessedEmail(creator.name);
    emailSent = (await sendCreatorEmail(creator.email, mail.subject, mail.title, mail.body)) != null;
  } catch (e) {
    console.warn(`[creator-admin] bank change email failed for ${creatorId}: ${scrubPayoutSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  if (!emailSent) console.warn(`[creator-admin] bank change email for ${creatorId} was not sent`);

  return { ...(await getCreatorDetail(creatorId)), emailSent };
}

// ── Review transitions ────────────────────────────────────────────────────────

type ReviewAction = "approve" | "reject" | "suspend" | "reinstate";

const TRANSITIONS: Record<ReviewAction, { from: string[]; to: string }> = {
  approve: { from: ["in_review"], to: "approved" },
  reject: { from: ["in_review"], to: "rejected" },
  suspend: { from: ["approved"], to: "suspended" },
  reinstate: { from: ["suspended"], to: "approved" },
};

const STATE_HINT: Record<ReviewAction, string> = {
  approve: "Only a creator in review can be approved.",
  reject: "Only a creator in review can be rejected.",
  suspend: "Only an approved creator can be suspended.",
  reinstate: "Only a suspended creator can be reinstated.",
};

function noteBlock(note: string | null | undefined, label: string) {
  if (!note) return "";
  return `<p style="margin:16px 0 4px;font-weight:700">${esc(label)}</p><p style="margin:0;white-space:pre-wrap;background:#f4f4f6;padding:12px 14px">${esc(note)}</p>`;
}

function reviewEmail(action: ReviewAction, name: string, note: string | null) {
  const hi = `<p style="margin:0 0 12px">Hi ${esc(name)},</p>`;
  const contact = `<p style="margin:16px 0 0">Questions? Reply to this email or write to creators@digitalsukoon.com.</p>`;
  switch (action) {
    case "approve":
      return {
        subject: "You're approved as a Digital Sukoon creator",
        title: "You're approved",
        body: `${hi}<p style="margin:0 0 12px">Good news — our team reviewed your pages and approved your creator account.</p>${noteBlock(note, "A note from our team")}<p style="margin:18px 0">${button(creatorLink("/dashboard"), "Open your dashboard")}</p>`,
      };
    case "reject":
      return {
        subject: "About your Digital Sukoon creator application",
        title: "Your application was not approved",
        body: `${hi}<p style="margin:0 0 12px">Thank you for applying. Our team reviewed your account and could not approve it this time.</p>${noteBlock(note, "Why")}<p style="margin:16px 0 0">You can fix what the note mentions and submit again from your dashboard.</p><p style="margin:18px 0">${button(creatorLink("/dashboard"), "Open your dashboard")}</p>${contact}`,
      };
    case "suspend":
      return {
        subject: "Your Digital Sukoon creator account is suspended",
        title: "Your account is suspended",
        body: `${hi}<p style="margin:0 0 12px">Our team has suspended your creator account. Your pages are no longer offered while it is suspended. You can still sign in and see your account.</p>${noteBlock(note, "Why")}${contact}`,
      };
    case "reinstate":
      return {
        subject: "Your Digital Sukoon creator account is active again",
        title: "Your account is active again",
        body: `${hi}<p style="margin:0 0 12px">Our team has lifted the suspension on your creator account.</p>${noteBlock(note, "A note from our team")}<p style="margin:16px 0 0">Your pages stay switched off until our team turns them on again.</p><p style="margin:18px 0">${button(creatorLink("/dashboard"), "Open your dashboard")}</p>`,
      };
  }
}

export async function reviewCreator(id: string, action: ReviewAction, staffId: string, note?: string | null) {
  const { from, to } = TRANSITIONS[action];
  const now = new Date();
  const reviewNote = note?.trim() || null;

  const count = await prisma.$transaction(async (tx) => {
    const res = await tx.creator.updateMany({
      where: { id, status: { in: from } },
      data: { status: to, reviewNote, reviewedById: staffId, reviewedAt: now },
    });
    // A suspended creator's pages stop being offered at once; reinstating does NOT turn them
    // back on (staff re-enable each page deliberately).
    if (res.count === 1 && action === "suspend") {
      await tx.creatorAsset.updateMany({
        where: { creatorId: id, enabled: true },
        data: { enabled: false, enabledById: null, enabledAt: null },
      });
    }
    return res.count;
  });

  if (count === 0) {
    const exists = await prisma.creator.findUnique({ where: { id }, select: { status: true } });
    if (!exists) throw new AppError(404, "NOT_FOUND", "Creator not found");
    throw new AppError(409, "INVALID_STATE", `${STATE_HINT[action]} This creator is ${exists.status.replace("_", " ")}.`);
  }

  const c = await prisma.creator.findUnique({ where: { id }, select: { email: true, name: true } });
  let emailSent = false;
  if (c) {
    const mail = reviewEmail(action, c.name, reviewNote);
    // The status change stands even when the email cannot be sent (no SMTP, Gmail refusing).
    // sendEmail answers null for both; the staff screen says so instead of claiming delivery.
    try {
      emailSent = (await sendCreatorEmail(c.email, mail.subject, mail.title, mail.body)) != null;
    } catch (e) {
      console.warn(`[creator-admin] ${action} email failed for ${id}: ${scrubSecrets(e instanceof Error ? e.message : String(e))}`);
    }
    if (!emailSent) console.warn(`[creator-admin] ${action} email for ${id} was not sent`);
  }

  return { ...(await getCreatorDetail(id)), emailSent };
}

// ── Page (asset) switch ───────────────────────────────────────────────────────

type BlockReason = "creator_not_approved" | "disconnected" | "connection_not_live" | "network_duplicate" | "cannot_publish";

const BLOCK_MESSAGE: Record<BlockReason, string> = {
  creator_not_approved: "The creator must be approved before their pages can be turned on.",
  disconnected: "This page is disconnected — the creator must reconnect it first.",
  connection_not_live: "The creator's Facebook connection has lapsed — they must reconnect it first.",
  network_duplicate: "This page is already on our network, so it can't be offered as a creator page.",
  cannot_publish: "We can't publish to this page through the API yet (see the probe error).",
};

type AssetGate = Pick<CreatorAsset, "disconnectedAt" | "networkDuplicateOf" | "canPublish"> & {
  creator: { status: string };
  connection: { status: string; revokedAt: Date | null };
};
const GATE_SELECT = {
  disconnectedAt: true,
  networkDuplicateOf: true,
  canPublish: true,
  creator: { select: { status: true } },
  connection: { select: { status: true, revokedAt: true } },
} as const;

function blockReason(a: AssetGate): BlockReason | null {
  if (a.creator.status !== "approved") return "creator_not_approved";
  if (a.disconnectedAt) return "disconnected";
  if (a.connection.revokedAt || !(LIVE_CONNECTION_STATUSES as readonly string[]).includes(a.connection.status)) {
    return "connection_not_live";
  }
  if (a.networkDuplicateOf) return "network_duplicate";
  if (!a.canPublish) return "cannot_publish";
  return null;
}

function notEnableable(reason: BlockReason): never {
  throw new AppError(409, "NOT_ENABLEABLE", BLOCK_MESSAGE[reason], [{ field: "reason", message: reason }]);
}

export async function setAssetEnabled(creatorId: string, assetId: string, enabled: boolean, staffId: string) {
  const exists = await prisma.creatorAsset.findFirst({ where: { id: assetId, creatorId }, select: { id: true } });
  if (!exists) throw new AppError(404, "NOT_FOUND", "Page not found");

  if (enabled) {
    // The stored duplicate flag is only as fresh as the creator's last discovery: re-check it
    // against our network NOW, so a page staff connected since can never be switched on here.
    await syncNetworkDuplicates([assetId]);
    const asset = await prisma.creatorAsset.findFirst({ where: { id: assetId, creatorId }, select: GATE_SELECT });
    if (!asset) throw new AppError(404, "NOT_FOUND", "Page not found");
    const reason = blockReason(asset);
    if (reason) notEnableable(reason);
    // Re-assert every condition in the write itself: a suspend, a disconnect or a re-discovery
    // that lands between the read above and this write must win.
    const res = await prisma.creatorAsset.updateMany({
      where: {
        id: assetId,
        creatorId,
        canPublish: true,
        networkDuplicateOf: null,
        disconnectedAt: null,
        creator: { status: "approved" },
        connection: liveConnectionWhere,
      },
      data: { enabled: true, enabledById: staffId, enabledAt: new Date() },
    });
    if (res.count === 0) {
      const now = await prisma.creatorAsset.findFirst({ where: { id: assetId, creatorId }, select: GATE_SELECT });
      if (!now) throw new AppError(404, "NOT_FOUND", "Page not found");
      notEnableable(blockReason(now) ?? "cannot_publish");
    }
  } else {
    await prisma.creatorAsset.updateMany({
      where: { id: assetId, creatorId },
      data: { enabled: false, enabledById: null, enabledAt: null },
    });
  }

  const row = await prisma.creatorAsset.findUnique({ where: { id: assetId } });
  if (!row) throw new AppError(404, "NOT_FOUND", "Page not found");
  return (await toAdminAssetViews([row]))[0];
}
