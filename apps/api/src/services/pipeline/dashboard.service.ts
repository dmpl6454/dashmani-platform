/**
 * The Pipeline section of the sales Dashboard (2026-11-23). Shapes and rules:
 * packages/shared/src/pipeline/dashboard.ts.
 *
 * Only live projects count: kind 'project', not archived, not deleted. "Overdue" and "due this
 * week" skip terminal phases. Days are IST (todayIST / addDaysIST), page times compare against
 * the database clock.
 *
 * ⚠️ Pipeline pool only (pipelineRead): one read slot, a few short sequential statements, each
 * bounded by an index on project_id / status and LIMIT. Never aggregates pipeline_messages.
 */
import {
  PIPELINE_DASHBOARD_LIST_MAX as MAX,
  PIPELINE_DASHBOARD_CHATS_MAX as CHATS_MAX,
  PIPELINE_DASHBOARD_CHATS_DAYS as CHATS_DAYS,
  addDaysIST,
  notificationSnippet,
  scanMentionTokens,
  pipelineDocs as D,
  todayIST,
  type PipelineDashboardDto,
} from "@dashmani/shared";
import { pipelineRead } from "./tx";
import { day, ts } from "./wire";
import type { PipelineDirectory } from "./access";

type Row = Record<string, unknown>;

const LIVE = `p.kind = 'project' AND p.archived_at IS NULL AND p.deleted_at IS NULL`;

const DOC_SHORT: Record<string, string> = { pitch: "Pitch", brief: "Brief", quote: "Quote", report: "Report", photo: "Photo", other: "Document" };

export async function getPipelineDashboard(dir: PipelineDirectory): Promise<PipelineDashboardDto> {
  const today = todayIST();
  const weekEnd = addDaysIST(today, 6);
  const r = await pipelineRead(async (db) => {
    const phases = await db.$queryRawUnsafe<Row[]>(`
      SELECT ph.id, ph.name, ph.is_terminal,
             (SELECT count(*)::int FROM pipeline_projects p WHERE p.phase_id = ph.id AND ${LIVE}) AS n
        FROM pipeline_phases ph
       WHERE ph.archived_at IS NULL
       ORDER BY ph.position, ph.id`);
    const overdue = await db.$queryRawUnsafe<Row[]>(
      `SELECT p.id, p.title, p.due_date, ph.name AS phase_name, count(*) OVER ()::int AS total
         FROM pipeline_projects p JOIN pipeline_phases ph ON ph.id = p.phase_id
        WHERE ${LIVE} AND NOT ph.is_terminal AND p.due_date < $1::date
        ORDER BY p.due_date, p.id LIMIT ${MAX}`,
      today,
    );
    const client = await db.$queryRawUnsafe<Row[]>(
      `SELECT p.id, p.title, d.type, d.title AS doc_title, d.status_changed_at, count(*) OVER ()::int AS total
         FROM pipeline_documents d JOIN pipeline_projects p ON p.id = d.project_id
        WHERE ${LIVE} AND d.status = 'sent'
        ORDER BY d.status_changed_at, d.id LIMIT ${MAX}`,
    );
    const reviews = await db.$queryRawUnsafe<Row[]>(
      `SELECT p.id, p.title, r.reviewer_id, r.created_at, count(*) OVER ()::int AS total
         FROM pipeline_reviews r JOIN pipeline_projects p ON p.id = r.project_id
        WHERE ${LIVE} AND r.status = 'pending'
        ORDER BY r.created_at, r.id LIMIT ${MAX}`,
    );
    // From the start of today (IST) to the end of the 7th day.
    const pages = await db.$queryRawUnsafe<Row[]>(
      `SELECT p.id, p.title, x.platform, x.destination, x.scheduled_at, count(*) OVER ()::int AS total
         FROM pipeline_deliverables x JOIN pipeline_projects p ON p.id = x.project_id
        WHERE ${LIVE} AND x.status NOT IN ('published', 'cancelled')
          AND x.scheduled_at >= ($1::date - interval '330 minutes')
          AND x.scheduled_at <  ($2::date + interval '1 day' - interval '330 minutes')
        ORDER BY x.scheduled_at, x.id LIMIT ${MAX * 2}`,
      today,
      weekEnd,
    );
    const due = await db.$queryRawUnsafe<Row[]>(
      `SELECT p.id, p.title, p.due_date, count(*) OVER ()::int AS total
         FROM pipeline_projects p JOIN pipeline_phases ph ON ph.id = p.phase_id
        WHERE ${LIVE} AND NOT ph.is_terminal AND p.due_date BETWEEN $1::date AND $2::date
        ORDER BY p.due_date, p.id LIMIT ${MAX * 2}`,
      today,
      weekEnd,
    );
    // Latest from chats: per live project, the conversation that spoke last (its own thread or a
    // PUBLIC campaign channel — never a private one), then that conversation's newest live
    // message. Only conversations that spoke in the last ${CHATS_DAYS} days are considered, so
    // the message probes (pipeline_messages (project_id, seq), one LIMIT 1 each) scale with
    // recent chat activity, not with the number of projects; nothing aggregates the messages table.
    const chats = await db.$queryRawUnsafe<Row[]>(
      `WITH recent AS (
         SELECT DISTINCT ON (s.root) s.root, s.conv_id, s.kind, s.conv_title
           FROM (SELECT CASE WHEN x.kind = 'project' THEN x.id ELSE x.parent_project_id END AS root,
                        x.id AS conv_id, x.kind, x.title AS conv_title, x.last_message_at
                   FROM pipeline_projects x
                  WHERE x.last_message_at > timezone('utc', now()) - interval '${CHATS_DAYS} days'
                    AND x.deleted_at IS NULL AND x.archived_at IS NULL
                    AND (x.kind = 'project'
                         OR (x.kind = 'channel' AND NOT x.is_private AND x.parent_project_id IS NOT NULL))) s
          ORDER BY s.root, s.last_message_at DESC, s.conv_id)
       SELECT p.id, p.title, c.conv_id, c.kind, c.conv_title, m.message_id, m.body, m.author_id, m.created_at
         FROM recent c
         JOIN pipeline_projects p ON p.id = c.root
         JOIN LATERAL (
           SELECT m.id AS message_id, m.body, m.author_id, m.created_at
             FROM pipeline_messages m
            WHERE m.project_id = c.conv_id AND m.deleted_at IS NULL
            ORDER BY m.seq DESC LIMIT 1) m ON true
        WHERE ${LIVE}
        ORDER BY m.created_at DESC, p.id LIMIT ${CHATS_MAX}`,
    );
    return { phases, overdue, client, reviews, pages, due, chats };
  });

  const total = (rows: Row[]) => Number(rows[0]?.total ?? 0);
  const project = (x: Row) => ({ id: String(x.id), title: String(x.title) });
  const platform = (p: unknown) => {
    const s = String(p ?? "");
    return s === "x" ? "X" : s ? s[0].toUpperCase() + s.slice(1) : "Page";
  };

  const thisWeek: PipelineDashboardDto["thisWeek"] = [
    ...r.pages.map((x) => ({
      kind: "page" as const,
      project: project(x),
      label: `${platform(x.platform)} · ${String(x.destination)}`,
      at: ts(x.scheduled_at) ?? "",
    })),
    ...r.due.map((x) => ({ kind: "due" as const, project: project(x), label: "Project due", day: day(x.due_date) ?? "" })),
  ]
    // Pages by time, due days at the start of their day (IST midnight = 18:30 UTC the day before).
    .sort((a, b) => sortKey(a) - sortKey(b))
    .slice(0, MAX);

  const msPerDay = 86_400_000;
  return {
    today,
    phases: r.phases.map((x) => ({ id: String(x.id), name: String(x.name), isTerminal: x.is_terminal === true, count: Number(x.n) })),
    counts: {
      active: r.phases.filter((x) => x.is_terminal !== true).reduce((s, x) => s + Number(x.n), 0),
      overdue: total(r.overdue),
      waitingClient: total(r.client),
      waitingReview: total(r.reviews),
      thisWeek: total(r.pages) + total(r.due),
    },
    overdue: r.overdue.map((x) => {
      const dueDate = day(x.due_date) ?? "";
      return {
        ...project(x),
        dueDate,
        days: Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / msPerDay)),
        phaseName: String(x.phase_name),
      };
    }),
    waitingClient: r.client.map((x) => ({
      project: project(x),
      docType: DOC_SHORT[String(x.type)] ?? D.PIPELINE_DOC_TYPE_LABEL[x.type as D.PipelineDocType] ?? "Document",
      docTitle: String(x.doc_title),
      since: ts(x.status_changed_at) ?? "",
    })),
    waitingReview: r.reviews.map((x) => ({
      project: project(x),
      reviewer: dir.byId.get(String(x.reviewer_id))?.name ?? "Former member",
      since: ts(x.created_at) ?? "",
    })),
    thisWeek,
    latestChats: r.chats.map((x) => {
      const body = String(x.body ?? "");
      const names = new Map(scanMentionTokens(body).map((t) => [t.id, dir.byId.get(t.id)?.name ?? "someone"]));
      return {
        project: project(x),
        conversationId: String(x.conv_id),
        channel: x.kind === "channel" ? String(x.conv_title) : null,
        messageId: String(x.message_id),
        author: dir.byId.get(String(x.author_id))?.name ?? "Former member",
        text: notificationSnippet(body, names, 160),
        at: ts(x.created_at) ?? "",
      };
    }),
  };
}

function sortKey(x: PipelineDashboardDto["thisWeek"][number]): number {
  return x.kind === "page" ? Date.parse(x.at) : Date.parse(`${x.day}T00:00:00+05:30`);
}
