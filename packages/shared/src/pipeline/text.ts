/**
 * Text hygiene for the pipeline (spec §3.5 validators, §7.9 snippets).
 *
 * Shared by the API (validators, notification text) and the HR bundle, so:
 *   - every function is linear in its input — the only regexes are single character
 *     classes, which cannot backtrack;
 *   - no regex lookbehind anywhere (older iOS Safari throws at PARSE time);
 *   - nothing here builds HTML: bodies and descriptions are rendered as React text only.
 */
import { scanMentionTokens } from "./mentions";

/**
 * Bidirectional-override and isolate controls that can visually reorder text (spoofed
 * names, disguised links): U+202A–202E, U+2066–2069, U+200E/200F and U+061C.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/** C0 controls except TAB (U+0009) and LF (U+000A). */
const C0_EXCEPT_TAB_LF = /[\u0000-\u0008\u000B-\u001F]/g;

/** Every C0 control and DEL — none belongs in a single-line field such as a title. */
const LINE_CONTROLS = /[\u0000-\u001F\u007F]/g;

export function stripBidi(s: string): string {
  return s.replace(BIDI_CONTROLS, "");
}

/**
 * Description and message bodies: lone surrogates → U+FFFD, NFC, CRLF → LF, C0 controls
 * stripped (TAB and LF kept), bidi controls stripped, trimmed. Never tag-strips: these
 * fields are user text rendered only as text, and `safeString` would silently delete
 * anything between `<` and `>`. Callers MUST bound the length before calling (the
 * validators do).
 *
 * ⚠️ The surrogate and NUL handling is what keeps these fields STORABLE: Postgres text
 * rejects NUL (SQLSTATE 22021) and Prisma cannot serialise a lone surrogate at all — both
 * would otherwise surface as an unrecognised error (500) instead of a clean 400. A
 * composer that cuts an emoji pair at the length limit produces a lone surrogate.
 */
export function normalizeText(s: string): string {
  return toWellFormed(s)
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(C0_EXCEPT_TAB_LF, "")
    .replace(BIDI_CONTROLS, "")
    .trim();
}

/**
 * Single-line fields (titles, the delete confirmation): lone surrogates → U+FFFD, bidi
 * controls stripped, and every C0 control and DEL — NUL, TAB, CR, LF — replaced by a space.
 * Linear; callers MUST bound the length first. Does not trim or tag-strip (the title
 * validator pipes the result into `safeString`, which does both).
 */
export function cleanLine(s: string): string {
  return toWellFormed(stripBidi(s)).replace(LINE_CONTROLS, " ");
}

/** Replace unpaired UTF-16 surrogates with U+FFFD (a lone surrogate cannot be stored or rendered). */
export function toWellFormed(s: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // a valid pair
        continue;
      }
    } else if (!(c >= 0xdc00 && c <= 0xdfff)) {
      continue;
    }
    out += s.slice(last, i) + "�";
    last = i + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
let graphemeSegmenter: Segmenter | null | undefined;

function getSegmenter(): Segmenter | null {
  if (graphemeSegmenter === undefined) {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
    graphemeSegmenter = typeof Seg === "function" ? new Seg(undefined, { granularity: "grapheme" }) : null;
  }
  return graphemeSegmenter;
}

/**
 * Truncate to at most `max` user-perceived characters (grapheme clusters), counting the
 * trailing "…" when one is added. Never splits an emoji sequence, a Devanagari conjunct or
 * a surrogate pair. Falls back to code points where Intl.Segmenter is unavailable.
 */
export function truncateGraphemes(s: string, max: number): string {
  if (max <= 0) return "";
  // Cheap exit: a string of at most `max` code units has at most `max` graphemes.
  if (s.length <= max) return s;
  const seg = getSegmenter();
  const parts: string[] = [];
  if (seg) {
    for (const { segment } of seg.segment(s)) {
      parts.push(segment);
      if (parts.length > max) break;
    }
  } else {
    for (const cp of s) {
      parts.push(cp);
      if (parts.length > max) break;
    }
  }
  if (parts.length <= max) return s;
  return parts.slice(0, max - 1).join("").trimEnd() + "…";
}

export type NameLookup = Record<string, string> | ReadonlyMap<string, string>;

function lookupName(names: NameLookup, id: string): string | undefined {
  if (typeof (names as ReadonlyMap<string, string>).get === "function") {
    return (names as ReadonlyMap<string, string>).get(id);
  }
  const rec = names as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(rec, id) ? rec[id] : undefined;
}

/** How an id the directory does not know renders inside notification text. */
export const UNKNOWN_MENTION_NAME = "someone";

/**
 * Notification text (spec §7.9): mention tokens rendered as "@Name", whitespace collapsed,
 * bidi controls stripped, lone surrogates replaced, grapheme-safe truncation to `max` with
 * "…". The result never contains "@{" — neither a real token (rendered as a name) nor one a
 * user typed by hand (defused to "@ {") — so installed mobile builds, which render rows as
 * plain text forever, never show raw token syntax.
 */
export function notificationSnippet(body: string, names: NameLookup, max: number): string {
  let rendered = "";
  let last = 0;
  for (const t of scanMentionTokens(body)) {
    const name = stripBidi(lookupName(names, t.id) ?? UNKNOWN_MENTION_NAME);
    rendered += body.slice(last, t.start) + "@" + name;
    last = t.end;
  }
  rendered += body.slice(last);
  const clean = toWellFormed(stripBidi(rendered))
    .replace(/\s+/g, " ")
    .trim()
    .split("@{")
    .join("@ {");
  return truncateGraphemes(clean, max);
}
