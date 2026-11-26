/**
 * The board card's status line (2026-11-23): what is happening on a campaign without opening it.
 * Pure wording over `PipelineCardSummary` (read in the board snapshot), shared by the sales and
 * HR boards so they never disagree.
 *
 *   - At most TWO parts, in this order of importance: changes requested / waiting for review,
 *     the newest document move ("Pitch sent 2d ago"), pages live ("3/5 pages live"), approved,
 *     then how many files the project holds ("📎 3 files").
 *   - The due date keeps its own chip; `overdueDays` gives it its number ("Overdue 2d").
 *   - The owner's "current status" note is shown under the parts, as written.
 *
 * ⚠️ No regex lookbehind; runs in the HR bundle.
 */
import type { PipelineCardSummary } from "../types/pipeline";
import { relativeAgo } from "./time";

export type CardStatusTone = "danger" | "attention" | "success" | "info" | "muted";

export interface CardStatusPart {
  text: string;
  tone: CardStatusTone;
}

/** Short names for the card ("Pitch", not "Pitch deck"). */
const DOC_SHORT: Record<string, string> = {
  pitch: "Pitch",
  brief: "Brief",
  quote: "Quote",
  report: "Report",
  photo: "Photo",
  other: "Document",
};

const DOC_TONE: Record<string, CardStatusTone> = { sent: "info", accepted: "success", rejected: "danger" };

/** Most this many parts on one card. */
export const CARD_STATUS_MAX_PARTS = 2;

export function cardStatusParts(summary: PipelineCardSummary | undefined | null, nowMs: number): CardStatusPart[] {
  if (!summary) return [];
  const ranked: CardStatusPart[] = [];
  if (summary.review === "changes_requested") ranked.push({ text: "Changes requested", tone: "danger" });
  if (summary.review === "pending") ranked.push({ text: "Waiting for review", tone: "attention" });
  if (summary.doc && DOC_TONE[summary.doc.status]) {
    const at = Date.parse(summary.doc.at);
    const ago = Number.isFinite(at) ? relativeAgo(nowMs - at) : "";
    const what = DOC_SHORT[summary.doc.type] ?? "Document";
    ranked.push({ text: `${what} ${summary.doc.status}${ago ? ` ${ago}` : ""}`, tone: DOC_TONE[summary.doc.status] });
  }
  if (summary.pages && summary.pages.total > 0) {
    const { live, total } = summary.pages;
    ranked.push({ text: `${live}/${total} page${total === 1 ? "" : "s"} live`, tone: live === total ? "success" : "muted" });
  }
  if (summary.review === "approved") ranked.push({ text: "Approved", tone: "success" });
  // Last: a card with nothing else to say still shows that work has started.
  if (summary.files > 0) ranked.push({ text: `📎 ${summary.files} file${summary.files === 1 ? "" : "s"}`, tone: "muted" });
  return ranked.slice(0, CARD_STATUS_MAX_PARTS);
}

/** Whole days a due date is past `todayKey` (both YYYY-MM-DD); 0 when not overdue or unreadable. */
export function overdueDays(dueDate: string | null | undefined, todayKey: string): number {
  if (!dueDate) return 0;
  const a = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${todayKey.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** The note's limit (one line on a card). */
export const STATUS_NOTE_MAX = 140;
