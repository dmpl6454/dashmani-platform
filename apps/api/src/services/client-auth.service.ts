import { prisma } from "@dashmani/db";
import { compare, hash } from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { AppError } from "../middleware/error-handler";
import { likeLiteral } from "../utils/like-literal";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

export async function clientLogin(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const client = await prisma.client.findUnique({ where: { email: normalized } });
  if (!client) return memberLogin(normalized, password);
  if (client.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");

  const valid = await compare(password, client.passwordHash);
  if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");

  return issueClientSession(client);
}

/** A team login (client_users). Same answers as the owner path, so neither reveals which exists. */
async function memberLogin(email: string, password: string) {
  const member = await prisma.clientUser.findUnique({ where: { email }, include: { client: true } });
  if (!member || !member.passwordHash) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  const valid = await compare(password, member.passwordHash);
  if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  if (member.status !== "active" || member.client.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");
  return issueClientSession(member.client, member);
}

export async function clientRefresh(refreshToken: string) {
  const decoded = jwt.verify(refreshToken, JWT_SECRET) as { userId: string; memberId?: string; sv?: number };
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");

  const stored = await prisma.clientRefreshToken.findUnique({ where: { token: tokenHash } });
  if (!stored || stored.expiresAt < new Date()) {
    throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");
  }

  const client = await prisma.client.findUnique({ where: { id: decoded.userId } });
  if (!client || client.status !== "ACTIVE") {
    throw new AppError(401, "INVALID_TOKEN", "Client not found or inactive");
  }
  // A team login's session ends when the login is disabled, removed or its password reset.
  let member: { id: string; email: string; name: string; sessionVersion: number } | null = null;
  if (decoded.memberId) {
    member = await prisma.clientUser.findFirst({
      where: { id: decoded.memberId, clientId: client.id, status: "active", sessionVersion: decoded.sv ?? 0 },
      select: { id: true, email: true, name: true, sessionVersion: true },
    });
    if (!member || stored.clientUserId !== member.id) throw new AppError(401, "INVALID_TOKEN", "This login is no longer active");
  } else if (stored.clientUserId) {
    throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");
  }

  // Rotate token — race-safe one-time consume (see hr-auth.service.ts refreshHrToken):
  // a bare delete() 500s the loser of two concurrent refreshes with the same token
  // (P2025); deleteMany + count check turns that into the standard clean 401.
  const consumed = await prisma.clientRefreshToken.deleteMany({ where: { id: stored.id } });
  if (consumed.count === 0) {
    throw new AppError(401, "INVALID_TOKEN", "Refresh token already used");
  }

  const { accessToken, refreshToken: newRefreshToken } = await issueClientSession(client, member);
  return { accessToken, refreshToken: newRefreshToken };
}

/** Ends the sessions of the person signing out only — never their colleagues'. */
export async function clientLogout(clientId: string, memberId?: string) {
  await prisma.clientRefreshToken.deleteMany({ where: { clientId, clientUserId: memberId ?? null } });
}

export async function clientForgotPassword(email: string) {
  const normalized = email.trim().toLowerCase();
  const client = await prisma.client.findUnique({ where: { email: normalized } });
  if (!client) return memberForgotPassword(normalized); // silent either way — don't reveal whether email exists

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await prisma.otpToken.deleteMany({
    where: { clientId: client.id, channel: "EMAIL", target: "PASSWORD_RESET" },
  });
  await prisma.otpToken.create({
    data: { clientId: client.id, otp: token, channel: "EMAIL", target: "PASSWORD_RESET", expiresAt },
  });

  const portalUrl = process.env.CLIENT_APP_URL || "https://client.digitalsukoon.com";
  const resetLink = `${portalUrl}/reset-password?token=${token}`;

  // Lazy import to avoid circular deps; reuse the shared email transport.
  const { sendEmail } = await import("./email.service");
  await sendEmail({
    to: client.email,
    subject: "Reset your password — Digital Sukoon Client Portal",
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px">Reset your password</h2>
        <p style="color:#555">Hi ${client.contactName},</p>
        <p style="color:#555">Click the button below to reset your client-portal password. This link expires in 24 hours.</p>
        <a href="${resetLink}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#1A1A1A;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
        <p style="color:#999;font-size:12px">Didn't see this in your inbox? <strong>Check your spam or junk folder</strong>.</p>
        <p style="color:#999;font-size:12px">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

/** A team login's reset link: stored as a hash on the login itself (otp_tokens is keyed on clients). */
async function memberForgotPassword(email: string) {
  const member = await prisma.clientUser.findUnique({ where: { email }, include: { client: { select: { status: true } } } });
  if (!member || member.status !== "active" || member.client.status !== "ACTIVE") return;
  const { newLinkToken, sha256, RESET_TTL_MS } = await import("./client-team.service");
  const token = newLinkToken();
  await prisma.clientUser.update({
    where: { id: member.id },
    data: { tokenHash: sha256(token), tokenPurpose: "reset", tokenExpiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });
  const portalUrl = process.env.CLIENT_APP_URL || "https://client.digitalsukoon.com";
  const { sendEmail } = await import("./email.service");
  await sendEmail({
    to: member.email,
    subject: "Reset your password — Digital Sukoon Client Portal",
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px">Reset your password</h2>
        <p style="color:#555">Click the button below to reset your client-portal password. This link expires in 24 hours.</p>
        <a href="${portalUrl}/reset-password?token=${token}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#1A1A1A;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
        <p style="color:#999;font-size:12px">Didn't see this in your inbox? <strong>Check your spam or junk folder</strong>.</p>
        <p style="color:#999;font-size:12px">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

/** Reset a team login's password from its emailed link. Ends every session of that login. */
async function memberResetPassword(token: string, newPassword: string): Promise<boolean> {
  const { sha256 } = await import("./client-team.service");
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const passwordHash = await hash(newPassword, 12);
  const member = await prisma.clientUser.findUnique({ where: { tokenHash: sha256(token) }, select: { id: true } });
  if (!member) return false;
  const res = await prisma.clientUser.updateMany({
    where: { id: member.id, tokenPurpose: "reset", status: "active", tokenExpiresAt: { gt: new Date() } },
    data: { passwordHash, tokenHash: null, tokenPurpose: null, tokenExpiresAt: null, sessionVersion: { increment: 1 } },
  });
  if (res.count !== 1) return false;
  await prisma.clientRefreshToken.deleteMany({ where: { clientUserId: member.id } });
  return true;
}

export async function clientResetPassword(token: string, newPassword: string) {
  const record = await prisma.otpToken.findFirst({
    where: {
      otp: token,
      channel: "EMAIL",
      target: "PASSWORD_RESET",
      verified: false,
      clientId: { not: null },
      expiresAt: { gt: new Date() },
    },
  });

  if (!record || !record.clientId) {
    if (await memberResetPassword(token, newPassword)) return;
    throw new AppError(400, "INVALID_TOKEN", "Reset link is invalid or expired");
  }

  const passwordHash = await hash(newPassword, 12);
  await prisma.client.update({ where: { id: record.clientId }, data: { passwordHash } });
  await prisma.otpToken.update({ where: { id: record.id }, data: { verified: true } });
  // The owner's sessions only: a colleague's login is not affected by the owner's password.
  await prisma.clientRefreshToken.deleteMany({ where: { clientId: record.clientId, clientUserId: null } });
}

export async function createClient(data: {
  companyName: string;
  contactName: string;
  email: string;
  password: string;
  phone?: string;
}) {
  const email = data.email.trim().toLowerCase();
  const existing = await prisma.client.findUnique({ where: { email } });
  if (existing) throw new AppError(409, "EMAIL_EXISTS", "A client with this email already exists");
  if (await memberEmailExists(email)) throw new AppError(409, "EMAIL_EXISTS", "This email is already a team login on another client account");

  const passwordHash = await hash(data.password, 12);
  return prisma.client.create({
    data: {
      companyName: data.companyName,
      contactName: data.contactName,
      email,
      passwordHash,
      phone: data.phone,
    },
    select: { id: true, companyName: true, contactName: true, email: true, phone: true, status: true, createdAt: true },
  });
}

export async function listClients(params: { cursor?: string; limit: number; search?: string; status?: string }) {
  const where: any = {};
  if (params.status) where.status = params.status;
  if (params.search) {
    where.OR = [
      { companyName: { contains: params.search, mode: "insensitive" } },
      { contactName: { contains: params.search, mode: "insensitive" } },
      { email: { contains: params.search, mode: "insensitive" } },
    ];
  }

  const clients = await prisma.client.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    select: {
      id: true, companyName: true, contactName: true, email: true, phone: true,
      status: true, createdAt: true, _count: { select: { projects: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const hasMore = clients.length > params.limit;
  const items = hasMore ? clients.slice(0, params.limit) : clients;

  return {
    items,
    meta: { cursor: items.length > 0 ? items[items.length - 1].id : undefined, has_more: hasMore },
  };
}

export async function getClientById(id: string) {
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true, companyName: true, contactName: true, email: true, phone: true,
      logoUrl: true, status: true, createdAt: true, updatedAt: true,
      projects: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  return client;
}

export async function updateClient(id: string, data: { companyName?: string; contactName?: string; phone?: string | null; status?: string }) {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");

  return prisma.client.update({
    where: { id },
    data: data as any,
    select: {
      id: true, companyName: true, contactName: true, email: true, phone: true,
      status: true, createdAt: true, updatedAt: true,
    },
  });
}

/**
 * Public self-signup (website "Start a campaign" → client portal). Creates an ACTIVE client
 * with instant access, like HR self-registration — the portal only ever shows a client its
 * own data, and a brand-new account has nothing but the campaign booking flow.
 *
 * ⚠️ It can never take over an existing account: any existing client row for the email, in
 * any status and any casing, is a 409 (the lookup is case-insensitive because Postgres's
 * unique index is not). A pending admin invite for the same email is consumed, so the
 * invite link cannot later create a second account.
 */
export async function clientSignup(data: { companyName: string; contactName: string; email: string; password: string; phone?: string }) {
  const email = data.email.trim().toLowerCase();
  const existing = await prisma.client.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
  if (existing || (await memberEmailExists(email))) throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists. Sign in, or use “Forgot password”.");

  const passwordHash = await hash(data.password, 12);
  let client;
  try {
    client = await prisma.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: { companyName: data.companyName, contactName: data.contactName, email, passwordHash, phone: data.phone ?? null, status: "ACTIVE" },
      });
      await tx.clientInvite.updateMany({ where: { email, usedAt: null }, data: { usedAt: new Date() } });
      return created;
    });
  } catch (err: any) {
    // Two signups racing on one email: the unique index decides, the loser gets the same 409.
    if (err?.code === "P2002") throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists. Sign in, or use “Forgot password”.");
    throw err;
  }

  void (async () => {
    const { notifyAdminByEmail } = await import("./email.service");
    await notifyAdminByEmail(
      `New client signed up: ${client.companyName}`,
      [
        { label: "Company", value: client.companyName },
        { label: "Contact", value: client.contactName },
        { label: "Email", value: client.email },
        ...(client.phone ? [{ label: "Phone", value: client.phone }] : []),
      ],
      `/clients/${client.id}`,
    );
  })().catch((e) => console.error("[client-signup] admin email failed", e));

  return issueClientSession(client);
}

/** Two-label public suffixes a Workspace domain commonly ends in ("acme.co.in" → "acme"). */
const MULTI_PART_SUFFIXES = new Set([
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "gov.in",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "co.jp", "co.id", "co.kr",
  "com.sg", "com.my", "com.hk", "com.cn", "com.br", "com.mx", "com.ar", "com.tr",
  "com.pk", "com.bd", "com.np", "com.lk", "com.ng", "com.ph", "com.vn", "com.sa", "com.eg",
]);

// Generic second-level labels many country TLDs register under ("acme.co.ae", "acme.edu.au",
// "acme.com.qa"). Paired with a two-letter country code they are a public suffix even when the
// pair is not listed above, and on their own they are never a company name ("Co", "Com").
const GENERIC_SECOND_LEVEL = new Set([
  "co", "com", "net", "org", "ac", "edu", "gov", "ltd", "plc", "gen", "ind", "firm", "or", "ne", "go", "biz", "info", "mil", "nic",
]);

function isTwoPartSuffix(lastTwo: string[]): boolean {
  const [sld, tld] = lastTwo;
  return MULTI_PART_SUFFIXES.has(lastTwo.join(".")) || (tld?.length === 2 && GENERIC_SECOND_LEVEL.has(sld ?? ""));
}

/**
 * A company-name suggestion from a Google Workspace domain — never the bare domain itself
 * (the portal would otherwise prefill "acme.com" as the company, and the campaign brand
 * after it). "acme.com" / "mail.acme.co.in" → "Acme"; "acme-studios.com" → "Acme Studios".
 * Null when nothing sensible remains (no domain, a lone TLD, or a numeric label).
 */
export function companyFromDomain(domain: string | null | undefined): string | null {
  const labels = (domain ?? "").trim().toLowerCase().replace(/\.+$/, "").split(".").filter(Boolean);
  if (labels.length < 2 || (labels.length === 2 && isTwoPartSuffix(labels))) return null;
  const rest = labels.slice(0, labels.length - (labels.length >= 3 && isTwoPartSuffix(labels.slice(-2)) ? 2 : 1));
  const name = rest[rest.length - 1] ?? "";
  if (!/^[a-z0-9-]+$/.test(name) || /^[0-9-]+$/.test(name) || GENERIC_SECOND_LEVEL.has(name)) return null;
  const words = name.split("-").filter(Boolean);
  const out = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return out.length >= 2 ? out.slice(0, 200) : null;
}

/**
 * "Sign in with Google" (client portal). The GIS credential is verified with Google first
 * (`verifyGoogleIdToken`: our audience, Google's issuer, unexpired, email VERIFIED); only
 * then is the verified email looked up:
 *
 * - An existing client with that email (any casing) signs straight in. Google has proven
 *   they control the address, which is exactly what the password-reset email proves, so
 *   this is not a takeover path. An INACTIVE/ONBOARDING account is refused like password login.
 * - An unknown email creates an ACTIVE client, mirroring public self-signup — but a Google
 *   token names a person, not a business, so the first call answers `needsProfile` and the
 *   portal asks for the company name; the second call carries `companyName` and creates the
 *   row. Nothing is written on the first call. The row gets an unusable random password
 *   (bcrypt of 256 random bits), so password login says "invalid credentials" until the
 *   client sets one through "Forgot password"; it can never be guessed.
 *
 * Returns the same session shape as clientLogin, or `{ needsProfile: true, email, name }`.
 */
export async function clientGoogleSignIn(input: { credential: string; companyName?: string }) {
  const { verifyGoogleIdToken } = await import("./google-id-token");
  const identity = await verifyGoogleIdToken(input.credential);
  const email = identity.email;

  const existing = await prisma.client.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  if (existing) {
    if (existing.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");
    return issueClientSession(existing);
  }
  // A team login. Google has proven the person controls the address — what the invite email
  // proves — so an invited login is joined here (its link stops working); a disabled one is refused.
  const member = await prisma.clientUser.findFirst({ where: { email: { equals: likeLiteral(email), mode: "insensitive" } }, include: { client: true } });
  if (member) {
    if (member.status === "disabled" || member.client.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");
    if (member.status === "invited") {
      const joined = await prisma.clientUser.update({
        where: { id: member.id },
        data: { status: "active", tokenHash: null, tokenPurpose: null, tokenExpiresAt: null },
        include: { client: true },
      });
      return issueClientSession(joined.client, joined);
    }
    return issueClientSession(member.client, member);
  }

  const companyName = input.companyName?.trim();
  if (!companyName) {
    return { needsProfile: true as const, email, name: identity.name, suggestedCompany: companyFromDomain(identity.hostedDomain) };
  }

  const contactName = identity.name.slice(0, 200);
  const passwordHash = await hash(crypto.randomBytes(32).toString("hex"), 12);
  let client;
  try {
    client = await prisma.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: { companyName, contactName, email, passwordHash, phone: null, status: "ACTIVE" },
      });
      await tx.clientInvite.updateMany({ where: { email, usedAt: null }, data: { usedAt: new Date() } });
      return created;
    });
  } catch (err: any) {
    // Two first sign-ins racing on one verified email: the unique index decides, and the
    // loser simply signs in to the row the winner made (ownership of the email is proven).
    if (err?.code === "P2002") {
      const raced = await prisma.client.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
      if (raced && raced.status === "ACTIVE") return issueClientSession(raced);
      throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists. Sign in instead.");
    }
    throw err;
  }

  void (async () => {
    const { notifyAdminByEmail } = await import("./email.service");
    await notifyAdminByEmail(
      `New client signed up (Google): ${client.companyName}`,
      [
        { label: "Company", value: client.companyName },
        { label: "Contact", value: client.contactName },
        { label: "Email", value: client.email },
        { label: "Method", value: "Sign in with Google" },
      ],
      `/clients/${client.id}`,
    );
  })().catch((e) => console.error("[client-google-signin] admin email failed", e));

  return issueClientSession(client);
}

/** Is this address a team login (client_users)? Case-insensitive, wildcard-safe. */
async function memberEmailExists(email: string): Promise<boolean> {
  const m = await prisma.clientUser.findFirst({ where: { email: { equals: likeLiteral(email), mode: "insensitive" } }, select: { id: true } });
  return Boolean(m);
}

/**
 * Access + refresh token pair (same shape for every client sign-in path). The subject is always
 * the COMPANY (clients.id), so every client-scoped query works unchanged; a team login adds
 * `memberId` + `sv`, which authenticateClient and clientRefresh re-check against the login row.
 */
export async function issueClientSession(
  client: { id: string; email: string; contactName: string; companyName: string },
  member?: { id: string; email: string; name: string; sessionVersion: number } | null,
) {
  const claims = member ? { memberId: member.id, sv: member.sessionVersion } : {};
  const accessToken = jwt.sign(
    { userId: client.id, email: member?.email ?? client.email, roles: [], type: "client" as const, ...claims },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
  const refreshToken = jwt.sign({ userId: client.id, ...claims }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY, jwtid: crypto.randomUUID() });
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await prisma.clientRefreshToken.create({
    data: { clientId: client.id, clientUserId: member?.id ?? null, token: tokenHash, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  });
  if (member) await prisma.clientUser.update({ where: { id: member.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
  return {
    accessToken,
    refreshToken,
    user: {
      id: client.id,
      name: member?.name ?? client.contactName,
      companyName: client.companyName,
      email: member?.email ?? client.email,
      roles: [],
      /** owner = the company's own login (manages the team); member = a team login. */
      role: member ? ("member" as const) : ("owner" as const),
      ...(member ? { memberId: member.id } : {}),
    },
  };
}

export async function createInvite(email: string): Promise<{ id: string; email: string; token: string; expiresAt: Date }> {
  const normalized = email.trim().toLowerCase();

  // If an active client already exists for this email, don't issue a duplicate invite —
  // that would set up the "registered but can't sign in" trap (admin thinks the user
  // got an invite; user thinks they should reset their existing password).
  const existingClient = await prisma.client.findUnique({ where: { email: normalized } });
  if (existingClient || (await memberEmailExists(normalized))) {
    throw new AppError(409, "EMAIL_EXISTS", "A client account already exists for this email. Send them a password reset link instead.");
  }

  // Delete any existing unused invite for this email
  await prisma.clientInvite.deleteMany({ where: { email: normalized, usedAt: null } });

  const invite = await prisma.clientInvite.create({
    data: {
      email: normalized,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  });
  return invite;
}

export async function acceptInvite(token: string, password: string, contactName?: string) {
  const invite = await prisma.clientInvite.findUnique({ where: { token } });
  if (!invite) throw new AppError(400, "INVALID_TOKEN", "Invalid invite token");
  if (invite.usedAt) throw new AppError(400, "TOKEN_USED", "This invite has already been used");
  if (invite.expiresAt < new Date()) throw new AppError(400, "TOKEN_EXPIRED", "This invite has expired");

  const passwordHash = await hash(password, 12);

  // Atomic: check-then-create-then-mark-used to prevent TOCTOU race condition
  const client = await prisma.$transaction(async (tx) => {
    const existing = await tx.client.findUnique({ where: { email: invite.email } });
    if (existing || (await memberEmailExists(invite.email))) throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists");

    const newClient = await tx.client.create({
      data: {
        email: invite.email,
        companyName: invite.email.split("@")[1] || invite.email, // placeholder until updated
        contactName: contactName || invite.email.split("@")[0],
        passwordHash,
        status: "ACTIVE",
      },
    });

    // Mark invite as used
    await tx.clientInvite.update({
      where: { id: invite.id },
      data: { usedAt: new Date() },
    });

    return newClient;
  });

  return issueClientSession(client);
}
