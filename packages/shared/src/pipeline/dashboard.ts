/**
 * The Pipeline section of the sales Dashboard (2026-11-23): one screen for managers.
 * GET /pipeline/dashboard (apps/api/src/services/pipeline/dashboard.service.ts).
 *
 *   phases         live projects per phase, in board order
 *   overdue        due date passed, not in a terminal phase — oldest first
 *   waitingClient  documents marked Sent with no answer yet — longest waiting first
 *   waitingReview  review requests still pending — oldest first
 *   thisWeek       pages scheduled in the next 7 days (not live / cancelled) and projects due in
 *                  the next 7 days — soonest first
 * Each list holds at most PIPELINE_DASHBOARD_LIST_MAX rows; `counts` has the full totals.
 */

export const PIPELINE_DASHBOARD_LIST_MAX = 5;

export interface PipelineDashboardProject {
  id: string;
  title: string;
}

export interface PipelineDashboardDto {
  /** The IST day the numbers are for (YYYY-MM-DD). */
  today: string;
  phases: Array<{ id: string; name: string; isTerminal: boolean; count: number }>;
  counts: { active: number; overdue: number; waitingClient: number; waitingReview: number; thisWeek: number };
  overdue: Array<PipelineDashboardProject & { dueDate: string; days: number; phaseName: string }>;
  waitingClient: Array<{ project: PipelineDashboardProject; docType: string; docTitle: string; since: string }>;
  waitingReview: Array<{ project: PipelineDashboardProject; reviewer: string; since: string }>;
  thisWeek: Array<
    | { kind: "page"; project: PipelineDashboardProject; label: string; at: string }
    | { kind: "due"; project: PipelineDashboardProject; label: string; day: string }
  >;
  /**
   * "Latest from chats" (2026-11-23): the newest message of each live project — its own thread or
   * one of its PUBLIC campaign channels, whichever spoke last — newest first, at most
   * PIPELINE_DASHBOARD_CHATS_MAX. The text is the plain-text snippet (mentions as "@Name", files
   * as "📎 1 file"). No AI, no cost: it is the message itself.
   */
  latestChats: Array<{
    project: PipelineDashboardProject;
    /** The conversation the message is in: the project itself, or a channel ("#shoot-day"). */
    conversationId: string;
    channel: string | null;
    messageId: string;
    author: string;
    text: string;
    at: string;
  }>;
}

export const PIPELINE_DASHBOARD_CHATS_MAX = 8;
/** "Latest from chats" considers only conversations that spoke within this many days. */
export const PIPELINE_DASHBOARD_CHATS_DAYS = 30;
