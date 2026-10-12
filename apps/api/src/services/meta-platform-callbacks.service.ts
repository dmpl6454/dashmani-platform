/**
 * Meta's app-wide platform callbacks: Deauthorize and Data Deletion.
 *
 * They arrive for ANYONE who removes our app on Facebook — creators, staff grantors (the admin
 * Account Growth connection) and people who never used either — so every call is matched against
 * both, and logged in meta_deletion_requests with only a SHA-256 of the app-scoped user id.
 *
 *  • Deauthorize → a creator's connection loses its token (REVOKED) and its pages are
 *    disconnected and switched off. A staff grant goes to NEEDS_REAUTH and staff are alerted —
 *    deleting it would silently blank the channel monitor.
 *  • Data deletion → a creator's Meta-sourced data (connection + pages) is DELETED; the creator
 *    account itself stays (it is ours, not Meta's). A staff grant is flagged for a human, never
 *    auto-deleted. Unknown users still get a confirmation code: Meta requires one, and answering
 *    differently would tell a caller whether an id is known to us.
 */

import { createHash, randomInt } from "crypto";
import { prisma } from "@dashmani/db";
import { creatorConfig } from "./creator/creator-config";
import { adminAlert } from "./creator/creator-email";

/** Unambiguous upper-case alphabet (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;

export const userHash = (metaUserId: string) => createHash("sha256").update(metaUserId).digest("hex");

function newCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export const isPlausibleCode = (code: string) => /^[A-Z0-9]{6,16}$/.test(code);

async function logRequest(data: { kind: "deauthorize" | "deletion"; userHash: string; matched: string; status: string; note?: string | null; completed: boolean }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const confirmationCode = newCode();
    try {
      await prisma.metaDeletionRequest.create({
        data: {
          confirmationCode,
          userHash: data.userHash,
          kind: data.kind,
          matched: data.matched,
          status: data.status,
          note: data.note ? data.note.slice(0, 500) : null,
          completedAt: data.completed ? new Date() : null,
        },
      });
      return confirmationCode;
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
    }
  }
  throw new Error("could not allocate a unique confirmation code");
}

async function flagStaffGrant(metaUserId: string, why: "deauthorize" | "deletion"): Promise<boolean> {
  const staff = await prisma.metaConnection.findMany({ where: { metaUserId, revokedAt: null }, select: { id: true, metaUserName: true } });
  if (staff.length === 0) return false;
  await prisma.metaConnection.updateMany({
    where: { id: { in: staff.map((s) => s.id) } },
    data: {
      status: "NEEDS_REAUTH",
      lastError:
        why === "deauthorize"
          ? "This person removed our app on Facebook — reconnect to resume."
          : "This person asked Meta to delete their data from our app — review and reconnect or remove.",
    },
  });
  void adminAlert(
    why === "deauthorize" ? "A staff Meta connection was removed on Facebook" : "Meta data-deletion request for a staff Meta connection",
    [
      { label: "Connection", value: staff.map((s) => s.metaUserName ?? s.id).join(", ") },
      {
        label: "What to do",
        value:
          why === "deauthorize"
            ? "Account Growth stops updating for this grant until someone reconnects."
            : "Nothing was deleted automatically. Remove the connection under Account Growth if the data must go.",
      },
    ],
    "/accounts/growth",
  ).catch(() => undefined);
  return true;
}

export async function handleDeauthorize(metaUserId: string): Promise<void> {
  const now = new Date();
  const conns = await prisma.creatorConnection.findMany({ where: { metaUserId }, select: { id: true } });
  const ids = conns.map((c) => c.id);
  if (ids.length > 0) {
    await prisma.creatorConnection.updateMany({
      where: { id: { in: ids } },
      data: { userTokenEnc: null, status: "REVOKED", revokedAt: now, lastError: "You removed our app on Facebook — reconnect to continue." },
    });
    await prisma.creatorAsset.updateMany({
      where: { connectionId: { in: ids } },
      data: { pageTokenEnc: null, enabled: false, disconnectedAt: now },
    });
  }
  const staff = await flagStaffGrant(metaUserId, "deauthorize");
  const matched = ids.length > 0 ? "creator" : staff ? "staff_grant" : "none";
  await logRequest({
    kind: "deauthorize",
    userHash: userHash(metaUserId),
    matched,
    status: matched === "none" ? "no_data" : "completed",
    note: ids.length > 0 && staff ? "also a staff Meta connection (flagged NEEDS_REAUTH)" : null,
    completed: true,
  });
}

export async function handleDataDeletion(metaUserId: string): Promise<{ url: string; confirmation_code: string }> {
  const conns = await prisma.creatorConnection.findMany({ where: { metaUserId }, select: { id: true } });
  const ids = conns.map((c) => c.id);
  if (ids.length > 0) {
    // Pages first (explicit; the FK would cascade anyway), then the grant itself.
    await prisma.creatorAsset.deleteMany({ where: { connectionId: { in: ids } } });
    await prisma.creatorConnection.deleteMany({ where: { id: { in: ids } } });
  }
  const staff = await flagStaffGrant(metaUserId, "deletion");
  const matched = ids.length > 0 ? "creator" : staff ? "staff_grant" : "none";
  // A staff grant needs a human decision, so it stays "received" until someone acts.
  const status = matched === "none" ? "no_data" : staff ? "received" : "completed";
  const code = await logRequest({
    kind: "deletion",
    userHash: userHash(metaUserId),
    matched,
    status,
    note: ids.length > 0 && staff ? "creator data deleted; staff Meta connection flagged for review" : null,
    completed: status !== "received",
  });
  return { url: `${creatorConfig.appUrl()}/data-deletion?code=${code}`, confirmation_code: code };
}

/** Public status lookup — the code, the state and two timestamps; nothing that identifies anyone. */
export async function getDeletionStatus(code: string) {
  if (!isPlausibleCode(code)) return null;
  const row = await prisma.metaDeletionRequest.findUnique({
    where: { confirmationCode: code },
    select: { confirmationCode: true, kind: true, status: true, receivedAt: true, completedAt: true },
  });
  if (!row || row.kind !== "deletion") return null;
  return {
    code: row.confirmationCode,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
