/**
 * `@{<uuid>}` mention tokens in pipeline message bodies (spec §3.5 "Mentions").
 *
 * The composer serialises only the people the user actually PICKED into `@{id}` tokens
 * (pasted text is never tokenised), so the server can trust a token's shape but never its
 * target: the ids returned here are then filtered in SQL to ACTIVE and pickable users,
 * and only the delivered ones are stored in `mention_ids`.
 *
 * ⚠️ LINEAR BY CONSTRUCTION. This runs on every send and edit, on the API main thread,
 * over user-controlled text of up to 4,000 characters (and is exercised at 1 MB in tests).
 * It is an indexOf scan with a fixed 36-character check per candidate: no backtracking
 * regex, no lookbehind (it also ships in the HR bundle, and older iOS Safari throws on
 * lookbehind at parse time).
 */

/** Unique mentioned users per message (spec §3.5). */
export const MAX_MENTIONS = 20;

/** Thrown when a body mentions more than MAX_MENTIONS distinct users (400 MENTION_LIMIT). */
export class MentionLimitError extends Error {
  readonly code = "MENTION_LIMIT" as const;
  constructor(readonly count: number) {
    super(`A message can mention at most ${MAX_MENTIONS} people`);
    this.name = "MentionLimitError";
  }
}

const UUID_LENGTH = 36;

function isLowerHex(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102); // 0-9, a-f
}

/**
 * True when `s[start .. start+36)` is a lowercase canonical UUID (8-4-4-4-12). Ids in
 * this database are lowercase; an uppercase token did not come from the composer and is
 * treated as plain text.
 */
function isUuidAt(s: string, start: number): boolean {
  if (start + UUID_LENGTH > s.length) return false;
  for (let i = 0; i < UUID_LENGTH; i++) {
    const c = s.charCodeAt(start + i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== 45) return false; // "-"
    } else if (!isLowerHex(c)) {
      return false;
    }
  }
  return true;
}

export interface MentionToken {
  /** Index of the "@". */
  start: number;
  /** Index just past the "}". */
  end: number;
  id: string;
}

/**
 * Every well-formed `@{uuid}` token in order, duplicates included. Malformed tokens are
 * skipped (they render as plain text). Shared by extractMentionIds and the snippet
 * renderer so both agree on exactly what a token is.
 */
export function scanMentionTokens(body: string): MentionToken[] {
  const out: MentionToken[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf("@{", from);
    if (at < 0) break;
    const idStart = at + 2;
    const close = idStart + UUID_LENGTH;
    if (close < body.length && body.charCodeAt(close) === 125 /* } */ && isUuidAt(body, idStart)) {
      out.push({ start: at, end: close + 1, id: body.slice(idStart, close) });
      from = close + 1;
    } else {
      from = at + 1;
    }
  }
  return out;
}

/**
 * The unique mentioned user ids, in first-seen order.
 * @throws MentionLimitError when more than MAX_MENTIONS distinct ids are present.
 */
export function extractMentionIds(body: string): string[] {
  const seen = new Set<string>();
  for (const t of scanMentionTokens(body)) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (seen.size > MAX_MENTIONS) throw new MentionLimitError(seen.size);
  }
  return [...seen];
}
