// Reading Tally's answers (spec-tally §4.13): indexOf only — never a regex over a body, so a hostile
// or truncated reply (50k unclosed tags) still parses in linear time.

/** The text between the first `open` at/after `from` and the next `close`, or null. */
export function between(body: string, open: string, close: string, from = 0): string | null {
  const i = body.indexOf(open, from);
  if (i < 0) return null;
  const j = body.indexOf(close, i + open.length);
  if (j < 0) return null;
  return body.slice(i + open.length, j);
}

/** Every <TAG …>…</TAG> element (open tag text + inner). TAG must be followed by space, ">" or "/". Stops at the first unclosed one. */
export function blocks(body: string, tag: string, max = 100_000): Array<{ open: string; inner: string }> {
  const out: Array<{ open: string; inner: string }> = [];
  const openTok = `<${tag}`;
  const closeTok = `</${tag}>`;
  let pos = 0;
  while (out.length < max) {
    const i = body.indexOf(openTok, pos);
    if (i < 0) break;
    const next = body.charAt(i + openTok.length);
    if (next !== ">" && next !== " " && next !== "/" && next !== "\t" && next !== "\r" && next !== "\n") { pos = i + openTok.length; continue; }
    const gt = body.indexOf(">", i);
    if (gt < 0) break;
    const openText = body.slice(i, gt + 1);
    if (openText.endsWith("/>")) { out.push({ open: openText, inner: "" }); pos = gt + 1; continue; }
    const j = body.indexOf(closeTok, gt + 1);
    if (j < 0) break;
    out.push({ open: openText, inner: body.slice(gt + 1, j) });
    pos = j + closeTok.length;
  }
  return out;
}

/** An attribute of an open-tag text (`<VOUCHER REMOTEID="x" …>`), entity-decoded, or null. */
export function attr(openTag: string, name: string): string | null {
  const keyD = ` ${name}="`;
  let i = openTag.indexOf(keyD);
  let quote = '"';
  if (i < 0) { i = openTag.indexOf(` ${name}='`); quote = "'"; }
  if (i < 0) return null;
  const start = i + keyD.length;
  const end = openTag.indexOf(quote, start);
  if (end < 0) return null;
  return unescapeXml(openTag.slice(start, end));
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode &amp; &lt; &gt; &quot; &apos; &#N; &#xH; (anything else is left as written). Linear. */
export function unescapeXml(s: string): string {
  if (s.indexOf("&") < 0) return s;
  let out = "";
  let pos = 0;
  while (pos < s.length) {
    const i = s.indexOf("&", pos);
    if (i < 0) { out += s.slice(pos); break; }
    out += s.slice(pos, i);
    const semi = s.indexOf(";", i);
    if (semi < 0 || semi - i > 10) { out += "&"; pos = i + 1; continue; }
    const ent = s.slice(i + 1, semi);
    let rep: string | null = null;
    if (ent in NAMED) rep = NAMED[ent];
    else if (ent.startsWith("#x") || ent.startsWith("#X")) { const n = parseInt(ent.slice(2), 16); rep = Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null; }
    else if (ent.startsWith("#")) { const n = parseInt(ent.slice(1), 10); rep = Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null; }
    if (rep === null) { out += "&"; pos = i + 1; continue; }
    out += rep;
    pos = semi + 1;
  }
  return out;
}

/** The trimmed, decoded text of the first <TAG>…</TAG> inside `inner`, or null. Tolerates attributes on the tag. */
export function field(inner: string, tag: string): string | null {
  const b = blocks(inner, tag, 1)[0];
  if (!b) return null;
  // nested markup (e.g. <NAME.LIST><NAME>…) is not a plain field
  const t = b.inner.trim();
  return unescapeXml(t);
}

export class TallyReadError extends Error {
  constructor(public kind: "BAD_RESPONSE" | "COMPANY_NOT_OPEN", message: string) { super(message); }
}

export interface TallyImportResult {
  created: number; altered: number; deleted: number; cancelled: number; ignored: number; combined: number;
  errors: number; exceptions: number; lastVchId: string | null;
  /** every <LINEERROR>, max 50, each ≤ 500 chars, entity-decoded */
  lineErrors: string[];
}

const COUNT_TAGS = ["CREATED", "ALTERED", "DELETED", "CANCELLED", "IGNORED", "COMBINED", "ERRORS", "EXCEPTIONS"] as const;

/** Tally's Import Data reply: <RESPONSE>…</RESPONSE> (ERP 9 / early Prime) or <ENVELOPE>…<IMPORTRESULT>…</ENVELOPE> (C13). */
export function parseImportResponse(body: string): TallyImportResult {
  if (body.indexOf("Could not set 'SVCurrentCompany'") >= 0 || body.indexOf("Could not set &apos;SVCurrentCompany&apos;") >= 0) {
    throw new TallyReadError("COMPANY_NOT_OPEN", "Tally could not open the company named in the file");
  }
  if (body.indexOf("Unknown Request") >= 0) throw new TallyReadError("BAD_RESPONSE", body.slice(0, 120));
  const scope = between(body, "<IMPORTRESULT>", "</IMPORTRESULT>") ?? between(body, "<RESPONSE>", "</RESPONSE>") ?? body;
  const counts: Record<string, number> = {};
  let anyCount = false;
  for (const t of COUNT_TAGS) {
    const v = between(scope, `<${t}>`, `</${t}>`);
    if (v !== null) anyCount = true;
    const s = (v ?? "").trim();
    counts[t] = /^\d{1,9}$/.test(s) ? Number(s) : 0;
  }
  if (!anyCount) throw new TallyReadError("BAD_RESPONSE", body.slice(0, 120));
  const lineErrors: string[] = [];
  let pos = 0;
  while (lineErrors.length < 50) {
    const i = body.indexOf("<LINEERROR>", pos);
    if (i < 0) break;
    const j = body.indexOf("</LINEERROR>", i + 11);
    if (j < 0) break;
    lineErrors.push(unescapeXml(body.slice(i + 11, j).trim()).slice(0, 500));
    pos = j + 12;
  }
  const last = between(scope, "<LASTVCHID>", "</LASTVCHID>")?.trim() || null;
  return {
    created: counts.CREATED, altered: counts.ALTERED, deleted: counts.DELETED, cancelled: counts.CANCELLED, ignored: counts.IGNORED,
    combined: counts.COMBINED, errors: counts.ERRORS, exceptions: counts.EXCEPTIONS,
    lastVchId: last && /^[\w-]{1,32}$/.test(last) ? last : null, lineErrors,
  };
}

/** A Tally amount "-118000.00" / "118000" → integer paise (no floating point), or null. */
export function parseTallyAmount(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = s.trim().replace(/,/g, "");
  if (!/^-?\d{1,13}(\.\d{1,2})?$/.test(t)) return null;
  const neg = t.startsWith("-");
  const [r, f = ""] = (neg ? t.slice(1) : t).split(".");
  const p = Number(r) * 100 + Number(f.padEnd(2, "0"));
  return Number.isSafeInteger(p) ? (neg ? -p : p) : null;
}

export interface TallyVoucherRow { number: string; type: string; date: string | null; party: string | null; amountPaise: number | null; remoteId: string | null; masterId: string | null; cancelled: boolean }
export interface TallyLedgerRow { name: string; parent: string | null; gstin: string | null }

const nameOf = (b: { open: string; inner: string }) =>
  attr(b.open, "NAME") ?? field(b.inner, "NAME") ?? null;

/** A collection reply (or an accountant's Export → Masters XML) → rows. */
export function parseCollection(body: string, kind: "vouchers"): TallyVoucherRow[];
export function parseCollection(body: string, kind: "companies"): string[];
export function parseCollection(body: string, kind: "ledgers"): TallyLedgerRow[];
export function parseCollection(body: string, kind: "vouchers" | "companies" | "ledgers"): TallyVoucherRow[] | string[] | TallyLedgerRow[] {
  if (body.indexOf("<ENVELOPE") < 0 && body.indexOf("<COLLECTION") < 0 && body.indexOf("<TALLYMESSAGE") < 0) throw new TallyReadError("BAD_RESPONSE", body.slice(0, 120));
  if (kind === "companies") {
    return blocks(body, "COMPANY").map(nameOf).filter((n): n is string => !!n && !!n.trim()).map((n) => n.trim());
  }
  if (kind === "ledgers") {
    return blocks(body, "LEDGER").map((b) => {
      const name = nameOf(b);
      if (!name) return null;
      const reg = blocks(b.inner, "LEDGSTREGDETAILS.LIST").map((r) => field(r.inner, "GSTIN")).filter((g): g is string => !!g && !!g.trim());
      const gstin = (field(b.inner, "PARTYGSTIN") || reg[reg.length - 1] || "").trim().toUpperCase() || null;
      return { name: name.trim(), parent: field(b.inner, "PARENT"), gstin };
    }).filter((r): r is TallyLedgerRow => !!r);
  }
  return blocks(body, "VOUCHER").map((b) => {
    const number = field(b.inner, "VOUCHERNUMBER") ?? "";
    const date = field(b.inner, "DATE");
    return {
      number: number.trim(),
      type: (field(b.inner, "VOUCHERTYPENAME") ?? attr(b.open, "VCHTYPE") ?? "").trim(),
      date: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null,
      party: field(b.inner, "PARTYLEDGERNAME"),
      amountPaise: parseTallyAmount(field(b.inner, "AMOUNT")),
      remoteId: attr(b.open, "REMOTEID") ?? field(b.inner, "REMOTEID"),
      masterId: field(b.inner, "MASTERID"),
      cancelled: (field(b.inner, "ISCANCELLED") ?? "").trim().toLowerCase() === "yes",
    };
  });
}

/** Every TALLYMESSAGE block of a file we wrote, verbatim (leading indent + trailing CRLF), with its push key. */
export function messageBlocks(xml: string): Array<{ raw: string; key: string }> {
  const out: Array<{ raw: string; key: string }> = [];
  const open = "<TALLYMESSAGE";
  const close = "</TALLYMESSAGE>";
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) break;
    const j = xml.indexOf(close, i);
    if (j < 0) break;
    const lineStart = xml.lastIndexOf("\n", i) + 1;
    let end = j + close.length;
    if (xml.startsWith("\r\n", end)) end += 2;
    const raw = xml.slice(lineStart, end);
    const inner = xml.slice(i, j);
    const v = blocks(inner, "VOUCHER", 1)[0];
    const l = v ? undefined : blocks(inner, "LEDGER", 1)[0];
    const key = v
      ? attr(v.open, "REMOTEID") ?? `cancel:${attr(v.open, "VCHTYPE")}:${attr(v.open, "TAGVALUE")}`
      : l ? `ledger:${attr(l.open, "NAME")}` : `#${out.length}`;
    out.push({ raw, key });
    pos = end;
  }
  return out;
}
