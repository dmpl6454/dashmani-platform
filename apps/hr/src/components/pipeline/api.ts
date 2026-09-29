/**
 * Typed calls for the 21 pipeline routes (spec §3.4). Every call goes through the HR
 * `apiFetch` (hrAccessToken + single-flight refresh) — never a local fetch helper.
 * Errors surface as ApiError with `status`, `code` and `retryAfterSec`; the UI turns
 * them into words with `describeError` and never shows a raw server message.
 */
import type {
  PipelineAddMembersResponse,
  PipelineArchiveResponse,
  PipelineCreateProjectRequest,
  PipelineCreateProjectResponse,
  PipelineDeleteMessageResponse,
  PipelineDeleteProjectResponse,
  PipelineEditMessageResponse,
  PipelineEditProjectRequest,
  PipelineFollowResponse,
  PipelineHeaderResponse,
  PipelineListView,
  PipelineMessagesPage,
  PipelineMoveRequest,
  PipelineMoveResponse,
  PipelinePostMessageRequest,
  PipelinePostMessageResponse,
  PipelineProjectDetail,
  PipelineProjectListResponse,
  PipelineReactionKey,
  PipelineReactionResponse,
  PipelineReadResponse,
  PipelineRemoveMemberResponse,
  PipelineRepliesPage,
  PipelineSyncRequest,
  PipelineSyncResponse,
} from "@dashmani/shared";
import { apiFetch, ApiError } from "@/lib/api";

type Env<T> = { success: true; data: T };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const env = await apiFetch<Env<T>>(`/pipeline${path}`, init);
  return env.data;
}

const json = (method: string, body: unknown, extra: RequestInit = {}): RequestInit => ({
  method,
  body: JSON.stringify(body ?? {}),
  ...extra,
});

const SYNC_TIMEOUT_MS = 20_000;

export async function postSync(req: PipelineSyncRequest, signal?: AbortSignal): Promise<PipelineSyncResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SYNC_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    return await call<PipelineSyncResponse>("/sync", json("POST", req, { signal: ctl.signal }));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export const plApi = {
  listProjects: (view: PipelineListView, cursor: string | null, limit = 20) =>
    call<PipelineProjectListResponse>(
      `/projects?view=${view}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  createProject: (body: PipelineCreateProjectRequest) =>
    call<PipelineCreateProjectResponse>("/projects", json("POST", body)),
  getProject: (id: string, around?: string | null) =>
    call<PipelineProjectDetail>(`/projects/${id}${around ? `?around=${encodeURIComponent(around)}` : ""}`),
  editProject: (id: string, body: PipelineEditProjectRequest) =>
    call<PipelineHeaderResponse>(`/projects/${id}`, json("PATCH", body)),
  moveProject: (id: string, body: PipelineMoveRequest) =>
    call<PipelineMoveResponse>(`/projects/${id}/move`, json("POST", body)),
  archive: (id: string) => call<PipelineArchiveResponse>(`/projects/${id}/archive`, json("POST", {})),
  unarchive: (id: string) => call<PipelineArchiveResponse>(`/projects/${id}/unarchive`, json("POST", {})),
  restore: (id: string) => call<PipelineArchiveResponse>(`/projects/${id}/restore`, json("POST", {})),
  deleteProject: (id: string, confirmTitle: string) =>
    call<PipelineDeleteProjectResponse>(`/projects/${id}`, json("DELETE", { confirmTitle })),
  transferOwner: (id: string, userId: string) =>
    call<PipelineHeaderResponse>(`/projects/${id}/owner`, json("PUT", { userId })),
  addMembers: (id: string, userIds: string[]) =>
    call<PipelineAddMembersResponse>(`/projects/${id}/members`, json("POST", { userIds })),
  removeMember: (id: string, userId: string) =>
    call<PipelineRemoveMemberResponse>(`/projects/${id}/members/${userId}`, { method: "DELETE" }),
  follow: (id: string, following: boolean) =>
    call<PipelineFollowResponse>(`/projects/${id}/follow`, json("PUT", { following })),
  olderMessages: (id: string, before: number, limit = 30) =>
    call<PipelineMessagesPage>(`/projects/${id}/messages?before=${before}&limit=${limit}`),
  replies: (mid: string, after: number | null, limit = 50) =>
    call<PipelineRepliesPage>(`/messages/${mid}/replies?limit=${limit}${after !== null ? `&after=${after}` : ""}`),
  postMessage: (id: string, body: PipelinePostMessageRequest) =>
    call<PipelinePostMessageResponse>(`/projects/${id}/messages`, json("POST", body)),
  editMessage: (mid: string, body: string) =>
    call<PipelineEditMessageResponse>(`/messages/${mid}`, json("PATCH", { body })),
  deleteMessage: (mid: string) => call<PipelineDeleteMessageResponse>(`/messages/${mid}`, { method: "DELETE" }),
  react: (mid: string, emoji: PipelineReactionKey, on: boolean) =>
    call<PipelineReactionResponse>(`/messages/${mid}/reactions/${emoji}`, json("PUT", { on })),
  /** Keepalive: used on leave / hide, when the page may be going away. */
  markRead: (id: string, seq: number, leaving: boolean) =>
    call<PipelineReadResponse>(`/projects/${id}/read`, json("POST", { seq, leaving }, { keepalive: true })),
};

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Transient = worth retrying with the same idempotency key: network, 5xx, 503. */
export function isTransient(e: unknown): boolean {
  if (!isApiError(e)) return true;
  const s = e.status ?? 0;
  return s === 0 || s >= 500;
}

export function isRateLimited(e: unknown): boolean {
  return isApiError(e) && e.status === 429;
}

export function retryAfterMs(e: unknown, fallbackSec = 10): number {
  const sec = isApiError(e) && typeof e.retryAfterSec === "number" && e.retryAfterSec > 0 ? e.retryAfterSec : fallbackSec;
  return sec * 1000;
}

const WORDS: Record<string, string> = {
  PIPELINE_DISABLED: "Pipeline is paused right now.",
  PIPELINE_NOT_IN_PILOT: "Pipeline isn't available for your account yet.",
  ACCOUNT_INACTIVE: "Your account is inactive.",
  FORBIDDEN: "You don't have access to this.",
  VALIDATION_ERROR: "Some details need fixing.",
  PAYLOAD_TOO_LARGE: "That's too long to save.",
  DATE_ORDER: "The start date must be on or before the due date.",
  MENTION_LIMIT: "You can mention up to 20 people in one message.",
  PROJECT_NOT_FOUND: "This project no longer exists.",
  PROJECT_DELETED: "This project was deleted.",
  MESSAGE_NOT_FOUND: "That message is no longer available.",
  PHASE_NOT_FOUND: "That phase no longer exists — pick another.",
  NOT_OWNER_OR_ADMIN: "Only the owner or an admin can do that.",
  REMOVED_BY_ADMIN: "An admin did this, so only an admin can undo it.",
  NOT_AUTHOR: "Only the author can change this message.",
  CANNOT_REMOVE_MEMBER: "You can't remove this person.",
  EDIT_CONFLICT: "Someone else changed this while you were editing.",
  MOVE_CONFLICT: "Someone else just moved this project.",
  PROJECT_ARCHIVED: "This project is archived, so it's read-only.",
  PHASE_ARCHIVED: "That phase was archived — pick another.",
  MESSAGE_DELETED: "That message was deleted.",
  MEMBER_NOT_PICKABLE: "One of the people you picked can't be added right now.",
  USER_NOT_PICKABLE: "That person can't be made owner right now.",
  MEMBER_LIMIT: "This project has reached its member limit.",
  OWNER_CANNOT_BE_REMOVED: "The owner can't be removed — transfer ownership first.",
  RESTORE_WINDOW_PASSED: "It's more than 30 days since this was deleted, so it can't be restored.",
  CONFIRM_MISMATCH: "The title you typed doesn't match.",
};

/** Human words for an error. Never the raw server message; never "Something went wrong". */
export function describeError(e: unknown): string {
  if (!isApiError(e)) return "Couldn't reach the server — check your connection and try again.";
  if (e.status === 429) {
    const sec = Math.max(1, Math.round(retryAfterMs(e) / 1000));
    return `Slowed down for a moment — try again in ${sec} s.`;
  }
  if (e.code && WORDS[e.code]) return WORDS[e.code];
  const s = e.status ?? 0;
  if (s === 0) return "Couldn't reach the server — check your connection and try again.";
  if (s === 503 || e.code === "PIPELINE_BUSY") return "The server is busy — try again in a few seconds.";
  if (s >= 500) return "The server had a problem — try again in a moment.";
  return "That didn't work — please try again.";
}
