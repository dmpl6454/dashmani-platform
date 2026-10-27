import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import crypto from "crypto";
import { AppError } from "../middleware/error-handler";
import { likeLiteral } from "../utils/like-literal";

// Team logins on the client portal: further people who sign in as the same client company.
//
// The clients row is the company AND its owner's login (its email/password); every other person
// is a client_users row. A member's session carries the company's id as its subject, so every
// existing client-scoped query works unchanged, plus `memberId` + `sv` (session version):
// authenticateClient re-checks both on every request, so disabling or removing a login ends its
// access at once instead of when its 15-minute token runs out.
//
// ⚠️ Rules:
//  • One email, one login, platform-wide: a member's email is never any clients.email, and a
//    clients.email is never a member's (checked both ways, case-insensitively, in emailInUse).
//  • Only the owner (or sales staff) manages the team; a member sees the list.
//  • The invite / reset link carries a random token; only its sha256 is stored. Links are one-time
//    (cleared on use) and expire (invite 7 days, reset 24 hours).

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const RESET_TTL_MS = 24 * 3600_000;
export const TEAM_MAX = 20;

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const newLinkToken = () => crypto.randomBytes(32).toString("hex");

/** True when the address already signs in somewhere on the client portal (owner or member). */
export async function emailInUse(email: string, exceptMemberId?: string): Promise<boolean> {
  const e = likeLiteral(email.trim().toLowerCase());
  const [owner, member] = await Promise.all([
    prisma.client.findFirst({ where: { email: { equals: e, mode: "insensitive" } }, select: { id: true } }),
    prisma.clientUser.findFirst({
      where: { email: { equals: e, mode: "insensitive" }, ...(exceptMemberId ? { id: { not: exceptMemberId } } : {}) },
      select: { id: true },
    }),
  ]);
  return Boolean(owner || member);
}

const memberSelect = {
  id: true, email: true, name: true, status: true, invitedBy: true, lastLoginAt: true, createdAt: true, tokenPurpose: true, tokenExpiresAt: true,
} as const;

function shapeMember(m: { id: string; email: string; name: string; status: string; invitedBy: string | null; lastLoginAt: Date | null; createdAt: Date; tokenPurpose: string | null; tokenExpiresAt: Date | null }) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    role: "member" as const,
    status: m.status,
    invitedBy: m.invitedBy,
    lastLoginAt: m.lastLoginAt,
    createdAt: m.createdAt,
    inviteExpiresAt: m.status === "invited" && m.tokenPurpose === "invite" ? m.tokenExpiresAt : null,
  };
}

/** The company's logins: the owner first, then members by when they were added. */
export async function listTeam(clientId: string) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, companyName: true, contactName: true, email: true, status: true, createdAt: true, users: { select: memberSelect, orderBy: { createdAt: "asc" } } },
  });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  return {
    companyName: client.companyName,
    owner: { name: client.contactName, email: client.email, role: "owner" as const, status: client.status === "ACTIVE" ? "active" : "disabled", createdAt: client.createdAt },
    members: client.users.map(shapeMember),
    max: TEAM_MAX,
  };
}

function portalUrl() {
  return (process.env.CLIENT_APP_URL || "https://client.digitalsukoon.com").replace(/\/+$/, "");
}

async function sendInviteEmail(member: { email: string; name: string }, companyName: string, inviter: string, token: string) {
  const link = `${portalUrl()}/join?token=${token}`;
  const { sendEmail } = await import("./email.service");
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  // sendEmail answers null (never throws) when SMTP is off or the send failed.
  const sent = await sendEmail({
    to: member.email,
    subject: `You're invited to ${companyName} on Digital Sukoon`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px">Join ${esc(companyName)} on Digital Sukoon</h2>
        <p style="color:#555">Hi ${esc(member.name)},</p>
        <p style="color:#555">${esc(inviter)} added you to <strong>${esc(companyName)}</strong>'s client portal, where you can start and follow campaigns, approvals and invoices.</p>
        <a href="${link}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#403cfa;color:#fff;text-decoration:none;font-weight:600">Set your password</a>
        <p style="color:#999;font-size:12px">This link works once and expires in 7 days. Didn't see this in your inbox? Check your spam folder.</p>
      </div>
    `,
  });
  return { link, emailed: sent != null };
}

/** The invite link always comes back (to pass on by hand); `emailed` says whether the email went. */
async function sendInvite(member: { email: string; name: string }, companyName: string, inviter: string, token: string) {
  try {
    return await sendInviteEmail(member, companyName, inviter, token);
  } catch (e) {
    console.error("[client-team] invite email failed", e);
    return { link: `${portalUrl()}/join?token=${token}`, emailed: false };
  }
}

/**
 * Add a login to a company. Sends the invite email and returns the link too, so whoever added
 * the person can pass it on if the email does not arrive.
 */
export async function inviteMember(clientId: string, input: { email: string; name: string }, inviter: string) {
  const email = input.email.trim().toLowerCase();
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, companyName: true, status: true, _count: { select: { users: true } } } });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  if (client.status !== "ACTIVE") throw new AppError(409, "CLIENT_INACTIVE", "This account is not active.");
  if (client._count.users >= TEAM_MAX) throw new AppError(409, "TEAM_FULL", `A company can have up to ${TEAM_MAX} extra logins.`);
  if (await emailInUse(email)) {
    throw new AppError(409, "EMAIL_EXISTS", "This email already signs in to the client portal. Use another address, or ask us to move it.");
  }
  const token = newLinkToken();
  let member;
  try {
    member = await prisma.clientUser.create({
      data: {
        clientId,
        email,
        name: input.name,
        status: "invited",
        tokenHash: sha256(token),
        tokenPurpose: "invite",
        tokenExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedBy: inviter.slice(0, 200),
      },
      select: memberSelect,
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw new AppError(409, "EMAIL_EXISTS", "This email already signs in to the client portal.");
    throw err;
  }
  const mail = await sendInvite(member, client.companyName, inviter, token);
  return { member: shapeMember(member), inviteUrl: mail.link, emailed: mail.emailed };
}

async function requireMember(clientId: string, memberId: string) {
  const m = await prisma.clientUser.findFirst({ where: { id: memberId, clientId } });
  if (!m) throw new AppError(404, "NOT_FOUND", "That login is not on this account.");
  return m;
}

/** A fresh invite link (the old one stops working). Only for logins that have not joined yet. */
export async function resendInvite(clientId: string, memberId: string, inviter: string) {
  const m = await requireMember(clientId, memberId);
  if (m.status !== "invited") throw new AppError(409, "ALREADY_JOINED", "This person has already set a password. They can use “Forgot password” if needed.");
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { companyName: true } });
  const token = newLinkToken();
  const updated = await prisma.clientUser.update({
    where: { id: m.id },
    data: { tokenHash: sha256(token), tokenPurpose: "invite", tokenExpiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    select: memberSelect,
  });
  const mail = await sendInvite(updated, client.companyName, inviter, token);
  return { member: shapeMember(updated), inviteUrl: mail.link, emailed: mail.emailed };
}

/** Switch a login off: every session ends now (sessionVersion moves on, refresh tokens deleted). */
export async function disableMember(clientId: string, memberId: string) {
  const m = await requireMember(clientId, memberId);
  const [updated] = await prisma.$transaction([
    prisma.clientUser.update({
      where: { id: m.id },
      data: { status: "disabled", sessionVersion: { increment: 1 }, tokenHash: null, tokenPurpose: null, tokenExpiresAt: null },
      select: memberSelect,
    }),
    prisma.clientRefreshToken.deleteMany({ where: { clientUserId: m.id } }),
  ]);
  return shapeMember(updated);
}

/** Switch a login back on. One that never set a password goes back to "invited" (send the invite again). */
export async function enableMember(clientId: string, memberId: string) {
  const m = await requireMember(clientId, memberId);
  if (m.status !== "disabled") return shapeMember(m);
  const updated = await prisma.clientUser.update({
    where: { id: m.id },
    data: { status: m.passwordHash ? "active" : "invited" },
    select: memberSelect,
  });
  return shapeMember(updated);
}

/** Remove a login for good (its sessions go with it: refresh tokens cascade). */
export async function removeMember(clientId: string, memberId: string) {
  const m = await requireMember(clientId, memberId);
  await prisma.clientUser.delete({ where: { id: m.id } });
  return { id: m.id };
}

async function findInvite(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError(400, "INVALID_TOKEN", "This invite link is not valid.");
  const m = await prisma.clientUser.findUnique({ where: { tokenHash: sha256(token) }, include: { client: { select: { companyName: true, status: true } } } });
  if (!m || m.tokenPurpose !== "invite" || m.status !== "invited") throw new AppError(400, "INVALID_TOKEN", "This invite link has already been used or was replaced. Ask for a new one.");
  if (!m.tokenExpiresAt || m.tokenExpiresAt < new Date()) throw new AppError(400, "TOKEN_EXPIRED", "This invite link has expired. Ask for a new one.");
  if (m.client.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "This company's account is not active.");
  return m;
}

/** What the join page shows before the person sets a password. */
export async function describeInvite(token: string) {
  const m = await findInvite(token);
  return { email: m.email, name: m.name, companyName: m.client.companyName };
}

/**
 * Accept an invite: set the password, mark the login active and consume the link. The token is
 * matched and cleared in ONE conditional update, so two tabs submitting the same link cannot both
 * succeed. Returns the member row for the caller to issue a session.
 */
export async function acceptMemberInvite(input: { token: string; password: string; name?: string }) {
  const invite = await findInvite(input.token);
  const passwordHash = await hash(input.password, 12);
  const res = await prisma.clientUser.updateMany({
    where: { id: invite.id, tokenHash: sha256(input.token), tokenPurpose: "invite", status: "invited", tokenExpiresAt: { gt: new Date() } },
    data: { passwordHash, status: "active", tokenHash: null, tokenPurpose: null, tokenExpiresAt: null, ...(input.name ? { name: input.name } : {}) },
  });
  if (res.count !== 1) throw new AppError(400, "INVALID_TOKEN", "This invite link has already been used. Sign in instead.");
  return prisma.clientUser.findUniqueOrThrow({ where: { id: invite.id }, include: { client: true } });
}
