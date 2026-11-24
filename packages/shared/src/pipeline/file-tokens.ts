/**
 * Chat attachments (2026-11-23): a message carries its files as `#{file:<documentId>}` tokens on
 * their own lines at the END of the body. The file itself is a project document
 * (pipeline_documents, source "chat"), so deleting the message never deletes the file — it stays
 * in the project's Documents tab.
 *
 * Both portals split the body into its text and its file ids, render the text as before and the
 * files as attachment cards under it. Notification and email snippets say "📎 1 file".
 *
 * ⚠️ LINEAR and lookbehind-free: runs in the HR bundle on every message (see body-tokens.ts).
 * No imports, so text.ts and documents.ts can both use it without a cycle.
 */

const OPEN = "#{file:";
const ID_LEN = 36;
/** At most this many files on one message. */
export const MAX_FILES_PER_MESSAGE = 10;

function isUuidChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70) || c === 45;
}

/** `#{file:<id>}` for one document id. */
export function fileToken(id: string): string {
  return `${OPEN}${id.toLowerCase()}}`;
}

/**
 * The body without its file tokens (trailing blank lines trimmed) and the file ids in order,
 * de-duplicated, at most MAX_FILES_PER_MESSAGE. A malformed token stays in the text.
 */
export function splitFileTokens(body: string): { text: string; ids: string[] } {
  if (body.indexOf(OPEN) === -1) return { text: body, ids: [] };
  const ids: string[] = [];
  let text = "";
  let last = 0;
  let i = body.indexOf(OPEN);
  while (i !== -1) {
    const start = i + OPEN.length;
    let ok = body.length >= start + ID_LEN + 1 && body.charCodeAt(start + ID_LEN) === 125; /* } */
    for (let k = 0; ok && k < ID_LEN; k++) ok = isUuidChar(body.charCodeAt(start + k));
    if (ok) {
      const id = body.slice(start, start + ID_LEN).toLowerCase();
      if (!ids.includes(id) && ids.length < MAX_FILES_PER_MESSAGE) ids.push(id);
      text += body.slice(last, i);
      last = start + ID_LEN + 1;
      i = body.indexOf(OPEN, last);
    } else {
      i = body.indexOf(OPEN, i + OPEN.length);
    }
  }
  text += body.slice(last);
  // Tokens sit on their own lines at the end: drop the whitespace they leave behind.
  return { text: text.trimEnd(), ids };
}

/** The text with these files appended as tokens, one per line. */
export function withFileTokens(text: string, ids: readonly string[]): string {
  const t = text.trimEnd();
  if (ids.length === 0) return t;
  const tokens = ids.slice(0, MAX_FILES_PER_MESSAGE).map(fileToken).join("\n");
  return t ? `${t}\n${tokens}` : tokens;
}

/** "📎 1 file" / "📎 3 files", for snippets; "" when there are none. */
export function filesLabel(n: number): string {
  return n <= 0 ? "" : `📎 ${n} file${n === 1 ? "" : "s"}`;
}
