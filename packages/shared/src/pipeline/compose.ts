/**
 * Composer rules (spec §9.6): mention ranges, draft serialisation and Enter-to-send.
 *
 * Mentions are stored as POSITIONAL RANGES `{start, end, userId, label}` over the
 * composer's plain text. They shift when text before them changes and are dropped when
 * their own text changes. Only ranges serialise to `@{id}`; any literal "@{" the user
 * typed or pasted is neutralised, so pasted text can never become a mention.
 *
 * Linear and lookbehind-free (it runs on every keystroke in the HR bundle).
 */
import { scanMentionTokens } from "./mentions";

export interface MentionRange {
  start: number;
  end: number;
  userId: string;
  /** The exact text the range covers, e.g. "@Aisha Khan". */
  label: string;
}

/** Zero-width space inserted between "@" and "{" in plain text (see serializeDraft). */
export const MENTION_NEUTRALIZER = "​";

/**
 * Re-map ranges across one edit (prevText → nextText). The edit is found by common
 * prefix / suffix, so it works for typing, deleting, pasting and IME commits alike.
 */
export function shiftRanges(ranges: readonly MentionRange[], prevText: string, nextText: string): MentionRange[] {
  if (prevText === nextText || ranges.length === 0) return ranges.slice();
  const maxP = Math.min(prevText.length, nextText.length);
  let p = 0;
  while (p < maxP && prevText.charCodeAt(p) === nextText.charCodeAt(p)) p++;
  let s = 0;
  const maxS = Math.min(prevText.length, nextText.length) - p;
  while (s < maxS && prevText.charCodeAt(prevText.length - 1 - s) === nextText.charCodeAt(nextText.length - 1 - s)) s++;
  const oldEnd = prevText.length - s;
  const delta = nextText.length - prevText.length;
  const out: MentionRange[] = [];
  for (const r of ranges) {
    let next: MentionRange | null = null;
    if (r.end <= p) next = r;
    else if (r.start >= oldEnd) next = { ...r, start: r.start + delta, end: r.end + delta };
    if (next && nextText.slice(next.start, next.end) === next.label) out.push(next);
  }
  return out;
}

export interface MentionTrigger {
  /** Index of the "@". */
  start: number;
  /** Text typed after the "@" up to the caret. */
  query: string;
}

/** Characters scanned backwards from the caret looking for the trigger "@". */
export const MENTION_TRIGGER_WINDOW = 30;

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0;
}

/**
 * The "@" that opens a mention query: scanning back from the caret (≤ 30 chars, never
 * across a newline) for an "@" at the start of the text or right after whitespace, and
 * not inside an existing mention range.
 */
export function findMentionTrigger(text: string, caret: number, ranges: readonly MentionRange[] = []): MentionTrigger | null {
  const stop = Math.max(0, caret - MENTION_TRIGGER_WINDOW);
  for (let i = caret - 1; i >= stop; i--) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) return null;
    if (c !== 64 /* @ */) continue;
    if (i > 0 && !isSpace(text.charCodeAt(i - 1))) continue;
    if (ranges.some((r) => i >= r.start && i < r.end)) return null;
    const query = text.slice(i + 1, caret);
    if (query.startsWith(" ")) return null;
    return { start: i, query };
  }
  return null;
}

/** Replace the trigger query with "@Name " and record its range. */
export function insertMention(
  text: string,
  ranges: readonly MentionRange[],
  trigger: MentionTrigger,
  caret: number,
  user: { id: string; name: string },
): { text: string; ranges: MentionRange[]; caret: number } {
  const label = `@${user.name}`;
  const before = text.slice(0, trigger.start);
  const after = text.slice(caret);
  const insert = `${label} `;
  const nextText = before + insert + after;
  const removed = caret - trigger.start;
  const delta = insert.length - removed;
  const kept: MentionRange[] = [];
  for (const r of ranges) {
    if (r.end <= trigger.start) kept.push(r);
    else if (r.start >= caret) kept.push({ ...r, start: r.start + delta, end: r.end + delta });
  }
  kept.push({ start: trigger.start, end: trigger.start + label.length, userId: user.id, label });
  kept.sort((a, b) => a.start - b.start);
  return { text: nextText, ranges: kept, caret: trigger.start + insert.length };
}

/** Neutralise every literal "@{" so the server never parses pasted text as a mention. */
function neutralize(plain: string): string {
  return plain.split("@{").join(`@${MENTION_NEUTRALIZER}{`);
}

/**
 * The wire body: each range becomes `@{userId}`; everything else is plain text with any
 * literal "@{" neutralised. Also the stored draft form, so a restored draft keeps mentions.
 */
export function serializeDraft(text: string, ranges: readonly MentionRange[]): string {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos || text.slice(r.start, r.end) !== r.label) continue;
    out += neutralize(text.slice(pos, r.start)) + `@{${r.userId}}`;
    pos = r.end;
  }
  return out + neutralize(text.slice(pos));
}

/** Inverse of serializeDraft: `@{id}` → "@Name" plus its range. */
export function parseDraft(serialized: string, nameOf: (id: string) => string): { text: string; ranges: MentionRange[] } {
  let text = "";
  const ranges: MentionRange[] = [];
  let pos = 0;
  for (const t of scanMentionTokens(serialized)) {
    text += serialized.slice(pos, t.start);
    const label = `@${nameOf(t.id)}`;
    ranges.push({ start: text.length, end: text.length + label.length, userId: t.id, label });
    text += label;
    pos = t.end;
  }
  return { text: text + serialized.slice(pos), ranges };
}

export interface EnterKeyLike {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export interface InputEnv {
  /** matchMedia('(pointer:fine)').matches */
  finePointer: boolean;
  /** navigator.maxTouchPoints — > 0 on every touch device, including iPhone Desktop Site mode. */
  maxTouchPoints: number;
}

/**
 * Enter sends only on a real keyboard-and-mouse device: never on touch (including an
 * iPhone in Desktop Site mode, which reports a fine pointer but maxTouchPoints > 0),
 * never with Shift, never during IME composition (isComposing / keyCode 229).
 */
export function shouldEnterSend(e: EnterKeyLike, env: InputEnv): boolean {
  return (
    e.key === "Enter" &&
    env.finePointer &&
    env.maxTouchPoints === 0 &&
    !e.shiftKey &&
    !e.isComposing &&
    e.keyCode !== 229
  );
}

export type ComposerLengthState = "ok" | "counter" | "over";

/** The counter shows above `counterFrom`; anything over `max` is an error (never truncated). */
export function composerLengthState(length: number, limits: { bodyCounterFrom: number; bodyMax: number }): ComposerLengthState {
  if (length > limits.bodyMax) return "over";
  if (length > limits.bodyCounterFrom) return "counter";
  return "ok";
}
