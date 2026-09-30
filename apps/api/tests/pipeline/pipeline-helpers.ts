/**
 * Shared fixtures for the pipeline test files (not a test file itself).
 *
 * ⚠️ `system_settings` is NOT in the TRUNCATE list, so every file that sets a
 * `pipeline.*` key must call clearPipelineSettings() before and after its tests.
 * ⚠️ Always pass explicit unique emails: users created in the same millisecond collide
 * on users.email.
 *
 * chore/platform-guards adds an equivalent generateHrToken() to tests/helpers.ts; this
 * file keeps the pipeline tests independent of that branch landing first.
 */
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";

const SECRET = process.env.JWT_SECRET || "dev-secret";

let seq = 0;
/** An email unique within this test process. */
export const uniqueEmail = (tag: string) => `pl-${tag}-${Date.now()}-${++seq}@test.com`;

type TokenType = "hr" | "employee" | "client";

export function tokenFor(userId: string, type: TokenType, opts: { roles?: string[]; expiresIn?: number | string } = {}) {
  return jwt.sign({ userId, email: `${userId}@x.test`, roles: opts.roles ?? [], type }, SECRET, {
    expiresIn: opts.expiresIn ?? "15m",
  });
}

export const hrToken = (userId: string, opts: { roles?: string[]; expiresIn?: number | string } = {}) =>
  tokenFor(userId, "hr", opts);

/** The client portal's refresh token shape: `{userId}` with NO `type`, same secret. */
export const typelessToken = (userId: string) => jwt.sign({ userId }, SECRET, { expiresIn: "7d" });

export async function setPipelineSetting(key: string, value: string): Promise<void> {
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function clearPipelineSettings(): Promise<void> {
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "pipeline." } } });
}

export async function createPipelineUser(opts: {
  name: string;
  tag?: string;
  status?: "ACTIVE" | "INACTIVE" | "ONBOARDING";
  deleted?: boolean;
  roleNames?: string[];
  teamName?: string;
  phone?: string;
}) {
  let orgUnitId: string | undefined;
  if (opts.teamName) {
    const team = await prisma.orgUnit.create({ data: { name: opts.teamName, type: "TEAM" } });
    orgUnitId = team.id;
  }
  const user = await prisma.user.create({
    data: {
      name: opts.name,
      email: uniqueEmail(opts.tag ?? "user"),
      phone: opts.phone,
      passwordHash: "x",
      status: opts.status ?? "ACTIVE",
      deletedAt: opts.deleted ? new Date() : null,
      orgUnitId,
    },
  });
  for (const roleName of opts.roleNames ?? []) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      create: { name: roleName, description: `test ${roleName}` },
      update: {},
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return user;
}

/** The seven default phases from the DDL seed (spec §2 "Seeds"). */
export async function seedPipelinePhases() {
  const names = ["Brief", "Planning", "In Production", "Review", "Approved", "Live", "Done"];
  await prisma.pipelinePhase.createMany({
    data: names.map((name, i) => ({
      key: name.toLowerCase().replace(/\s+/g, "_"),
      name,
      position: i + 1,
      isTerminal: name === "Done",
    })),
  });
  await prisma.pipelineBoardState.upsert({ where: { id: 1 }, create: { id: 1, seq: 0 }, update: {} });
}

/**
 * The email outbox's partial unique index, read VERBATIM from scripts/pipeline-email-ddl.sql
 * (Prisma cannot express it, so a `db push` database — CI's included — lacks it). Tests
 * that exercise email call this once; it is idempotent (IF NOT EXISTS) and TRUNCATE never
 * drops an index, so it persists for the rest of the run.
 */
export function pendingKeyIndexSql(): string {
  const ddl = fs.readFileSync(path.resolve(__dirname, "../../../../scripts/pipeline-email-ddl.sql"), "utf8");
  const m = /CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_email_outbox_pending_key"[^;]*;/.exec(ddl);
  if (!m) throw new Error("pipeline-email-ddl.sql: the pending-key index statement is missing");
  return m[0];
}

export async function ensurePipelineEmailSchema(): Promise<void> {
  await prisma.$executeRawUnsafe(pendingKeyIndexSql());
}
