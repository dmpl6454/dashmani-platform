/**
 * Pipeline "due tomorrow" and "overdue" alerts (spec §7.8). A 60-minute tick; the first
 * run is 17 minutes after boot (index.ts), so a deploy restart never lands on it.
 *
 * Sends only when: the feature is not off, the schema self-check passed, today (IST) is a
 * working day (Sunday is the ONLY weekend day) and it is 09:30–20:00 IST.
 *   - due soon: due_date ∈ (today, nextWorkingDay(today)] — a Saturday run covers Sunday
 *     and Monday;
 *   - overdue:  due_date < today.
 * Both skip archived, deleted and terminal-phase projects and need
 * `<kind>_notified_for IS DISTINCT FROM due_date`, so a re-run inserts nothing and a
 * changed due date re-arms.
 *
 * Per batch of ≤ 200, ONE transaction: (1) claim with UPDATE … WHERE id IN (… FOR UPDATE
 * SKIP LOCKED) with every predicate repeated, so EvalPlanQual re-checks the LATEST row
 * version and a PATCH holding the row is skipped rather than stamped with a stale date;
 * (2) insert the rows from exactly what (1) returned. (The spec writes these as one
 * CTE statement; two statements in one transaction keep the same atomicity and let the
 * text be built grapheme-safely in TypeScript.)
 *
 * EMAIL (owner request 2026-09-30): a due-soon batch also queues one outbox row per
 * recipient (email-outbox.ts enqueueDueSoonEmails) in the SAME transaction, from exactly
 * what the claim returned — when pipeline.email is on. Overdue does not email.
 *
 * ⚠️ The overlap flag is claimed synchronously, before the first await.
 */
import {
  dateToIST,
  dayOfWeekIST,
  isWorkingDayIST,
  istMinutesOfDay,
  nextWorkingDayIST,
} from "@dashmani/shared";
import { Prisma, type PipelineTx } from "../services/pipeline/db";
import { pipelineWrite } from "../services/pipeline/tx";
import { getPipelineSettings } from "../services/pipeline/settings";
import { enqueueDueSoonEmails, pipelineEmailOn } from "../services/pipeline/email-outbox";
import { ensurePipelineSchemaChecked } from "../services/pipeline/self-check";
import {
  DAYS_LONG,
  clip,
  dayMonth,
  pipelineMeta,
  plnIdSql,
  projectPath,
  quotedTitle,
  recipientFragment,
  shortDay,
} from "../services/pipeline/notify";

const WINDOW_START_MIN = 570; // 09:30 IST
const WINDOW_END_MIN = 1200; // 20:00 IST
const BATCH = 200;
const MAX_BATCHES = 50;
const NOW = Prisma.sql`timezone('utc', now())`;

export type DueTickResult =
  | { status: "skipped"; reason: "running" | "off" | "schema" | "weekend" | "hours" | "busy" }
  | { status: "ran"; dueSoon: number; overdue: number };

let running = false;

interface Claimed {
  id: string;
  title: string;
  due: string;
  phase_name: string | null;
}

type Kind = "due_soon" | "overdue";

async function claimBatch(tx: PipelineTx, kind: Kind, today: string, nextWorking: string): Promise<Claimed[]> {
  const window =
    kind === "due_soon"
      ? (a: string) => Prisma.sql`${Prisma.raw(a)}.due_date > ${today}::date AND ${Prisma.raw(a)}.due_date <= ${nextWorking}::date
          AND ${Prisma.raw(a)}.due_soon_notified_for IS DISTINCT FROM ${Prisma.raw(a)}.due_date`
      : (a: string) => Prisma.sql`${Prisma.raw(a)}.due_date < ${today}::date
          AND ${Prisma.raw(a)}.overdue_notified_for IS DISTINCT FROM ${Prisma.raw(a)}.due_date`;
  const stamp = kind === "due_soon" ? Prisma.sql`due_soon_notified_for` : Prisma.sql`overdue_notified_for`;
  return tx.$queryRaw<Claimed[]>`
    UPDATE pipeline_projects p SET ${stamp} = p.due_date, updated_at = ${NOW}
     WHERE p.id IN (SELECT p2.id FROM pipeline_projects p2
                     WHERE p2.archived_at IS NULL AND p2.deleted_at IS NULL AND ${window("p2")}
                       AND p2.phase_id NOT IN (SELECT id FROM pipeline_phases WHERE is_terminal)
                     ORDER BY p2.id LIMIT ${BATCH}::int
                       FOR UPDATE SKIP LOCKED)
       AND p.archived_at IS NULL AND p.deleted_at IS NULL AND ${window("p")}
       AND p.phase_id NOT IN (SELECT id FROM pipeline_phases WHERE is_terminal)
 RETURNING p.id, p.title, to_char(p.due_date, 'YYYY-MM-DD') AS due,
           (SELECT ph.name FROM pipeline_phases ph WHERE ph.id = p.phase_id) AS phase_name`;
}

/**
 * The row text. ⚠️ ABSOLUTE wording (owner request 2026-10-01): the row is read for up to 90
 * days and mobile shows it verbatim, so "is due tomorrow" would be false from the next day on
 * — "is due Saturday (3 Oct)" stays true. Dates carry their year when it is not `today`'s
 * (notify.ts shortDay / dayMonth). The EMAIL keeps its send-time "due tomorrow" wording.
 */
function textFor(kind: Kind, c: Claimed, today: string): { title: string; message: string } {
  const qt = quotedTitle(c.title);
  const phase = c.phase_name ?? "";
  if (kind === "overdue") {
    return {
      title: clip(`${qt} is overdue — was due ${shortDay(c.due, today)}, still in ${phase}`, 120),
      message: clip(`Phase: ${phase}`, 200),
    };
  }
  const when = `${DAYS_LONG[dayOfWeekIST(c.due)]} (${dayMonth(c.due, today)})`;
  return { title: clip(`${qt} is due ${when}`, 120), message: clip(`Phase: ${phase}`, 200) };
}

async function insertRows(tx: PipelineTx, kind: Kind, claimed: Claimed[], today: string, allow: string[] | null) {
  const rows = claimed.map((c) => {
    const { title, message } = textFor(kind, c, today);
    return { pid: c.id, due: c.due, title, message, meta: pipelineMeta(kind, c.id, { due: c.due }, projectPath(c.id)) };
  });
  await tx.$executeRaw`
    INSERT INTO notifications (id, user_id, type, title, message, read, metadata, created_at)
    SELECT ${plnIdSql(kind, Prisma.sql`t.pid`, Prisma.sql`pp.user_id`, Prisma.sql`t.due`)}, pp.user_id,
           'PIPELINE'::"NotificationType", t.title, t.message, false, t.meta::jsonb, ${NOW}
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS t(pid text, due text, title text, message text, meta text)
      JOIN pipeline_participants pp ON pp.project_id = t.pid AND pp.notify
      JOIN users u ON u.id = pp.user_id
     WHERE ${recipientFragment(Prisma.sql`pp.user_id`, null, allow)}
     ORDER BY t.pid, pp.user_id
    ON CONFLICT (id) DO NOTHING`;
}

async function runKind(kind: Kind, today: string, nextWorking: string, allow: string[] | null, email: boolean): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await pipelineWrite(async (tx) => {
      const claimed = await claimBatch(tx, kind, today, nextWorking);
      if (claimed.length) {
        await insertRows(tx, kind, claimed, today, allow);
        if (email && kind === "due_soon") {
          await enqueueDueSoonEmails(tx, claimed.map((c) => ({ pid: c.id, due: c.due })), allow);
        }
      }
      return claimed.length;
    });
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/** One tick. `now` is injectable for tests. Never throws on an expected skip. */
export function runPipelineDueTick(opts: { now?: Date } = {}): Promise<DueTickResult> {
  if (running) return Promise.resolve({ status: "skipped", reason: "running" });
  running = true; // claimed before the first await
  return (async (): Promise<DueTickResult> => {
    try {
      const now = opts.now ?? new Date();
      const today = dateToIST(now);
      if (!isWorkingDayIST(today)) return { status: "skipped", reason: "weekend" };
      const minutes = istMinutesOfDay(now);
      if (minutes < WINDOW_START_MIN || minutes >= WINDOW_END_MIN) return { status: "skipped", reason: "hours" };
      let settings;
      try {
        settings = await getPipelineSettings();
        if (settings.mode === "off") return { status: "skipped", reason: "off" };
        if (!(await ensurePipelineSchemaChecked())) return { status: "skipped", reason: "schema" };
      } catch {
        return { status: "skipped", reason: "busy" };
      }
      const allow = settings.mode === "pilot" ? [...settings.pilotUserIds] : null;
      const nextWorking = nextWorkingDayIST(today);
      const email = pipelineEmailOn(settings);
      const dueSoon = await runKind("due_soon", today, nextWorking, allow, email);
      const overdue = await runKind("overdue", today, nextWorking, allow, false);
      return { status: "ran", dueSoon, overdue };
    } finally {
      running = false;
    }
  })();
}

/** index.ts: first run 17 minutes after boot, then every 60 minutes. Never throws. */
export function startPipelineDueCron(): void {
  const tick = () => {
    runPipelineDueTick()
      .then((r) => {
        if (r.status === "ran" && r.dueSoon + r.overdue > 0) {
          console.log(`[pipeline-due] notified due-soon=${r.dueSoon} overdue=${r.overdue} project(s)`);
        }
      })
      .catch((err) => console.warn("[pipeline-due] tick failed:", String(err)));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, 60 * 60 * 1000);
  }, 17 * 60 * 1000);
}
