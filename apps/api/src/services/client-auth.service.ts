import { prisma } from "@dashmani/db";
import { compare, hash } from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { AppError } from "../middleware/error-handler";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY = "7d";

export async function clientLogin(email: string, password: string) {
  const client = await prisma.client.findUnique({ where: { email } });
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
    { expiresIn: REFRESH_TOKEN_EXPIRY }
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
    { expiresIn: REFRESH_TOKEN_EXPIRY }
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

export async function createClient(data: {
  companyName: string;
  contactName: string;
  email: string;
  password: string;
  phone?: string;
}) {
  const existing = await prisma.client.findUnique({ where: { email: data.email } });
  if (existing) throw new AppError(409, "EMAIL_EXISTS", "A client with this email already exists");

  const passwordHash = await hash(data.password, 12);
  return prisma.client.create({
    data: {
      companyName: data.companyName,
      contactName: data.contactName,
      email: data.email,
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
  // Delete any existing unused invite for this email
  await prisma.clientInvite.deleteMany({ where: { email, usedAt: null } });

  const invite = await prisma.clientInvite.create({
    data: {
      email,
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
    { expiresIn: REFRESH_TOKEN_EXPIRY }
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
