/**
 * Fixtures for the message and sync tests (not a test file itself).
 *
 * The project routes (PR 7) are built in parallel on another branch, so these tests
 * create projects, phases and participants by DIRECT INSERT through `pipelineDb` instead
 * of through the API. Keep every helper here self-contained: nothing imports PR 7 code.
 *
 * ⚠️ Call these only from hooks/tests nested inside a describe (tests/setup.ts TRUNCATEs
 * in a root-level beforeEach, and vitest runs same-level hooks in parallel).
 */
import { randomUUID } from "crypto";
import { pipelineDb } from "../../src/services/pipeline/db";

/** The id of a seeded phase (seedPipelinePhases), by key — "brief" by default. */
export async function phaseIdOf(key = "brief"): Promise<string> {
  const phase = await pipelineDb.pipelinePhase.findUniqueOrThrow({ where: { key } });
  return phase.id;
}

let rankSeq = 0;

/**
 * A live project owned by `ownerId` with an owner MEMBER row plus `memberIds` as MEMBER
 * rows, like route #5 would create it. `archived` / `deleted` set the soft-state columns.
 */
export async function createProjectFixture(opts: {
  ownerId: string;
  title?: string;
  phaseKey?: string;
  memberIds?: string[];
  archived?: boolean;
  deleted?: boolean;
}) {
  const phaseId = await phaseIdOf(opts.phaseKey);
  const members = [...new Set((opts.memberIds ?? []).filter((id) => id !== opts.ownerId))];
  const project = await pipelineDb.pipelineProject.create({
    data: {
      clientId: randomUUID(),
      title: opts.title ?? "Fixture project",
      ownerId: opts.ownerId,
      createdById: opts.ownerId,
      phaseId,
      rank: `a${(++rankSeq).toString(36)}`,
      memberCount: 1 + members.length,
      archivedAt: opts.archived ? new Date() : null,
      archivedById: opts.archived ? opts.ownerId : null,
      deletedAt: opts.deleted ? new Date() : null,
      deletedById: opts.deleted ? opts.ownerId : null,
    },
  });
  await pipelineDb.pipelineParticipant.createMany({
    data: [opts.ownerId, ...members].map((userId) => ({
      projectId: project.id,
      userId,
      role: "MEMBER",
      memberAddedById: opts.ownerId,
      memberAddedAt: new Date(),
    })),
  });
  return project;
}

/** Insert one participant row directly (e.g. a FOLLOWER, or a row with read state). */
export async function addParticipantFixture(
  projectId: string,
  userId: string,
  opts: { role?: "MEMBER" | "FOLLOWER"; lastReadSeq?: number; notify?: boolean } = {},
) {
  return pipelineDb.pipelineParticipant.create({
    data: {
      projectId,
      userId,
      role: opts.role ?? "FOLLOWER",
      lastReadSeq: opts.lastReadSeq ?? 0,
      notify: opts.notify ?? true,
    },
  });
}

export async function setProjectState(projectId: string, state: { archived?: boolean; deleted?: boolean }) {
  await pipelineDb.pipelineProject.update({
    where: { id: projectId },
    data: {
      ...(state.archived !== undefined ? { archivedAt: state.archived ? new Date() : null } : {}),
      ...(state.deleted !== undefined ? { deletedAt: state.deleted ? new Date() : null } : {}),
    },
  });
}

export function projectRow(projectId: string) {
  return pipelineDb.pipelineProject.findUniqueOrThrow({ where: { id: projectId } });
}

export function participantRow(projectId: string, userId: string) {
  return pipelineDb.pipelineParticipant.findUnique({ where: { projectId_userId: { projectId, userId } } });
}

export function messagesOf(projectId: string) {
  return pipelineDb.pipelineMessage.findMany({ where: { projectId }, orderBy: { seq: "asc" } });
}

/** A mention token as the composer writes it. */
export const mention = (userId: string) => `@{${userId}}`;
