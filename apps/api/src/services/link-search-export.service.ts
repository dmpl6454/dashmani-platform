// Link Search → Spreadsheet export.
//
// Produces a styled .xlsx workbook for ONE searched person/topic ("celeb"):
//   1. "Posts"  — one row per submitted link for that entity (the raw ledger):
//                 date, platform, channel (handle + name), submitted-by employee,
//                 the post URL, a same-post group id, and a "Duplicate?" flag.
//   2. "About"  — the entity, totals (total / unique / duplicate posts, channels),
//                 generated-at, and the honest coverage caveat.
//
// Reuses searchLinksByEntity() so the export reconciles EXACTLY with what the
// Link Search screen shows (same posts, same same-vs-unique semantics — we never
// dedupe rows away). xlsx-js-style is the same styled-writer the reports export
// uses (the plain `xlsx` build drops cell styling).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require("xlsx-js-style");
import { searchLinksByEntity, type LinkSearchResult } from "./link-search.service";

// ── Palette (matches reports-export so the two workbooks look consistent) ──────
const INK = "1A1A1A";
const CREAM = "FCF8EE";
const WHITE = "FFFFFF";
const BORDER = "E6DFC9";
const HEADER_TEXT = "FFFFFF";
const DUP_FILL = "FBE3D6"; // soft tint for duplicate rows
const DUP_TEXT = "9A3412";

const thin = (color: string) => ({ style: "thin", color: { rgb: color } });
const allBorders = (color = BORDER) => ({ top: thin(color), bottom: thin(color), left: thin(color), right: thin(color) });

const headerStyle = {
  font: { bold: true, color: { rgb: HEADER_TEXT }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: INK } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
  border: allBorders(INK),
};

function bodyStyle(opts: { even: boolean; align?: "left" | "center" | "right"; fill?: string; text?: string; bold?: boolean }) {
  return {
    font: { sz: 10, color: { rgb: opts.text ?? INK }, bold: !!opts.bold },
    fill: { patternType: "solid", fgColor: { rgb: opts.fill ?? (opts.even ? CREAM : WHITE) } },
    alignment: { horizontal: opts.align ?? "left", vertical: "center" },
    border: allBorders(),
  };
}

interface PostRow {
  date: string;
  platform: string;
  channel: string;
  handle: string;
  employee: string;
  url: string;
  group: string; // canonicalKey — same value ⇒ same underlying post
  duplicate: "Yes" | "";
}

const POST_HEADERS: { key: keyof PostRow; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "platform", label: "Platform" },
  { key: "channel", label: "Channel" },
  { key: "handle", label: "Handle" },
  { key: "employee", label: "Submitted By" },
  { key: "url", label: "Link URL" },
  { key: "group", label: "Post Group" },
  { key: "duplicate", label: "Duplicate?" },
];

const COL_WIDTH: Record<string, number> = {
  Date: 12,
  Platform: 12,
  Channel: 24,
  Handle: 18,
  "Submitted By": 22,
  "Link URL": 52,
  "Post Group": 20,
  "Duplicate?": 11,
};
const RIGHT_ALIGN = new Set<string>([]);
const CENTER_ALIGN = new Set(["Date", "Platform", "Duplicate?"]);

function styledSheet(rows: PostRow[]): any {
  const aoa: any[][] = [POST_HEADERS.map((h) => h.label)];
  for (const r of rows) aoa.push(POST_HEADERS.map((h) => r[h.key]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const nCols = POST_HEADERS.length;
  const nRows = rows.length;

  for (let c = 0; c < nCols; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[ref]) ws[ref].s = headerStyle;
  }
  for (let i = 0; i < nRows; i++) {
    const r = i + 1;
    const even = i % 2 === 1;
    const isDup = rows[i].duplicate === "Yes";
    for (let c = 0; c < nCols; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) ws[ref] = { t: "s", v: "" };
      const label = POST_HEADERS[c].label;
      const align = RIGHT_ALIGN.has(label) ? "right" : CENTER_ALIGN.has(label) ? "center" : "left";
      ws[ref].s = bodyStyle({
        even,
        align,
        fill: isDup ? DUP_FILL : undefined,
        text: isDup && label === "Duplicate?" ? DUP_TEXT : undefined,
        bold: isDup && label === "Duplicate?",
      });
    }
  }
  ws["!cols"] = POST_HEADERS.map((h) => ({ wch: COL_WIDTH[h.label] ?? 16 }));
  ws["!rows"] = [{ hpt: 22 }];
  if (nRows > 0) {
    ws["!autofilter"] = { ref: `A1:${XLSX.utils.encode_cell({ r: nRows, c: nCols - 1 })}` };
  }
  return ws;
}

// "About" sheet: entity + totals + generated-at + the honest coverage caveat.
function aboutSheet(result: LinkSearchResult, q: string, generatedAt: Date): any {
  const cov = result.coverage;
  const rows: [string, string][] = [
    ["Link Search export", ""],
    ["Searched for", result.entity?.canonicalName || q],
    ["Entity type", result.entity?.type || "—"],
    ["", ""],
    ["Total posts (every submitted link)", String(result.totalPosts)],
    ["Unique posts (distinct underlying post)", String(result.uniquePosts)],
    ["Duplicate posts (re-shares of the same post)", String(result.duplicatePosts)],
    ["Channels", String(result.channelCount)],
    ["", ""],
    ["Generated at (UTC)", generatedAt.toISOString().replace("T", " ").slice(0, 19)],
    ["", ""],
    [
      "Coverage note",
      `This lists the links our employees submitted for this person that we have been able to caption-match. ` +
        `Across all platforms we can name-search ${cov.nameSearchable} of ${cov.submitted} submitted links. ` +
        `The gap is Instagram/Facebook posts that scrolled past the account feed window (Meta has no fetch-by-id) ` +
        `plus opaque facebook.com/share/ links with no post id. Those links still exist — they just can't be caption-searched.`,
    ],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 42 }, { wch: 90 }];
  // Bold the label column; title row gets the dark header treatment.
  for (let r = 0; r < rows.length; r++) {
    const a = XLSX.utils.encode_cell({ r, c: 0 });
    const b = XLSX.utils.encode_cell({ r, c: 1 });
    if (r === 0) {
      if (ws[a]) ws[a].s = headerStyle;
      if (ws[b]) ws[b].s = headerStyle;
    } else {
      if (ws[a]) ws[a].s = bodyStyle({ even: false, bold: true });
      if (ws[b]) ws[b].s = bodyStyle({ even: false, align: "left" });
    }
  }
  return ws;
}

export function buildLinkSearchWorkbook(result: LinkSearchResult, q: string, generatedAt: Date): Buffer {
  // One row per post (EVERY submitted link — same-vs-unique preserved). A post is
  // a "Duplicate" if more than one submitted link maps to its canonicalKey.
  const rows: PostRow[] = result.posts.map((p) => ({
    date: p.date,
    platform: p.platform,
    channel: p.account.displayName || p.account.handle,
    handle: p.account.handle,
    employee: p.employee.name,
    url: p.url,
    group: p.canonicalKey,
    duplicate: p.dupCount > 1 ? "Yes" : "",
  }));
  // Sort newest-first, then group same posts together for readability.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.group < b.group ? -1 : 1));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, styledSheet(rows), "Posts");
  XLSX.utils.book_append_sheet(wb, aboutSheet(result, q, generatedAt), "About");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Fetch + build in one call. Returns the .xlsx Buffer + a safe filename. */
export async function generateLinkSearchExport(
  params: { q: string; from?: string; to?: string; platform?: string },
  generatedAt: Date,
): Promise<{ buffer: Buffer; filename: string; result: LinkSearchResult }> {
  const result = await searchLinksByEntity(params);
  const safeName = (result.entity?.canonicalName || params.q || "search")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "search";
  const filename = `link-search-${safeName}.xlsx`;
  return { buffer: buildLinkSearchWorkbook(result, params.q, generatedAt), filename, result };
}
