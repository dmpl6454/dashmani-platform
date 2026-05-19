import { prisma } from "@dashmani/db";
import { compare, hash } from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { AppError } from "../middleware/error-handler";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

export async function clientLogin(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const client = await prisma.client.findUnique({ where: { email: normalized } });
  if (!client) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  if (client.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");

  const valid = await compare(password, client.passwordHash);
  if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");

  const accessToken = jwt.sign(
    { userId: client.id, email: client.email, roles: [], type: "client" as const },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  const refreshToken = jwt.sign(
    { userId: client.id },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY, jwtid: crypto.randomUUID() }
  );

  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await prisma.clientRefreshToken.create({
    data: {
      clientId: client.id,
      token: tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: client.id,
      name: client.contactName,
      companyName: client.companyName,
      email: client.email,
      roles: [],
    },
  };
}

export async function clientRefresh(refreshToken: string) {
  const decoded = jwt.verify(refreshToken, JWT_SECRET) as { userId: string };
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");

  const stored = await prisma.clientRefreshToken.findUnique({ where: { token: tokenHash } });
  if (!stored || stored.expiresAt < new Date()) {
    throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");
  }

  const client = await prisma.client.findUnique({ where: { id: decoded.userId } });
  if (!client || client.status !== "ACTIVE") {
    throw new AppError(401, "INVALID_TOKEN", "Client not found or inactive");
  }

  // Rotate token
  await prisma.clientRefreshToken.delete({ where: { id: stored.id } });

  const newAccessToken = jwt.sign(
    { userId: client.id, email: client.email, roles: [], type: "client" as const },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  const newRefreshToken = jwt.sign(
    { userId: client.id },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY, jwtid: crypto.randomUUID() }
  );

  const newTokenHash = crypto.createHash("sha256").update(newRefreshToken).digest("hex");
  await prisma.clientRefreshToken.create({
    data: {
      clientId: client.id,
      token: newTokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}

export async function clientLogout(clientId: string) {
  await prisma.clientRefreshToken.deleteMany({ where: { clientId } });
}

export async function clientForgotPassword(email: string) {
  const normalized = email.trim().toLowerCase();
  const client = await prisma.client.findUnique({ where: { email: normalized } });
  if (!client) return; // silent — don't reveal whether email exists

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

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
        <p style="color:#555">Click the button below to reset your client-portal password. This link expires in 1 hour.</p>
        <a href="${resetLink}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#1A1A1A;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
        <p style="color:#999;font-size:12px">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
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
    throw new AppError(400, "INVALID_TOKEN", "Reset link is invalid or expired");
  }

  const passwordHash = await hash(newPassword, 12);
  await prisma.client.update({ where: { id: record.clientId }, data: { passwordHash } });
  await prisma.otpToken.update({ where: { id: record.id }, data: { verified: true } });
  await prisma.clientRefreshToken.deleteMany({ where: { clientId: record.clientId } });
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

export async function createInvite(email: string): Promise<{ id: string; email: string; token: string; expiresAt: Date }> {
  const normalized = email.trim().toLowerCase();

  // If an active client already exists for this email, don't issue a duplicate invite —
  // that would set up the "registered but can't sign in" trap (admin thinks the user
  // got an invite; user thinks they should reset their existing password).
  const existingClient = await prisma.client.findUnique({ where: { email: normalized } });
  if (existingClient) {
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
    if (existing) throw new AppError(409, "EMAIL_EXISTS", "An account with this email already exists");

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

  // Generate tokens (reuse same pattern as clientLogin)
  const accessToken = jwt.sign(
    { userId: client.id, email: client.email, roles: [], type: "client" as const },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
  const refreshToken = jwt.sign(
    { userId: client.id },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY, jwtid: crypto.randomUUID() }
  );
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await prisma.clientRefreshToken.create({
    data: {
      clientId: client.id,
      token: tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: client.id,
      name: client.contactName,
      companyName: client.companyName,
      email: client.email,
      roles: [],
    },
  };
}
