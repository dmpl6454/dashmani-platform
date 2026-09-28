/**
 * Pipeline constants shared by the API and the HR portal (spec §3.4, §3.5, §4, §5).
 * Runtime values live here; the wire types in types/pipeline.ts derive from them.
 */

/** The fixed 8-emoji reaction palette (spec §3.5, §14 Q9). Order is display order. */
export const PIPELINE_REACTION_KEYS = [
  "thumbs_up",
  "heart",
  "laugh",
  "party",
  "eyes",
  "check",
  "pray",
  "fire",
] as const;

export type PipelineReactionKey = (typeof PIPELINE_REACTION_KEYS)[number];

export const PIPELINE_REACTION_EMOJI: Readonly<Record<PipelineReactionKey, string>> = {
  thumbs_up: "👍",
  heart: "❤️",
  laugh: "😂",
  party: "🎉",
  eyes: "👀",
  check: "✅",
  pray: "🙏",
  fire: "🔥",
};

/** Participant roles. Ownership lives only in `pipeline_projects.owner_id`, never here. */
export const PIPELINE_PARTICIPANT_ROLES = ["MEMBER", "FOLLOWER"] as const;
export type PipelineParticipantRole = (typeof PIPELINE_PARTICIPANT_ROLES)[number];

/** Values of the `pipeline.mode` system setting. An absent row means "off". */
export const PIPELINE_MODES = ["off", "pilot", "on"] as const;
export type PipelineMode = (typeof PIPELINE_MODES)[number];

/**
 * Size limits. The validators enforce the input ones; the server enforces the rest.
 * Bootstrap sends this object so the composer counter and pickers never disagree
 * with the API.
 */
export const PIPELINE_LIMITS = {
  /** Raw title length accepted before any transform (the quadratic-guard bound). */
  titleRawMax: 240,
  titleMax: 120,
  descriptionMax: 5000,
  bodyMax: 4000,
  /** The composer shows a counter above this many characters. */
  bodyCounterFrom: 3600,
  mentionsMax: 20,
  /** Per create or add-members request. */
  membersPerRequestMax: 20,
  participantsMax: 200,
  /** Board snapshot cap per phase (§5.3). */
  cardsPerPhase: 100,
  messagesPageDefault: 30,
  messagesPageMax: 50,
  listPageMax: 30,
  seenIdsMax: 50,
  directoryNameMax: 60,
  /** Days a soft-deleted project can be restored (§4.5). */
  restoreWindowDays: 30,
  /** Minutes the adder may undo an add (§4.6). */
  undoAddMinutes: 10,
} as const;

export type PipelineLimits = typeof PIPELINE_LIMITS;

/** Default poll intervals in ms (§5.5). `pipeline.pollMs` can stretch them with no deploy. */
export const PIPELINE_DEFAULT_POLL_MS = {
  project: 10_000,
  projectBg: 20_000,
  board: 15_000,
  boardBg: 30_000,
  idle: 30_000,
} as const;
