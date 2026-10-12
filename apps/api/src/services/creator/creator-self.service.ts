import { prisma } from "@dashmani/db";
import { compare, hash } from "bcrypt";
import { AppError } from "../../middleware/error-handler";
import { scrubSecrets } from "../../utils/token-crypto";
import { liveConnectionWhere, toCreatorMe } from "./creator-view";
import { adminAlert } from "./creator-email";
import { issueCreatorSession } from "./creator-auth.service";

// A signed-in creator's own account: profile, password, "submit for review", close account.
// Every response goes through toCreatorMe (creator-view.ts) — never a raw row.

/** Statuses from which a creator may (re)submit for review. */
const SUBMITTABLE = ["draft", "rejected"];

/**
 * The `isPublishable` rule (creator-view.ts) as a Prisma filter, PLUS a live connection: a page
 * whose Facebook login has lapsed (NEEDS_REAUTH) or was revoked cannot be submitted.
 */
const publishableWhere = (creatorId: string) => ({
  creatorId,
  canPublish: true,
  networkDuplicateOf: null,
  disconnectedAt: null,
  connection: liveConnectionWhere,
});

async function loadCreator(id: string) {
  const c = await prisma.creator.findUnique({ where: { id } });
  if (!c || c.status === "closed") throw new AppError(401, "ACCOUNT_CLOSED", "This account is closed.");
  return c;
}

/** CreatorMe plus the onboarding checklist the creators app renders. */
export async function getCreatorMe(creatorId: string) {
  const c = await loadCreator(creatorId);
  const [connections, publishablePages] = await Promise.all([
    prisma.creatorConnection.count({ where: { creatorId, revokedAt: null, status: { not: "REVOKED" } } }),
    prisma.creatorAsset.count({ where: publishableWhere(creatorId) }),
  ]);
  return {
    ...toCreatorMe(c),
    checklist: {
      emailVerified: c.emailVerifiedAt != null,
      connected: connections > 0,
      publishablePages,
      // "Submitted" means waiting on, or past, our review — a rejected creator must resubmit.
      submitted: c.status === "in_review" || c.status === "approved" || c.status === "suspended",
    },
  };
}

/**
 * Update the profile. Only fields present change; `clear` lists optional fields the creator
 * emptied (the shared schema maps "" to undefined, so the route detects clears separately).
 */
export async function updateCreatorMe(
  creatorId: string,
  data: { name?: string; country?: string; phone?: string },
  clear: { country?: boolean; phone?: boolean } = {},
) {
  await loadCreator(creatorId);
  const c = await prisma.creator.update({
    where: { id: creatorId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.country !== undefined ? { country: data.country } : clear.country ? { country: null } : {}),
      // The schema lets an emptied phone through as "" (country arrives as undefined instead).
      ...(data.phone !== undefined ? { phone: data.phone || null } : clear.phone ? { phone: null } : {}),
    },
  });
  return toCreatorMe(c);
}

/**
 * Change the password. Every existing session elsewhere ends (all refresh tokens are deleted);
 * this device gets a fresh session in the response so it is not signed out an hour later.
 */
export async function changeCreatorPassword(creatorId: string, currentPassword: string, newPassword: string) {
  const c = await loadCreator(creatorId);
  if (!(await compare(currentPassword, c.passwordHash))) {
    throw new AppError(400, "WRONG_PASSWORD", "Your current password is not right.");
  }
  const passwordHash = await hash(newPassword, 12);
  const [updated] = await prisma.$transaction([
    prisma.creator.update({ where: { id: creatorId }, data: { passwordHash } }),
    prisma.creatorRefreshToken.deleteMany({ where: { creatorId } }),
  ]);
  const session = await issueCreatorSession(updated);
  return { changed: true as const, accessToken: session.accessToken, refreshToken: session.refreshToken };
}

/**
 * Submit for review: draft | rejected → in_review. Needs a verified email and at least one
 * publishable page (our probe can publish there, it is not already on our network, and it is
 * still connected). The transition is a conditional updateMany, so a double click or two tabs
 * move it once; the loser gets INVALID_STATE.
 */
export async function submitCreatorForReview(creatorId: string) {
  const c = await loadCreator(creatorId);
  if (!SUBMITTABLE.includes(c.status)) {
    throw new AppError(409, "INVALID_STATE", c.status === "in_review" ? "Your account is already in review." : "Your account cannot be submitted right now.");
  }
  if (!c.emailVerifiedAt) {
    throw new AppError(409, "EMAIL_NOT_VERIFIED", "Confirm your email address first — we sent you a link.");
  }
  const publishable = await prisma.creatorAsset.count({ where: publishableWhere(creatorId) });
  if (publishable === 0) {
    throw new AppError(409, "NO_PUBLISHABLE_PAGE", "Connect at least one Facebook Page or Instagram account we can publish to.");
  }

  const moved = await prisma.creator.updateMany({
    where: { id: creatorId, status: { in: SUBMITTABLE } },
    data: { status: "in_review", submittedAt: new Date() },
  });
  if (moved.count === 0) throw new AppError(409, "INVALID_STATE", "Your account is already in review.");

  const after = await prisma.creator.findUniqueOrThrow({ where: { id: creatorId } });
  void adminAlert(
    "Creator submitted for review",
    [
      { label: "Name", value: after.name },
      { label: "Email", value: after.email },
      ...(after.country ? [{ label: "Country", value: after.country }] : []),
      { label: "Publishable pages", value: String(publishable) },
      ...(c.status === "rejected" ? [{ label: "Note", value: "Resubmitted after a rejection" }] : []),
    ],
    `/creators/${after.id}`,
  ).catch((e) => console.error("[creator-self] admin alert failed:", scrubSecrets(String(e?.message ?? e))));
  return toCreatorMe(after);
}

/**
 * Close the account. Everything that lets us act for the creator stops at once, LOCALLY:
 * connections become REVOKED with their user tokens nulled, every page is disconnected and
 * switched off with its page token nulled, and every session and pending emailed link ends.
 * ⚠️ We never call Meta's DELETE /{user}/permissions here — the creator removes the app in
 * their Facebook settings; Meta's deauthorize callback handles that side.
 * The row stays (status "closed"), so the email cannot sign up again without staff help.
 */
export async function closeCreatorAccount(creatorId: string) {
  await loadCreator(creatorId);
  const now = new Date();
  await prisma.$transaction([
    prisma.creator.update({ where: { id: creatorId }, data: { status: "closed", closedAt: now } }),
    prisma.creatorConnection.updateMany({
      where: { creatorId, revokedAt: null },
      data: { status: "REVOKED", userTokenEnc: null, revokedAt: now },
    }),
    // Rows revoked earlier keep their revokedAt; their tokens are nulled all the same.
    prisma.creatorConnection.updateMany({ where: { creatorId }, data: { status: "REVOKED", userTokenEnc: null } }),
    prisma.creatorAsset.updateMany({
      where: { creatorId, disconnectedAt: null },
      data: { disconnectedAt: now },
    }),
    prisma.creatorAsset.updateMany({ where: { creatorId }, data: { enabled: false, pageTokenEnc: null } }),
    prisma.creatorRefreshToken.deleteMany({ where: { creatorId } }),
    prisma.creatorToken.updateMany({ where: { creatorId, usedAt: null }, data: { usedAt: now } }),
    prisma.creatorOauthState.deleteMany({ where: { creatorId } }),
  ]);
  return { closed: true as const };
}
