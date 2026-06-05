/**
 * Read-only audit of links lost to the pre-fix "Anish" incremental-submit bug.
 *
 * For every employee+day where a saved draft (report_drafts.links_json) holds
 * MORE unique links than were actually stored (report_links), this reports the
 * gap and classifies each draft link so we can see exactly what (if anything)
 * was genuinely lost vs. correctly de-duplicated.
 *
 * 100% READ-ONLY. No writes under any circumstance. Safe to run on prod anytime.
 *
 * Usage:
 *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/audit-lost-links.ts
 *   # optional: limit to one employee for a deep look
 *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/audit-lost-links.ts --employee <uuid>
 *
 * Classification per draft link (by canonicalKey, the same key the fixed dedupe uses):
 *   STORED         — already present in that day's report_links (no loss)
 *   MISSING        — genuinely unique, not stored, not a cross-day dup → LOST, recoverable
 *   CROSS_DAY_DUP  — same content was submitted on another day → correctly absent
 *   NO_ACCOUNT     — draft row has no/blank accountId → recoverable only after picking an account
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── Self-contained copies of @dashmani/shared helpers ──────────────────────
// Inlined deliberately so this one-off prod script has zero cross-package
// module-resolution risk under tsx. MUST stay byte-identical in BEHAVIOR to
// packages/shared/src/utils/canonical-url.ts and utils/date.ts (those have the
// unit tests). If you change the canonical key logic, change it in both places.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function dateToIST(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isValidYouTubeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}
function canonicalKey(rawUrl: string | null | undefined): string {
  if (!rawUrl) return "";
  const s = String(rawUrl).trim();
  if (!s) return "";
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return s.toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    const m = url.pathname.match(/\/(?:reel|reels|p|tv)\/([^/]+)/i);
    if (m && m[1]) return `ig:${m[1]}`;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    if (host === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      if (isValidYouTubeId(id)) return `yt:${id}`;
    } else {
      const v = url.searchParams.get("v");
      if (v && isValidYouTubeId(v)) return `yt:${v}`;
      const segs = url.pathname.split("/").filter(Boolean);
      for (let i = 0; i < segs.length - 1; i++) {
        if (["shorts", "embed", "live", "e"].includes(segs[i]) && isValidYouTubeId(segs[i + 1])) {
          return `yt:${segs[i + 1]}`;
        }
      }
    }
  }
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") {
    const v = url.searchParams.get("v");
    if (v && /^\d+$/.test(v)) return `fb:${v}`;
    const m = url.pathname.match(/^\/(?:reel|videos|video)\/(\d+)(?:\/|$)/i);
    if (m && m[1]) return `fb:${m[1]}`;
  }
  return s.toLowerCase();
}

const args = process.argv.slice(2);
const employeeFilterIdx = args.indexOf("--employee");
const ONLY_EMPLOYEE = employeeFilterIdx >= 0 ? args[employeeFilterIdx + 1] : null;

type DraftLink = {
  url?: string | null;
  accountId?: string | null;
  isScheduled?: boolean;
};

type Row = {
  employeeId: string;
  employeeName: string;
  dateKey: string;
  draftUnique: number;
  stored: number;
  missing: { url: string; hasAccount: boolean }[];
  crossDayDropped: number;
};

async function main() {
  console.log("=== Lost-links audit (READ-ONLY) ===\n");

  const drafts = await prisma.reportDraft.findMany({
    where: ONLY_EMPLOYEE ? { employeeId: ONLY_EMPLOYEE } : {},
    select: {
      employeeId: true,
      dateKey: true,
      linksJson: true,
      employee: { select: { name: true } },
    },
  });

  const rows: Row[] = [];

  for (const d of drafts) {
    let draftLinks: DraftLink[];
    try {
      draftLinks = JSON.parse(d.linksJson);
    } catch {
      continue; // unparseable draft — skip
    }
    if (!Array.isArray(draftLinks)) continue;

    // Live, de-duplicated draft keys (mirror the fixed in-submission dedupe).
    const draftKeyToLink = new Map<string, DraftLink>();
    for (const l of draftLinks) {
      if (l.isScheduled || !l.url || !l.url.trim()) continue;
      const k = canonicalKey(l.url);
      if (!k) continue;
      if (!draftKeyToLink.has(k)) draftKeyToLink.set(k, l);
    }
    if (draftKeyToLink.size === 0) continue;

    // What's actually stored for that employee+day.
    const storedRows = await prisma.reportLink.findMany({
      where: {
        isScheduled: false,
        url: { not: null },
        report: { employeeId: d.employeeId, date: new Date(`${d.dateKey}T00:00:00.000Z`) },
      },
      select: { url: true },
    });
    const storedKeys = new Set(storedRows.map((r) => canonicalKey(r.url)).filter(Boolean));

    if (draftKeyToLink.size <= storedKeys.size) continue; // no gap — nothing lost

    // The employee's links on OTHER days, to label cross-day dups (correctly absent).
    const reportDate = new Date(`${d.dateKey}T00:00:00.000Z`);
    const windowStart = new Date(reportDate.getTime() - 90 * 86400000);
    const priorRows = await prisma.reportLink.findMany({
      where: {
        isScheduled: false,
        url: { not: null },
        report: {
          employeeId: d.employeeId,
          date: { gte: windowStart, lte: reportDate },
        },
      },
      select: { url: true, report: { select: { date: true } } },
    });
    const reportDayIST = dateToIST(reportDate);
    const crossDayKeys = new Set(
      priorRows
        .filter((p) => dateToIST(new Date(p.report.date)) !== reportDayIST)
        .map((p) => canonicalKey(p.url))
        .filter(Boolean),
    );

    const missing: { url: string; hasAccount: boolean }[] = [];
    let crossDayDropped = 0;
    for (const [k, l] of draftKeyToLink) {
      if (storedKeys.has(k)) continue; // already stored
      if (crossDayKeys.has(k)) {
        crossDayDropped++;
        continue;
      }
      missing.push({ url: l.url!.trim(), hasAccount: !!(l.accountId && l.accountId.trim()) });
    }

    rows.push({
      employeeId: d.employeeId,
      employeeName: d.employee?.name ?? "(unknown)",
      dateKey: d.dateKey,
      draftUnique: draftKeyToLink.size,
      stored: storedKeys.size,
      missing,
      crossDayDropped,
    });
  }

  // Report — only rows with genuinely missing links matter for recovery.
  rows.sort((a, b) => b.missing.length - a.missing.length);

  let totalMissing = 0;
  let totalRestorable = 0;
  let totalNoAccount = 0;

  for (const r of rows) {
    if (r.missing.length === 0) continue;
    const restorable = r.missing.filter((m) => m.hasAccount).length;
    const noAccount = r.missing.length - restorable;
    totalMissing += r.missing.length;
    totalRestorable += restorable;
    totalNoAccount += noAccount;
    console.log(
      `${r.employeeName.padEnd(22)} ${r.dateKey}  draft=${String(r.draftUnique).padStart(4)} stored=${String(r.stored).padStart(4)}  ` +
        `LOST=${String(r.missing.length).padStart(3)} (restorable=${restorable}, no-account=${noAccount}, cross-day-ok=${r.crossDayDropped})`,
    );
  }

  console.log("\n=== TOTALS ===");
  console.log(`Employee/day rows with genuine loss: ${rows.filter((r) => r.missing.length).length}`);
  console.log(`Total genuinely-lost links:          ${totalMissing}`);
  console.log(`  → restorable (have a valid account): ${totalRestorable}`);
  console.log(`  → blocked (no account in draft):     ${totalNoAccount}`);
  console.log("\nThis report made NO changes. Review, then run the guarded restore.");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
