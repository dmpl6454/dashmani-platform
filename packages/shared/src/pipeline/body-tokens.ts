/**
 * Message body tokeniser for rendering (spec §9.6 `MessageBody`). Produces text, mention
 * and url tokens that the HR portal renders as React nodes — never HTML, never
 * dangerouslySetInnerHTML.
 *
 * ⚠️ LINEAR and lookbehind-free: it runs in the HR bundle on every message, including
 * adversarial ones (the 2026-09-08 main-thread-hang class). One pass over the string;
 * every candidate URL consumes the characters it examines.
 *
 * Rules:
 *   - `@{uuid}` (exactly as the server parses it) is a mention token;
 *   - only `http://` and `https://` become links — `javascript:`, `data:` and friends are
 *     plain text by construction;
 *   - trailing punctuation is trimmed (a `)` is kept only when it closes a `(` inside the URL);
 *   - link text comes from the PARSED URL (punycode host + path), so a lookalike Unicode
 *     host shows its real xn-- form.
 */
import { scanMentionTokens } from "./mentions";

export type BodyToken =
  | { kind: "text"; text: string }
  | { kind: "mention"; id: string; raw: string }
  | { kind: "url"; href: string; text: string; raw: string };

/** URLs longer than this stay plain text. */
export const BODY_URL_MAX = 2048;

const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "'", '"', "]", "}", ">", "…"]);

function isUrlBreak(c: number): boolean {
  // whitespace, controls, and characters that never belong to a pasted URL
  return c <= 32 || c === 127 || c === 60 /* < */ || c === 62 /* > */ || c === 34 /* " */ || c === 0x3000 || (c >= 0x2000 && c <= 0x200b) || c === 0x2028 || c === 0x2029 || c === 0xa0;
}

function lowerAscii(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

/** Length of an `http://` / `https://` scheme at `i`, or 0. Case-insensitive. */
function schemeAt(s: string, i: number): number {
  const h = "http";
  for (let k = 0; k < 4; k++) if (lowerAscii(s.charCodeAt(i + k)) !== h.charCodeAt(k)) return 0;
  let j = i + 4;
  if (lowerAscii(s.charCodeAt(j)) === 115 /* s */) j++;
  if (s.charCodeAt(j) === 58 && s.charCodeAt(j + 1) === 47 && s.charCodeAt(j + 2) === 47) return j + 3 - i;
  return 0;
}

function isWordChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Trim trailing punctuation; keep a ")" only while it balances a "(" inside the URL. */
function trimUrl(raw: string): string {
  let end = raw.length;
  let open = 0;
  let close = 0;
  for (let k = 0; k < end; k++) {
    const ch = raw[k];
    if (ch === "(") open++;
    else if (ch === ")") close++;
  }
  while (end > 0) {
    const ch = raw[end - 1];
    if (TRAILING_PUNCT.has(ch)) {
      end--;
      continue;
    }
    if (ch === ")" && close > open) {
      close--;
      end--;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

function parseHttpUrl(raw: string): { href: string; text: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  const path = u.pathname === "/" && !raw.endsWith("/") ? "" : u.pathname;
  return { href: u.href, text: `${u.host}${path}${u.search}${u.hash}` };
}

export function tokenizeBody(body: string): BodyToken[] {
  const out: BodyToken[] = [];
  const mentions = scanMentionTokens(body);
  let mi = 0;
  let textStart = 0;
  const pushText = (end: number) => {
    if (end <= textStart) return;
    const text = body.slice(textStart, end);
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += text;
    else out.push({ kind: "text", text });
  };

  let i = 0;
  while (i < body.length) {
    // Mentions (already located by the linear scanner).
    while (mi < mentions.length && mentions[mi].start < i) mi++;
    if (mi < mentions.length && mentions[mi].start === i) {
      const m = mentions[mi++];
      pushText(i);
      out.push({ kind: "mention", id: m.id, raw: body.slice(m.start, m.end) });
      i = m.end;
      textStart = i;
      continue;
    }
    const c = body.charCodeAt(i);
    if ((c === 104 || c === 72) && (i === 0 || !isWordChar(body.charCodeAt(i - 1)))) {
      const sl = schemeAt(body, i);
      if (sl > 0) {
        let end = i + sl;
        while (end < body.length && !isUrlBreak(body.charCodeAt(end))) end++;
        const rawFull = body.slice(i, end);
        const raw = trimUrl(rawFull);
        const parsed = raw.length > sl && raw.length <= BODY_URL_MAX ? parseHttpUrl(raw) : null;
        if (parsed) {
          pushText(i);
          out.push({ kind: "url", href: parsed.href, text: parsed.text, raw });
          i += raw.length;
          textStart = i;
        } else {
          // Not a link: the whole candidate stays text (and is never re-examined).
          i = end;
        }
        continue;
      }
    }
    i++;
  }
  pushText(body.length);
  return out;
}
