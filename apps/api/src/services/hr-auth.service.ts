import { prisma } from "@dashmani/db";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { AppError } from "../middleware/error-handler";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import type { JwtPayload } from "@dashmani/shared";
import { notifyAdmins } from "./notification.service";

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Normalize an HR auth identifier. Emails get trimmed + lowercased; phone numbers
 * are only trimmed. Detection is "contains @" — good enough for our format.
 */
function normalizeIdentifier(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
}

// ===== Self-Registration =====

export async function registerEmployee(data: {
  name: string;
  email: string;
  phone?: string;
  password: string;
}) {
  const email = data.email.trim().toLowerCase();
  const phone = data.phone?.trim() || null;

  // Check if email already exists
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email },
        ...(phone ? [{ phone }] : []),
      ],
    },
  });

  if (existing) {
    throw new AppError(409, "ALREADY_EXISTS", "An account with this email or phone already exists");
  }

  const passwordHash = await bcrypt.hash(data.password, 12);

  const user = await prisma.user.create({
    data: {
      name: data.name,
      email,
      phone,
      passwordHash,
      status: "ONBOARDING", // Requires admin approval
    },
  });

  // Create empty profile
  await prisma.employeeProfile.create({
    data: { userId: user.id },
  });

  // Notify admins about new registration (fire and forget)
  notifyAdmins(
    "GENERAL",
    "New Employee Registration",
    `${data.name} (${email}) has registered and is awaiting approval`,
    { userId: user.id, name: data.name, email }
  ).catch((err) => console.error("Admin notification failed:", err));

  return {
    message: "Account created successfully. Please wait for admin approval before logging in.",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
    },
  };
}

// ===== Password Login =====

export async function loginWithPassword(identifier: string, password: string) {
  const normalized = normalizeIdentifier(identifier);
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ email: normalized }, { phone: normalized }],
    },
    include: { roles: { include: { role: true } } },
  });

  if (!user) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email/phone or password");
  }

  if (user.status === "ONBOARDING") {
    throw new AppError(403, "PENDING_APPROVAL", "Your account is pending admin approval. Please wait.");
  }

  if (user.status === "INACTIVE") {
    throw new AppError(403, "ACCOUNT_INACTIVE", "Your account has been deactivated. Contact admin.");
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email/phone or password");
  }

  const roleNames = user.roles.map((ur) => ur.role.name);

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    roles: roleNames,
    type: "hr",
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken({ userId: user.id });

  const hashedToken = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: hashedToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      profileImageUrl: user.profileImageUrl,
      roles: roleNames,
    },
  };
}

// ===== OTP Auth (kept for backward compatibility) =====

export async function requestOtp(identifier: string, channel: "EMAIL" | "SMS" | "WHATSAPP") {
  const normalized = normalizeIdentifier(identifier);
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ email: normalized }, { phone: normalized }],
    },
  });

  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "No user found with that email or phone");
  }

  if (user.status !== "ACTIVE") {
    throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.otpToken.updateMany({
    where: { userId: user.id, verified: false },
    data: { expiresAt: new Date(0) },
  });

  await prisma.otpToken.create({
    data: {
      userId: user.id,
      otp,
      channel,
      target: normalized,
      expiresAt,
    },
  });

  console.log(`[HR-AUTH] OTP for ${normalized}: ${otp}`);

  return { message: `OTP sent via ${channel}` };
}

export async function verifyOtp(identifier: string, otp: string) {
  const normalized = normalizeIdentifier(identifier);
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ email: normalized }, { phone: normalized }],
    },
    include: { roles: { include: { role: true } } },
  });

  if (!user) {
    throw new AppError(401, "INVALID_OTP", "Invalid identifier or OTP");
  }

  const otpToken = await prisma.otpToken.findFirst({
    where: {
      userId: user.id,
      otp,
      verified: false,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!otpToken) {
    throw new AppError(401, "INVALID_OTP", "Invalid or expired OTP");
  }

  await prisma.otpToken.update({
    where: { id: otpToken.id },
    data: { verified: true },
  });

  const roleNames = user.roles.map((ur) => ur.role.name);

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    roles: roleNames,
    type: "hr",
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken({ userId: user.id });

  const hashedToken = crypto.createHash("sha256").update(refreshToken).digest("hex");
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: hashedToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      roles: roleNames,
    },
  };
}

export async function refreshHrToken(refreshToken: string) {
  let decoded: { userId: string };
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");
  }
  const hashedToken = crypto.createHash("sha256").update(refreshToken).digest("hex");

  const stored = await prisma.refreshToken.findUnique({
    where: { token: hashedToken },
  });

  if (!stored || stored.expiresAt < new Date()) {
    throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId, deletedAt: null },
    include: { roles: { include: { role: true } } },
  });

  if (!user || user.status !== "ACTIVE") {
    throw new AppError(401, "INVALID_TOKEN", "User not found or inactive");
  }

  await prisma.refreshToken.delete({ where: { id: stored.id } });

  const roleNames = user.roles.map((ur) => ur.role.name);
  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    roles: roleNames,
    type: "hr",
  };

  const newAccessToken = signAccessToken(payload);
  const newRefreshToken = signRefreshToken({ userId: user.id });

  const newHashedToken = crypto.createHash("sha256").update(newRefreshToken).digest("hex");
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: newHashedToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}
