/**
 * The shoot desk and the team workload view (2026-11-02). Rules and wire shapes live in
 * packages/shared/src/pipeline/work.ts; tables in scripts/pipeline-work2-ddl.sql.
 *
 *   Shoot     an assignment for a camera person: event, place, call time, contact, what to
 *             cover, deadline, embargo, status and the upload link. Optionally tied to a
 *             Pipeline project (deleting the project keeps the shoot). Edits carry the `rev`
 *             they read; a different current rev answers 409 with the current row.
 *   Workload  per active person: open pages, late pages, reviews to do, open shoots, owned live
 *             projects (and how many are overdue), and approved leave today / this week.
 *             Bounded aggregates only — group-bys and counts, never row lists.
 *
 * ⚠️ Pipeline pool only, like every file in this folder. The shoot desk is open to every
 * active HR user (the Pipeline's open-access rule). The camera person gets a "shoot" work
 * notice (notifier.onWork) when assigned — re-armed on a re-assignment, withdrawn from the
 * person it was taken from — opening the shoot desk's "Mine" view.
 */
import { pipelineWork as W, todayIST, addDaysIST } from "@dashmani/shared";
import { pipelineRead, pipelineWrite } from "./tx";
import { PipelineError } from "./errors";
import { lockProject, assertWritable } from "./projects.service";
import type { PipelineDirectory } from "./access";
import { Prisma } from "./db";
import { assertPickable, guarded, shootDto, type ShootRow, type WorkActor } from "./work.service";
import { notifier } from "./notifier";
import { pilotAllow } from "./messages.service";
import { pipelineEmailOn } from "./email-outbox";
import { istCallLabel } from "./notify";

export { istCallLabel };


/** "X assigned you a shoot" for the camera person; the previous one's row is withdrawn. */
async function notifyShoot(
  tx: Prisma.TransactionClient,
  actor: WorkActor,
  s: { id: string; title: string; callTime: Date; location: string; cameraId: string | null; projectId: string | null },
  previousCameraId: string | null,
): Promise<void> {
  await notifier.onWork(tx, {
    kind: "shoot",
    key: s.id,
    projectId: s.projectId,
    recipients: s.cameraId ? [s.cameraId] : [],
    actorId: actor.userId,
    allow: pilotAllow(actor.settings),
    title: `${actor.name} assigned you a shoot: ${s.title}`,
    message: [`Call ${istCallLabel(s.callTime)}`, s.location].filter(Boolean).join(" · "),
    path: "/pipeline/shoots?view=mine",
    withdraw: previousCameraId && previousCameraId !== s.cameraId ? [previousCameraId] : undefined,
    email: pipelineEmailOn(actor.settings),
  });
}

const SHOOT_INCLUDE = { project: { select: { id: true, title: true, deletedAt: true } } } as const;

async function assertProjectUsable(tx: Prisma.TransactionClient, projectId: string, actorId: string): Promise<void> {
  // Same refusals as any other write on a project: missing, deleted, archived, inactive actor.
  assertWritable(await lockProject(tx, projectId, actorId));
}

export async function listShoots(
  userId: string,
  dir: PipelineDirectory,
  view: "upcoming" | "mine" | "past",
): Promise<{ shoots: W.PipelineShootDto[]; now: string }> {
  return guarded(async () => {
    const r = await pipelineRead(async (db) => {
      const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
      // "Upcoming" keeps today's shoots on the list for 12 h after their call time.
      const since = new Date(now.getTime() - 12 * 3600_000);
      const where: Prisma.PipelineShootWhereInput =
        view === "past"
          ? { OR: [{ callTime: { lt: since } }, { status: { in: ["done", "cancelled"] } }] }
          : view === "mine"
            ? { cameraId: userId, callTime: { gte: since } }
            : { callTime: { gte: since }, status: { notIn: ["cancelled"] } };
      const shoots = await db.pipelineShoot.findMany({
        where,
        include: SHOOT_INCLUDE,
        orderBy: view === "past" ? [{ callTime: "desc" }, { id: "desc" }] : [{ callTime: "asc" }, { id: "asc" }],
        take: W.PIPELINE_WORK_LIMITS.shootsListMax,
      });
      return { shoots: shoots as ShootRow[], now };
    });
    return { shoots: r.shoots.map((s) => shootDto(dir, s)), now: r.now.toISOString() };
  });
}

export async function createShoot(actor: WorkActor, input: W.CreateShootInput): Promise<W.PipelineShootDto> {
  if (input.cameraId) assertPickable(actor, input.cameraId, "camera person");
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      if (input.projectId) await assertProjectUsable(tx, input.projectId, actor.userId);
      const created = await tx.pipelineShoot.create({
        data: {
          title: input.title,
          callTime: new Date(input.callTime),
          event: input.event ?? "",
          location: input.location ?? "",
          cameraId: input.cameraId ?? null,
          contact: input.contact ?? "",
          requirements: input.requirements ?? "",
          deadline: input.deadline ? new Date(input.deadline) : null,
          embargoUntil: input.embargoUntil ? new Date(input.embargoUntil) : null,
          projectId: input.projectId ?? null,
          createdById: actor.userId,
        },
        include: SHOOT_INCLUDE,
      });
      if (created.cameraId) await notifyShoot(tx, actor, created, null);
      return created;
    });
    return shootDto(actor.directory, row as ShootRow);
  });
}

export async function editShoot(actor: WorkActor, shootId: string, input: W.EditShootInput): Promise<W.PipelineShootDto> {
  const c = input.changes;
  if (c.cameraId) assertPickable(actor, c.cameraId, "camera person");
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      // Row lock on the shoot itself: two edits of one shoot never interleave.
      const locked = await tx.$queryRaw<Array<{ rev: number; camera_id: string | null }>>`
        SELECT rev, camera_id FROM pipeline_shoots WHERE id = ${shootId} FOR UPDATE`;
      if (!locked[0]) throw new PipelineError(404, "SHOOT_NOT_FOUND", "This shoot doesn't exist");
      if (locked[0].rev !== input.base) {
        const cur = await tx.pipelineShoot.findUnique({ where: { id: shootId }, include: SHOOT_INCLUDE });
        throw new PipelineError(409, "SHOOT_CONFLICT", "Someone else changed this shoot — showing their version", {
          current: cur ? shootDto(actor.directory, cur as ShootRow) : undefined,
        });
      }
      if (c.projectId) await assertProjectUsable(tx, c.projectId, actor.userId);
      if (c.status === "uploaded" && c.uploadUrl === undefined) {
        const cur = await tx.pipelineShoot.findUnique({ where: { id: shootId }, select: { uploadUrl: true } });
        if (!cur?.uploadUrl) throw new PipelineError(400, "UPLOAD_URL_REQUIRED", "Add the link to the footage");
      }
      if (c.status === "uploaded" && c.uploadUrl === null) {
        throw new PipelineError(400, "UPLOAD_URL_REQUIRED", "Add the link to the footage");
      }
      const data: Prisma.PipelineShootUncheckedUpdateInput = { rev: { increment: 1 } };
      if (c.title !== undefined) data.title = c.title;
      if (c.callTime !== undefined) data.callTime = new Date(c.callTime);
      if (c.event !== undefined) data.event = c.event;
      if (c.location !== undefined) data.location = c.location;
      if (c.cameraId !== undefined) data.cameraId = c.cameraId;
      if (c.contact !== undefined) data.contact = c.contact;
      if (c.requirements !== undefined) data.requirements = c.requirements;
      if (c.deadline !== undefined) data.deadline = c.deadline ? new Date(c.deadline) : null;
      if (c.embargoUntil !== undefined) data.embargoUntil = c.embargoUntil ? new Date(c.embargoUntil) : null;
      if (c.projectId !== undefined) data.projectId = c.projectId;
      if (c.status !== undefined) data.status = c.status;
      if (c.uploadUrl !== undefined) data.uploadUrl = c.uploadUrl;
      const updated = await tx.pipelineShoot.update({ where: { id: shootId }, data, include: SHOOT_INCLUDE });
      if (c.cameraId !== undefined && c.cameraId !== locked[0].camera_id) {
        await notifyShoot(tx, actor, updated, locked[0].camera_id);
      }
      return updated;
    });
    return shootDto(actor.directory, row as ShootRow);
  });
}

// ── Workload ───────────────────────────────────────────────────────────────────────

type CountRow = { user_id: string; n: number };

export async function getWorkload(dir: PipelineDirectory): Promise<W.PipelineWorkloadDto> {
  const today = todayIST();
  const weekEnd = addDaysIST(today, 7);
  return guarded(async () => {
    const r = await pipelineRead(async (db) => {
      const now = (await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0].now;
      const live = Prisma.sql`p.deleted_at IS NULL AND p.archived_at IS NULL`;
      const pages = await db.$queryRaw<Array<{ user_id: string; n: number; late: number }>>`
        SELECT d.assignee_id AS user_id, count(*)::int AS n,
               count(*) FILTER (WHERE d.scheduled_at IS NOT NULL AND d.scheduled_at < ${now})::int AS late
          FROM pipeline_deliverables d JOIN pipeline_projects p ON p.id = d.project_id
         WHERE d.assignee_id IS NOT NULL AND d.status NOT IN ('published', 'cancelled') AND ${live}
         GROUP BY d.assignee_id`;
      const reviews = await db.$queryRaw<CountRow[]>`
        SELECT r.reviewer_id AS user_id, count(*)::int AS n
          FROM pipeline_reviews r JOIN pipeline_projects p ON p.id = r.project_id
         WHERE r.status = 'pending' AND ${live}
         GROUP BY r.reviewer_id`;
      const shoots = await db.$queryRaw<CountRow[]>`
        SELECT s.camera_id AS user_id, count(*)::int AS n
          FROM pipeline_shoots s
         WHERE s.camera_id IS NOT NULL AND s.status IN ('assigned', 'on_site')
           AND s.call_time >= ${new Date(now.getTime() - 12 * 3600_000)}
         GROUP BY s.camera_id`;
      const projects = await db.$queryRaw<Array<{ user_id: string; n: number; overdue: number }>>`
        SELECT p.owner_id AS user_id, count(*)::int AS n,
               count(*) FILTER (WHERE p.due_date IS NOT NULL AND p.due_date < ${today}::date)::int AS overdue
          FROM pipeline_projects p JOIN pipeline_phases ph ON ph.id = p.phase_id
         WHERE ${live} AND ph.is_terminal = false
         GROUP BY p.owner_id`;
      const leave = await db.$queryRaw<Array<{ user_id: string; start: Date }>>`
        SELECT l.employee_id AS user_id, min(l.start_date) AS start
          FROM leave_requests l
         WHERE l.status = 'APPROVED' AND l.end_date >= ${today}::date AND l.start_date <= ${weekEnd}::date
         GROUP BY l.employee_id`;
      return { now, pages, reviews, shoots, projects, leave };
    });

    const rows = new Map<string, W.PipelineWorkloadRow>();
    const row = (id: string): W.PipelineWorkloadRow => {
      let x = rows.get(id);
      if (!x) {
        x = {
          person: { id, name: dir.byId.get(id)?.name ?? "Former member" },
          pagesOpen: 0, pagesLate: 0, reviewsToDo: 0, shootsOpen: 0, projectsOwned: 0, projectsOverdue: 0,
          onLeaveToday: false, leaveFrom: null,
        };
        rows.set(id, x);
      }
      return x;
    };
    for (const p of r.pages) Object.assign(row(p.user_id), { pagesOpen: p.n, pagesLate: p.late });
    for (const p of r.reviews) row(p.user_id).reviewsToDo = p.n;
    for (const p of r.shoots) row(p.user_id).shootsOpen = p.n;
    for (const p of r.projects) Object.assign(row(p.user_id), { projectsOwned: p.n, projectsOverdue: p.overdue });
    // Leave only annotates people who already have work: the list is about load, not a roster.
    for (const l of r.leave) {
      const x = rows.get(l.user_id);
      if (!x) continue;
      const start = l.start.toISOString().slice(0, 10);
      x.onLeaveToday = start <= today;
      x.leaveFrom = start <= today ? null : start;
    }
    const load = (x: W.PipelineWorkloadRow) => x.pagesOpen + x.reviewsToDo + x.shootsOpen + x.projectsOwned;
    const list = [...rows.values()]
      .filter((x) => dir.byId.get(x.person.id)?.active !== false)
      .sort((a, b) => load(b) - load(a) || (a.person.name < b.person.name ? -1 : a.person.name > b.person.name ? 1 : 0));
    return { rows: list, today, now: r.now.toISOString() };
  });
}
