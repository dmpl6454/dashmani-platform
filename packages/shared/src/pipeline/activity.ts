/**
 * A project's activity timeline (2026-11-24): what happened, in order, outside the chat.
 * Rows live in pipeline_activity (apps/api/src/services/pipeline/activity.service.ts); this file
 * holds the wire shape and the ONE wording both portals show.
 *
 * `data` keeps the names as they were when it happened (phase names, document titles), so a later
 * rename never rewrites history.
 */

export const PIPELINE_ACTIVITY_KINDS = [
  "created",
  "moved",
  "doc_added",
  "doc_status",
  "doc_deleted",
  "review_requested",
  "review_decided",
  "page_published",
  "note",
  "version_added",
] as const;
export type PipelineActivityKind = (typeof PIPELINE_ACTIVITY_KINDS)[number];

export const PIPELINE_ACTIVITY_LIST_MAX = 100;

export interface PipelineActivityItem {
  id: string;
  kind: PipelineActivityKind;
  actor: { id: string; name: string } | null;
  at: string;
  /** The sentence to show, without the actor ("moved it from Brief to Planning"). */
  text: string;
  /** A link to open (a published page's live link, a document link), when there is one. */
  href: string | null;
}

export interface PipelineActivityDto {
  items: PipelineActivityItem[];
}

const DOC: Record<string, string> = { pitch: "pitch deck", brief: "brief", quote: "quote", report: "report", photo: "photo", other: "document" };
const STATUS: Record<string, string> = { draft: "draft", sent: "sent", accepted: "accepted", rejected: "rejected" };
const KIND: Record<string, string> = { video: "video", caption: "caption", thumbnail: "thumbnail", other: "file" };
const PLATFORM: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", snapchat: "Snapchat", x: "X", other: "a page" };

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const q = (v: unknown): string => (s(v) ? `“${s(v)}”` : "");

/** The sentence for one row. Unknown kinds / missing fields still read sensibly. */
export function activityText(kind: string, data: Record<string, unknown>, names: (id: string) => string | null = () => null): string {
  switch (kind) {
    case "created":
      return s(data.phase) ? `created the project in ${s(data.phase)}` : "created the project";
    case "moved":
      return `moved it from ${s(data.from) || "a phase"} to ${s(data.to) || "a phase"}`;
    case "doc_added": {
      const what = `${DOC[s(data.type)] ?? "document"} ${q(data.title)}`.trim();
      if (data.via === "chat") return `shared ${what} in the chat`;
      return s(data.status) && data.status !== "draft" ? `added ${what} as ${STATUS[s(data.status)] ?? s(data.status)}` : `added ${what}`;
    }
    case "doc_status":
      return `marked ${`${DOC[s(data.type)] ?? "document"} ${q(data.title)}`.trim()} as ${STATUS[s(data.status)] ?? s(data.status)}`;
    case "doc_deleted":
      return `deleted ${`${DOC[s(data.type)] ?? "document"} ${q(data.title)}`.trim()}`;
    case "review_requested": {
      const who = s(data.reviewerId) ? names(s(data.reviewerId)) : null;
      return who ? `asked ${who} to review` : "asked for a review";
    }
    case "review_decided":
      return data.decision === "approved" ? "approved the review" : "asked for changes";
    case "page_published":
      return `went live on ${PLATFORM[s(data.platform)] ?? "a page"}${s(data.destination) ? ` · ${s(data.destination)}` : ""}`;
    case "note":
      return s(data.text) ? `set the status: ${q(data.text)}` : "cleared the status note";
    case "version_added":
      return `added ${KIND[s(data.kind)] ?? "file"} v${Number(data.number) || 1}`;
    default:
      return "updated the project";
  }
}
