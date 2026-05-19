import { prisma } from "@dashmani/db";
import { comparePassword, hashPassword } from "../utils/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { AppError } from "../middleware/error-handler";
import type { JwtPayload } from "@dashmani/shared";
import { sendEmail } from "./email.service";
import crypto from "crypto";

export async function login(email: string, password: string) {
  const normalizedEmailValue = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmailValue, deletedAt: null },
    include: { roles: { include: { role: true } } },
  });

  if (!user) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  if (user.status !== "ACTIVE") {
    throw new AppError(403, "ACCOUNT_INACTIVE", "Account is not active");
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  const roleNames = user.roles.map((ur) => ur.role.name);

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    roles: roleNames,
    type: "employee",
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
      profileImageUrl: user.profileImageUrl,
    },
  };
}

export async function refresh(refreshToken: string) {
  const decoded = verifyRefreshToken(refreshToken);
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
    type: "employee",
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

export async function logout(userId: string) {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

export async function forgotPassword(email: string, app: "internal" | "hr" = "internal") {
  const normalizedEmailValue = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmailValue, deletedAt: null } });
  if (!user) return; // silent — don't reveal whether email exists

  // If the account is in a state where a password reset won't actually unlock login,
  // send an explanatory email instead of a reset link. Otherwise the user resets
  // their password, still can't log in, and assumes the system is broken.
  if (user.status !== "ACTIVE") {
    const reason = user.status === "ONBOARDING"
      ? "Your account is awaiting admin approval. A password reset won't unlock sign-in — an administrator needs to approve your account first."
      : "Your account is not active. Please contact an administrator.";

    await sendEmail({
      to: user.email,
      subject: "About your password reset request — Digital Sukoon Portal",
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
          <h2 style="margin:0 0 8px">Account not yet active</h2>
          <p style="color:#555">Hi ${user.name},</p>
          <p style="color:#555">${reason}</p>
          <p style="color:#999;font-size:12px">If you believe this is a mistake, email admin@digitalsukoon.com.</p>
        </div>
      `,
    });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.otpToken.deleteMany({ where: { userId: user.id, channel: "EMAIL", target: "PASSWORD_RESET" } });
  await prisma.otpToken.create({
    data: { userId: user.id, otp: token, channel: "EMAIL", target: "PASSWORD_RESET", expiresAt },
  });

  const portalUrl = app === "hr"
    ? (process.env.HR_APP_URL || "https://hr.digitalsukoon.com")
    : (process.env.INTERNAL_APP_URL || "https://portal.digitalsukoon.com");
  const resetLink = `${portalUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: user.email,
    subject: "Reset your password — Digital Sukoon Portal",
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px">Reset your password</h2>
        <p style="color:#555">Hi ${user.name},</p>
        <p style="color:#555">Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetLink}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#1A1A1A;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
        <p style="color:#999;font-size:12px">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId, deletedAt: null } });
  if (!user) throw new AppError(404, "NOT_FOUND", "User not found");

  const valid = await comparePassword(currentPassword, user.passwordHash);
  if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Current password is incorrect");

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

export async function resetPassword(token: string, newPassword: string) {
  const record = await prisma.otpToken.findFirst({
    where: {
      otp: token,
      channel: "EMAIL",
      target: "PASSWORD_RESET",
      verified: false,
      userId: { not: null },
      expiresAt: { gt: new Date() },
    },
  });

  if (!record || !record.userId) {
    throw new AppError(400, "INVALID_TOKEN", "Reset link is invalid or expired");
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: record.userId }, data: { passwordHash } });
  await prisma.otpToken.update({ where: { id: record.id }, data: { verified: true } });
  await prisma.refreshToken.deleteMany({ where: { userId: record.userId } });
}
