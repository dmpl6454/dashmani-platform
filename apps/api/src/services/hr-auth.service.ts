import { prisma, Prisma } from "@dashmani/db";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { AppError } from "../middleware/error-handler";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { likeLiteral } from "../utils/like-literal";
import type { JwtPayload } from "@dashmani/shared";
import { dispatchNotification } from "./notification.service";

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

const ALREADY_EXISTS_MESSAGE = "An account with this email or phone already exists";

export async function registerEmployee(data: {
  name: string;
  email: string;
  phone?: string;
  password: string;
}) {
  const email = data.email.trim().toLowerCase();
  const phone = data.phone?.trim() || null;

  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        // Case-INSENSITIVE, like every other auth lookup: the unique index on email is
        // case-sensitive, so an exact match misses a legacy mixed-case row and the create
        // below would then mint a SECOND account under the same address (CLAUDE.md,
        // "Email-case lockouts").
        // ⚠️ Prisma sends this as `ILIKE $1` and does NOT escape the value, so a raw '_'
        // would match any character: `a_b@x.com` would 409 against `axb@x.com`, and this
        // public endpoint would become an enumeration oracle. likeLiteral() makes it an
        // exact case-insensitive match. The email is bounded to 254 chars by
        // registerEmployeeSchema before it gets here, so the (unindexed) ILIKE stays cheap.
        { email: { equals: likeLiteral(email), mode: "insensitive" } },
        ...(phone ? [{ phone }] : []),
      ],
    },
    select: { id: true },
  });

  // ⚠️ P0 (pipeline spec §10, 2026-09-26): registration NEVER touches an existing row.
  // An existing email or phone in ANY status — ONBOARDING included — gets the same 409.
  // This used to promote an ONBOARDING row to ACTIVE with the registrant's password and
  // replace its roles, so anyone who knew an admin-created pending hire's email could
  // take over that account. Pending hires are activated only through the admin flow.
  // Do not re-add a "promote on retry" branch here.
  if (existing) {
    throw new AppError(409, "ALREADY_EXISTS", ALREADY_EXISTS_MESSAGE);
  }

  const passwordHash = await bcrypt.hash(data.password, 12);
  const employeeRole = await prisma.role.findUnique({ where: { name: "Employee" } });

  // Owner decision 2026-09-26: new sign-ups stay instant (ACTIVE).
  let user;
  try {
    user = await prisma.user.create({
      data: {
        name: data.name,
        email,
        phone,
        passwordHash,
        status: "ACTIVE",
        ...(employeeRole ? { roles: { create: [{ roleId: employeeRole.id }] } } : {}),
      },
    });
  } catch (err) {
    // Two concurrent registrations for one new email both pass the check above (bcrypt
    // sits between it and this insert); the loser hits the unique index. That is the same
    // "already exists" outcome, not a server fault — never let it surface as a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(409, "ALREADY_EXISTS", ALREADY_EXISTS_MESSAGE);
    }
    throw err;
  }

  // Create empty profile
  await prisma.employeeProfile.create({
    data: { userId: user.id },
  });

  // Notify admins about new registration (fire and forget)
  dispatchNotification({
    type: "GENERAL",
    title: "New Employee Registration",
    message: `${data.name} (${email}) has created an account and is now active`,
    metadata: { userId: user.id, name: data.name, email },
  }).catch((err) => console.error("Admin notification failed:", err));

  return {
    message: "Account created successfully. You can now log in.",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
    },
  };
}

// ===== Sign in with Google =====

/** Mint the HR session for a user row — shared by password login and Google sign-in. */
async function issueHrSession(user: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  profileImageUrl: string | null;
  roles: Array<{ role: { name: string } }>;
}) {
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

/**
 * Sign in (or register) with a Google ID token.
 *
 * The token is verified with Google first (our audience, Google issuer, unexpired, verified
 * email) — see services/google-id-token.ts. Then:
 *   - an existing user with that email (any casing) signs straight in, under the SAME status
 *     rules as password login (ONBOARDING → pending approval, INACTIVE / deleted → refused).
 *     Nothing on the row is touched: Google sign-in can never take over or alter an account.
 *   - an unknown email is a self-registration, exactly what POST /hr/auth/register does
 *     (owner decision 2026-09-26: instant ACTIVE access with the Employee role), except the
 *     password is unusable (bcrypt of 256 random bits) — "Forgot password" sets one.
 * Google supplies a name and an email, which is all registration requires, so unlike the
 * client portal there is no second "complete your profile" round-trip.
 */
export async function hrGoogleSignIn(credential: string) {
  const { verifyGoogleIdToken } = await import("./google-id-token");
  const identity = await verifyGoogleIdToken(credential);
  const email = identity.email.trim().toLowerCase();

  const findByEmail = () =>
    prisma.user.findFirst({
      // Case-insensitive, like every other auth lookup (CLAUDE.md "Email-case lockouts").
      // likeLiteral: Prisma compiles this to ILIKE without escaping, so a raw '_' or '%' in
      // the address would widen the match.
      where: { email: { equals: likeLiteral(email), mode: "insensitive" } },
      include: { roles: { include: { role: true } } },
    });

  const existing = await findByEmail();
  if (existing) {
    if (existing.deletedAt || existing.status === "INACTIVE") {
      throw new AppError(403, "ACCOUNT_INACTIVE", "Your account has been deactivated. Contact admin.");
    }
    if (existing.status === "ONBOARDING") {
      throw new AppError(403, "PENDING_APPROVAL", "Your account is pending admin approval. Please wait.");
    }
    return { ...(await issueHrSession(existing)), created: false as const };
  }

  const name = identity.name?.trim().slice(0, 120) || email.split("@")[0];
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
  const employeeRole = await prisma.role.findUnique({ where: { name: "Employee" } });

  let user;
  try {
    user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        status: "ACTIVE",
        ...(employeeRole ? { roles: { create: [{ roleId: employeeRole.id }] } } : {}),
      },
      include: { roles: { include: { role: true } } },
    });
    await prisma.employeeProfile.create({ data: { userId: user.id } });
  } catch (err) {
    // Two first sign-ins for one new email racing (two tabs): the loser hits the unique
    // index. The account now exists, so the loser simply signs into it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await findByEmail();
      if (raced && raced.status === "ACTIVE" && !raced.deletedAt) {
        return { ...(await issueHrSession(raced)), created: false as const };
      }
      throw new AppError(409, "ALREADY_EXISTS", ALREADY_EXISTS_MESSAGE);
    }
    throw err;
  }

  dispatchNotification({
    type: "GENERAL",
    title: "New Employee Registration",
    message: `${name} (${email}) signed up with Google and is now active`,
    metadata: { userId: user.id, name, email, via: "google" },
  }).catch((err) => console.error("Admin notification failed:", err));

  return { ...(await issueHrSession(user)), created: true as const };
}

// ===== Password Login =====

export async function loginWithPassword(identifier: string, password: string) {
  const normalized = normalizeIdentifier(identifier);
  const isEmail = normalized.includes("@");
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: isEmail
        ? [{ email: { equals: normalized, mode: "insensitive" } }]
        : [{ phone: normalized }],
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
  const isEmail = normalized.includes("@");
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: isEmail
        ? [{ email: { equals: normalized, mode: "insensitive" } }]
        : [{ phone: normalized }],
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
  const isEmail = normalized.includes("@");
  const user = await prisma.user.findFirst({
    where: {
      deletedAt: null,
      OR: isEmail
        ? [{ email: { equals: normalized, mode: "insensitive" } }]
        : [{ phone: normalized }],
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

  // Consume the one-time token RACE-SAFELY. Two concurrent refreshes with the same
  // token (two tabs / a retry) both pass the findUnique above; a bare delete() throws
  // P2025 for the loser → unhandled 500 (seen 16× live on /hr/auth/refresh 2026-07-17).
  // deleteMany never throws on a missing row; count===0 means another request already
  // rotated this token → the loser gets the SAME clean 401 as every other invalid-token
  // path. Single-use semantics preserved: exactly one winner.
  const consumed = await prisma.refreshToken.deleteMany({ where: { id: stored.id } });
  if (consumed.count === 0) {
    throw new AppError(401, "INVALID_TOKEN", "Refresh token already used");
  }

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
