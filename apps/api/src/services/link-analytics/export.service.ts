// Link Analytics — exports: Excel (8 sheets), CSV, branded PDF, JSON (docs/link-analytics/SPEC.md §6).
// Built in memory from buildReport(); a 20k-post batch is a few MB. Nothing is written to disk.
// A metric Meta doesn't publish is an EMPTY cell / "—", never 0.

import PDFDocument from "pdfkit";
import { logoFor } from "../sales/pdf.service";
import { buildReport, extractionHistory, failedLinks, FORMULAS, type BatchReport, type ReportPost, type Total } from "./report.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require("xlsx-js-style");

const BRAND = "#403cfa";
const INK = "#111111";
const MUTED = "#666666";

/** IST "25 Nov 2026, 14:05" — the agency works in IST. */
export function ist(d: Date | string | null | undefined): string {
  if (!d) return "";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  const s = new Date(t.getTime() + 330 * 60_000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][s.getUTCMonth()];
  return `${s.getUTCDate()} ${mon} ${s.getUTCFullYear()}, ${String(s.getUTCHours()).padStart(2, "0")}:${String(s.getUTCMinutes()).padStart(2, "0")} IST`;
}

const STATUS_LABEL: Record<string, string> = { verified: "Verified", restricted: "Restricted", failed: "Failed", pending: "Pending" };
const SOURCE_LABEL: Record<string, string> = {
  meta_graph: "Meta Graph API (our account)",
  meta_business_discovery: "Meta business discovery (public)",
  platform_sync: "Platform Meta sync (cached)",
  none: "—",
};
const fmtN = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-IN"));
const fmtT = (t: Total) => (t.sum == null ? "—" : `${t.sum.toLocaleString("en-IN")} (${t.reporting} of ${t.of} posts)`);
const platformName = (p: string) => (p === "instagram" ? "Instagram" : p === "facebook" ? "Facebook" : p);

const POST_HEADERS = [
  "Platform", "Type", "Account", "Username", "Followers", "Published", "Link",
  "Views", "Reach", "Likes", "Comments", "Shares", "Saves",
  "Engagement actions", "Partial engagement", "ER on followers %", "ER on reach %",
  "Status", "Data access", "Reason / error", "Data source", "Live or cached", "Measured at", "Last checked",
];

function postRow(p: ReportPost): Array<string | number | null> {
  return [
    platformName(p.platform), p.postType, p.account, p.username ? `@${p.username}` : null, p.followers, ist(p.publishedAt), p.url,
    p.views, p.reach, p.likes, p.comments, p.shares, p.saves,
    p.engagement, p.engagementPartial ? "yes" : p.engagement == null ? null : "no", p.erFollowers, p.erReach,
    STATUS_LABEL[p.status] ?? p.status, p.access, p.reason ?? p.error, p.source ? SOURCE_LABEL[p.source] ?? p.source : null,
    p.freshness, ist(p.metricsAt), ist(p.lastCheckedAt),
  ];
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────
export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Formula injection: a cell starting with = + - @ is opened as a formula by Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(report: BatchReport): Buffer {
  const lines = [`# ${report.batch.name} — generated ${ist(report.generatedAt)}. Empty cell = Meta does not publish that number.`, POST_HEADERS.map(csvCell).join(",")];
  for (const p of report.posts) lines.push(postRow(p).map(csvCell).join(","));
  return Buffer.from("﻿" + lines.join("\r\n"), "utf8");
}

// ── Excel ───────────────────────────────────────────────────────────────────────────────
const headerStyle = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "403CFA" } }, alignment: { vertical: "center", wrapText: true } };
const titleStyle = { font: { bold: true, sz: 14 } };

function sheet(rows: Array<Array<string | number | null>>, widths: number[], headerRow = 0) {
  const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => (c == null ? "" : c))));
  const cols = Math.max(...rows.map((r) => r.length));
  for (let c = 0; c < cols; c++) {
    const ref = XLSX.utils.encode_cell({ r: headerRow, c });
    if (ws[ref]) ws[ref].s = headerStyle;
  }
  ws["!cols"] = widths.map((w) => ({ wch: w }));
  if (rows.length > headerRow + 1) ws["!autofilter"] = { ref: `${XLSX.utils.encode_cell({ r: headerRow, c: 0 })}:${XLSX.utils.encode_cell({ r: rows.length - 1, c: cols - 1 })}` };
  return ws;
}

const POST_WIDTHS = [10, 8, 28, 20, 12, 22, 50, 12, 12, 12, 12, 10, 10, 14, 10, 12, 12, 11, 10, 50, 30, 10, 22, 22];

export async function toXlsx(report: BatchReport): Promise<Buffer> {
  const wb = XLSX.utils.book_new();
  const k = report.executive.kpis;

  // 1. Executive Summary
  const exec: Array<Array<string | number | null>> = [
    [`${report.batch.name} — social post report`],
    [`Generated ${ist(report.generatedAt)} · Digital Sukoon`],
    [],
    ["Metric", "Value"],
    ["Links submitted", report.counts.total],
    ["Valid / invalid / duplicate", `${report.counts.valid} / ${report.counts.invalid} / ${report.counts.duplicate}`],
    ["Unique posts", report.counts.unique],
    ["Verified (our accounts, full insights)", k.posts.verified],
    ["Restricted (not ours)", k.posts.restricted],
    ["Failed", k.posts.failed],
    ["Pending", k.posts.pending],
    ["Views", fmtT(k.views)],
    ["Reach", fmtT(k.reach)],
    ["Likes", fmtT(k.likes)],
    ["Comments", fmtT(k.comments)],
    ["Shares", fmtT(k.shares)],
    ["Saves", fmtT(k.saves)],
    ["Followers (sum of unique accounts)", k.followers.sum == null ? "—" : `${k.followers.sum.toLocaleString("en-IN")} across ${k.followers.accountsWithFollowers} account(s)`],
    ["Engagement actions", fmtT(k.engagement.actions)],
    ["Engagement rate on followers (weighted)", k.engagement.weightedRateFollowers == null ? "—" : `${k.engagement.weightedRateFollowers}%`],
    ["Engagement rate on reach (weighted)", k.engagement.weightedRateReach == null ? "—" : `${k.engagement.weightedRateReach}%`],
    ["Values read live / cached", `${k.live} / ${k.cached}`],
    ["Last checked", ist(k.lastCheckedAt)],
    [],
    ["Highlights"],
    ...report.executive.highlights.map((h) => [h]),
    [],
    ["Data limitations"],
    ...report.executive.dataLimitations.map((h) => [h]),
    [],
    ["Formulas"],
    ...FORMULAS.map((f) => [f]),
  ];
  const ws1 = sheet(exec, [45, 60], 3);
  ws1.A1.s = titleStyle;
  delete ws1["!autofilter"];
  XLSX.utils.book_append_sheet(wb, ws1, "Executive Summary");

  // 2-4. All Posts, Facebook, Instagram
  const postsSheet = (ps: ReportPost[]) => sheet([POST_HEADERS, ...ps.map(postRow)], POST_WIDTHS);
  XLSX.utils.book_append_sheet(wb, postsSheet(report.posts), "All Posts");
  XLSX.utils.book_append_sheet(wb, postsSheet(report.posts.filter((p) => p.platform === "facebook")), "Facebook");
  XLSX.utils.book_append_sheet(wb, postsSheet(report.posts.filter((p) => p.platform === "instagram")), "Instagram");

  // 5. Page-Wise
  const pageHead = ["Platform", "Account", "Username", "Followers", "Posts", "Verified", "Restricted", "Failed", "Views", "Avg views", "Reach", "Likes", "Comments", "Shares", "Saves", "Engagement actions", "ER on followers % (weighted)", "Top post"];
  const pageRows = report.pages.map((g) => [
    platformName(g.platform), g.account, g.username ? `@${g.username}` : null, g.followers, g.posts, g.verified, g.restricted, g.failed,
    g.totals.views.sum, g.totals.views.avg, g.totals.reach.sum, g.totals.likes.sum, g.totals.comments.sum, g.totals.shares.sum, g.totals.saves.sum,
    g.engagement.actions.sum, g.engagement.weightedRateFollowers, g.topPost?.url ?? null,
  ]);
  XLSX.utils.book_append_sheet(wb, sheet([pageHead, ...pageRows], [10, 28, 20, 12, 8, 9, 10, 8, 12, 12, 12, 12, 12, 10, 10, 14, 14, 50]), "Page-Wise");

  // 6. Top Posts
  const top: Array<Array<string | number | null>> = [["List", "Rank", "Account", "Platform", "Link", "Views", "Likes", "Comments", "Shares", "Engagement actions"]];
  const addTop = (label: string, ps: ReportPost[]) => ps.forEach((p, i) => top.push([label, i + 1, p.account ?? (p.username ? `@${p.username}` : null), platformName(p.platform), p.url, p.views, p.likes, p.comments, p.shares, p.engagement]));
  addTop("Top 10 by views", report.top.byViews);
  addTop("Top 10 by likes", report.top.byLikes);
  addTop("Top 10 by comments", report.top.byComments);
  addTop("Top 10 by shares", report.top.byShares);
  for (const [pl, ps] of Object.entries(report.top.perPlatform)) addTop(`Top ${platformName(pl)}`, ps as ReportPost[]);
  XLSX.utils.book_append_sheet(wb, sheet(top, [18, 6, 28, 10, 50, 12, 12, 12, 10, 14]), "Top Posts");

  // 7. Failed Links
  const failed = await failedLinks(report.batch.id);
  XLSX.utils.book_append_sheet(wb, sheet([["Line", "Link", "Problem", "Detail"], ...failed.map((f) => [f.line, f.url, f.problem, f.detail])], [6, 60, 12, 90]), "Failed Links");

  // 8. Extraction History
  const hist = await extractionHistory(report.batch.id);
  XLSX.utils.book_append_sheet(
    wb,
    sheet(
      [["Link", "Checked at", "Status", "Data source", "Measured at", "Views", "Reach", "Likes", "Comments", "Shares", "Saves", "Followers"],
        ...hist.map((h) => [h.url, ist(h.checked_at), STATUS_LABEL[h.status] ?? h.status, h.data_source ? SOURCE_LABEL[h.data_source] ?? h.data_source : null, ist(h.metrics_at), h.views, h.reach, h.likes, h.comments, h.shares, h.saves, h.followers])],
      [50, 22, 11, 30, 22, 12, 12, 12, 12, 10, 10, 12],
    ),
    "Extraction History",
  );
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ── PDF ─────────────────────────────────────────────────────────────────────────────────
/** pdfkit's built-in Helvetica is WinAnsi only: emoji, Devanagari etc. would print as garbage. */
export function pdfSafe(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[÷×]/g, (m) => (m === "÷" ? "/" : "x"))
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "").replace(/\s{2,}/g, " ").trim();
}

export async function toPdf(report: BatchReport): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: pdfSafe(report.batch.name), Author: "Digital Sukoon" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 80;
  const k = report.executive.kpis;

  // Cover
  doc.rect(0, 0, doc.page.width, 8).fill(BRAND);
  const logo = logoFor("dspl");
  if (logo) doc.image(logo, 40, 60, { fit: [140, 50] });
  doc.fillColor(MUTED).font("Helvetica").fontSize(11).text("Social post performance report", 40, 150);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(26).text(pdfSafe(report.batch.name), 40, 170, { width: W });
  if (report.batch.notes) doc.moveDown(0.5).font("Helvetica").fontSize(11).fillColor(MUTED).text(pdfSafe(report.batch.notes), { width: W });
  doc.moveDown(1).font("Helvetica").fontSize(10).fillColor(INK)
    .text(`Generated ${pdfSafe(ist(report.generatedAt))}`)
    .text(`Last checked ${pdfSafe(ist(k.lastCheckedAt)) || "-"}`)
    .text(`${report.counts.unique} unique post(s) from ${report.counts.total} submitted link(s)`);

  // KPI grid
  const kpis: Array<[string, string, string]> = [
    ["Posts verified", fmtN(k.posts.verified), `${k.posts.restricted} restricted, ${k.posts.failed} failed`],
    ["Views", fmtN(k.views.sum), `${k.views.reporting} of ${k.views.of} posts`],
    ["Likes", fmtN(k.likes.sum), `${k.likes.reporting} of ${k.likes.of} posts`],
    ["Comments", fmtN(k.comments.sum), `${k.comments.reporting} of ${k.comments.of} posts`],
    ["Shares", fmtN(k.shares.sum), `${k.shares.reporting} of ${k.shares.of} posts`],
    ["Followers", fmtN(k.followers.sum), `sum of ${k.followers.accountsWithFollowers} unique account(s)`],
    ["Engagement rate", k.engagement.weightedRateFollowers == null ? "-" : `${k.engagement.weightedRateFollowers}%`, "on followers, weighted"],
    ["Reach", fmtN(k.reach.sum), `${k.reach.reporting} of ${k.reach.of} posts`],
  ];
  let y = 360;
  const cw = (W - 30) / 4;
  kpis.forEach(([label, value, sub], i) => {
    const x = 40 + (i % 4) * (cw + 10);
    const yy = y + Math.floor(i / 4) * 78;
    doc.rect(x, yy, cw, 68).lineWidth(1).strokeColor("#dddddd").stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x + 8, yy + 8, { width: cw - 16 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(pdfSafe(value), x + 8, yy + 22, { width: cw - 16 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(pdfSafe(sub), x + 8, yy + 46, { width: cw - 16 });
  });
  y += 170;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Highlights", 40, y);
  doc.font("Helvetica").fontSize(9.5);
  for (const h of report.executive.highlights) doc.text(`- ${pdfSafe(h)}`, { width: W });

  const section = (title: string) => {
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 4).fill(BRAND);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(title, 40, 40);
    doc.moveDown(0.6);
  };
  const table = (head: string[], rows: string[][], widths: number[]) => {
    const total = widths.reduce((a, b) => a + b, 0);
    const ws = widths.map((w) => (w / total) * W);
    const draw = (cells: string[], bold: boolean) => {
      const h = Math.max(...cells.map((c, i) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).heightOfString(c, { width: ws[i] - 4 }))) + 6;
      if (doc.y + h > doc.page.height - 50) {
        doc.addPage();
        doc.y = 40;
      }
      const top = doc.y;
      let x = 40;
      if (bold) doc.rect(40, top, W, h).fill("#eeeefe");
      cells.forEach((c, i) => {
        doc.fillColor(INK).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).text(c, x + 2, top + 3, { width: ws[i] - 4 });
        x += ws[i];
      });
      doc.y = top + h;
      doc.moveTo(40, doc.y).lineTo(40 + W, doc.y).lineWidth(0.5).strokeColor("#e5e5e5").stroke();
    };
    draw(head, true);
    for (const r of rows) draw(r.map((c) => pdfSafe(c)), false);
    doc.moveDown(0.8);
  };
  const acct = (p: ReportPost) => p.account ?? (p.username ? `@${p.username}` : "unknown");

  section("Platform summary");
  table(
    ["Platform", "Posts", "Verified", "Views", "Avg views", "Likes", "Comments", "Shares", "ER (followers)"],
    report.platforms.map((g) => [platformName(g.platform), String(g.posts), String(g.verified), fmtN(g.totals.views.sum), fmtN(g.totals.views.avg), fmtN(g.totals.likes.sum), fmtN(g.totals.comments.sum), fmtN(g.totals.shares.sum), g.engagement.weightedRateFollowers == null ? "-" : `${g.engagement.weightedRateFollowers}%`]),
    [12, 7, 8, 12, 11, 11, 11, 9, 11],
  );
  for (const g of report.platforms) if (g.topPost) doc.font("Helvetica").fontSize(8.5).fillColor(INK).text(`Top ${platformName(g.platform)} post: ${pdfSafe(acct(g.topPost))} - ${pdfSafe(g.topPost.url)}`, { width: W });

  section("Page-wise summary");
  table(
    ["Account", "Platform", "Followers", "Posts", "Views", "Likes", "Comments", "ER (followers)"],
    report.pages.slice(0, 200).map((g) => [g.account ?? (g.username ? `@${g.username}` : "unknown"), platformName(g.platform), fmtN(g.followers), String(g.posts), fmtN(g.totals.views.sum), fmtN(g.totals.likes.sum), fmtN(g.totals.comments.sum), g.engagement.weightedRateFollowers == null ? "-" : `${g.engagement.weightedRateFollowers}%`]),
    [26, 10, 11, 7, 12, 11, 11, 11],
  );
  if (report.pages.length > 200) doc.fontSize(8).fillColor(MUTED).text(`… and ${report.pages.length - 200} more accounts in the Excel export.`);

  section("Top content");
  const topTable = (label: string, ps: ReportPost[], key: "views" | "likes" | "comments" | "shares") => {
    if (!ps.length) return;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(label);
    doc.moveDown(0.3);
    table(["#", "Account", key[0].toUpperCase() + key.slice(1), "Link"], ps.map((p, i) => [String(i + 1), acct(p), fmtN(p[key]), p.url]), [4, 26, 12, 58]);
  };
  topTable("Top 10 by views", report.top.byViews, "views");
  topTable("Top 10 by likes", report.top.byLikes, "likes");
  topTable("Top 10 by comments", report.top.byComments, "comments");
  topTable("Top 10 by shares", report.top.byShares, "shares");

  section("Engagement analysis");
  const e = report.engagement.summary;
  doc.font("Helvetica").fontSize(9.5).fillColor(INK)
    .text(`Engagement actions: ${pdfSafe(fmtT(e.actions))}${e.partialPosts ? ` - ${e.partialPosts} post(s) partial` : ""}`)
    .text(`Weighted rate on followers: ${e.weightedRateFollowers == null ? "-" : `${e.weightedRateFollowers}%`} (${e.postsWithFollowers} posts) · average ${e.avgRateFollowers == null ? "-" : `${e.avgRateFollowers}%`}`)
    .text(`Weighted rate on reach: ${e.weightedRateReach == null ? "-" : `${e.weightedRateReach}%`} (${e.postsWithReach} posts) · average ${e.avgRateReach == null ? "-" : `${e.avgRateReach}%`}`);
  doc.moveDown(0.6).font("Helvetica-Bold").text("Formulas");
  doc.font("Helvetica").fontSize(8.5);
  for (const f of FORMULAS) doc.text(`- ${pdfSafe(f)}`, { width: W });
  doc.moveDown(0.6);
  if (report.engagement.topByRate.length) {
    doc.font("Helvetica-Bold").fontSize(10).text("Highest engagement rate on followers");
    doc.moveDown(0.3);
    table(["#", "Account", "Followers", "Engagement", "Rate", "Link"], report.engagement.topByRate.map((p, i) => [String(i + 1), acct(p), fmtN(p.followers), fmtN(p.engagement), `${p.erFollowers}%`, p.url]), [4, 22, 11, 11, 8, 44]);
  }

  section("Post-by-post");
  table(
    ["Account", "Platform", "Status", "Views", "Reach", "Likes", "Comments", "Shares", "Saves", "Measured"],
    report.posts.slice(0, 500).map((p) => [acct(p), platformName(p.platform), (STATUS_LABEL[p.status] ?? p.status) + (p.freshness === "cached" ? " (cached)" : ""), fmtN(p.views), fmtN(p.reach), fmtN(p.likes), fmtN(p.comments), fmtN(p.shares), fmtN(p.saves), ist(p.metricsAt)]),
    [22, 9, 11, 9, 9, 9, 9, 8, 7, 17],
  );
  if (report.posts.length > 500) doc.fontSize(8).fillColor(MUTED).text(`First 500 of ${report.posts.length} posts; the Excel and CSV exports carry all of them.`);

  section("Data limitations");
  doc.font("Helvetica").fontSize(9.5).fillColor(INK);
  for (const l of report.executive.dataLimitations) doc.text(`- ${pdfSafe(l)}`, { width: W }).moveDown(0.3);

  // Footer with timestamp + page numbers on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
      .text(`Digital Sukoon · ${pdfSafe(report.batch.name)} · generated ${pdfSafe(ist(report.generatedAt))} · page ${i + 1} of ${range.count}`, 40, doc.page.height - 28, { width: W, align: "center", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

export type ExportFormat = "xlsx" | "csv" | "pdf" | "json";

export async function exportBatch(batchId: string, format: ExportFormat): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const report = await buildReport(batchId);
  const stamp = ist(report.generatedAt).replace(/[^0-9A-Za-z]+/g, "-").replace(/-+$/, "");
  const base = `${report.batch.name.replace(/[^\w.-]+/g, "-").slice(0, 60)}-${stamp}`;
  switch (format) {
    case "xlsx":
      return { body: await toXlsx(report), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${base}.xlsx` };
    case "csv":
      return { body: toCsv(report), contentType: "text/csv; charset=utf-8", filename: `${base}.csv` };
    case "pdf":
      return { body: await toPdf(report), contentType: "application/pdf", filename: `${base}.pdf` };
    case "json":
      return { body: Buffer.from(JSON.stringify(report, null, 2), "utf8"), contentType: "application/json; charset=utf-8", filename: `${base}.json` };
  }
}
