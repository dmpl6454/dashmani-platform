import { prisma } from "@dashmani/db";
import crypto from "crypto";
import { AppError } from "../middleware/error-handler";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import type { JwtPayload } from "@dashmani/shared";

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function requestOtp(identifier: string, channel: "EMAIL" | "SMS" | "WHATSAPP") {
  // Find user by email OR phone
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ email: identifier }, { phone: identifier }],
    },
  });

  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "No user found with that email or phone");
  }

  if (user.status !== "ACTIVE") {
    throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Invalidate any existing OTPs for this user
  await prisma.otpToken.updateMany({
    where: { userId: user.id, verified: false },
    data: { expiresAt: new Date(0) },
  });

  await prisma.otpToken.create({
    data: {
      userId: user.id,
      otp,
      channel,
      target: identifier,
      expiresAt,
    },
  });

  // TODO: production delivery via EMAIL/SMS/WHATSAPP
  console.log(`[HR-AUTH] OTP for ${identifier}: ${otp}`);

  return { message: `OTP sent via ${channel}` };
}

export async function verifyOtp(identifier: string, otp: string) {
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: [{ email: identifier }, { phone: identifier }],
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

  // Mark OTP as verified
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
