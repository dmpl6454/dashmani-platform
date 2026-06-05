/**
 * Guarded restore of links lost to the pre-fix "Anish" incremental-submit bug.
 *
 * Recovers ONLY genuinely-lost links and inserts them DIRECTLY into the existing
 * historical daily_reports row for the day they were originally added — with the
 * channel (accountId) the employee assigned and a firstSeenAt of the draft's
 * saved time. The employee does NOTHING; this is a pure historical backfill.
 *
 * STRICT eligibility (every condition must hold, or the link is skipped):
 *   1. The link is in the saved draft (report_drafts.links_json) but NOT stored.
 *   2. The employee ALREADY has a submitted report for that day (stored > 0) —
 *      proves a real submission happened; we never fabricate a never-submitted day.
 *   3. The draft link has a non-empty accountId that STILL belongs to the
 *      employee (active account assignment). No channel → skipped (never counted).
 *   4. The URL is parseable. Garbage → skipped.
 *   5. The link's canonicalKey is not already present in that report (idempotent —
 *      re-running inserts nothing new; safe against the no-unique-constraint table).
 *   6. The day is in the PAST (date < today IST). Today is editable and a same-day
 *      resubmit would wipe a direct insert — those would be handled via draft merge
 *      instead (none in the current confirmed set; we hard-skip today to be safe).
 *
 * Dry-run by default. Writes require BOTH flags. Always back up first:
 *   ssh linode "pg_dump dashmani_prod > /tmp/backup_$(date +%Y%m%d_%H%M%S).sql"
 *
 * Usage:
 *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/restore-lost-links.ts
 *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/restore-lost-links.ts --apply --confirm-prod
 *   # optional: restrict to specific employees
 *   ... restore-lost-links.ts --employee <uuid> [--employee <uuid> ...]
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");
const DRY_RUN = !APPLY;
const employeeFilter = args.reduce<string[]>((acc, a, i) => {
  if (a === "--employee" && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);

if (APPLY && !CONFIRM_PROD) {
  console.error("\n[ERROR] --apply requires --confirm-prod.\n");
  process.exit(1);
}
const mode = DRY_RUN ? "[DRY-RUN]" : "[APPLY]  ";

// ── Self-contained @dashmani/shared helpers (see audit-lost-links.ts note) ──
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function dateToIST(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
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
        if (["shorts", "embed", "live", "e"].includes(segs[i]) && isValidYouTubeId(segs[i + 1])) return `yt:${segs[i + 1]}`;
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

type DraftLink = {
  url?: string | null;
  accountId?: string | null;
  isScheduled?: boolean;
  description?: string | null;
  mediaUrl?: string | null;
  likes?: string | number | null;
  comments?: string | number | null;
  shares?: string | number | null;
  views?: string | number | null;
};

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  console.log(`\n=== Restore lost links ${mode} ===\n`);
  const todayIST = dateToIST(new Date());

  const drafts = await prisma.reportDraft.findMany({
    where: employeeFilter.length ? { employeeId: { in: employeeFilter } } : {},
    select: { employeeId: true, dateKey: true, linksJson: true, savedAt: true, employee: { select: { name: true } } },
  });

  let totalInserted = 0;
  let totalSkipped = 0;
  const perPerson: { name: string; date: string; restore: number; skipped: number }[] = [];

  for (const d of drafts) {
    // Guard 6: never touch today (editable day) — direct insert could be wiped by a resubmit.
    if (d.dateKey >= todayIST) continue;

    let draftLinks: DraftLink[];
    try {
      draftLinks = JSON.parse(d.linksJson);
    } catch {
      continue;
    }
    if (!Array.isArray(draftLinks) || draftLinks.length === 0) continue;

    // Guard 2: the report MUST already exist with stored links for that day.
    const report = await prisma.dailyReport.findUnique({
      where: { employeeId_date: { employeeId: d.employeeId, date: new Date(`${d.dateKey}T00:00:00.000Z`) } },
      select: { id: true, links: { where: { isScheduled: false, url: { not: null } }, select: { url: true } } },
    });
    if (!report || report.links.length === 0) continue; // stored=0 → never submitted → skip

    const storedKeys = new Set(report.links.map((l) => canonicalKey(l.url)).filter(Boolean));

    // The employee's currently-valid (assigned) accounts → id -> platform name.
    const assignments = await prisma.accountAssignment.findMany({
      where: { employeeId: d.employeeId, unassignedAt: null },
      select: { account: { select: { id: true, platform: { select: { name: true } } } } },
    });
    const validAccount = new Map(assignments.map((a) => [a.account.id, a.account.platform.name]));

    // Build the eligible restore set (dedupe by canonicalKey, keep first).
    const seen = new Set<string>();
    const toInsert: { link: DraftLink; key: string; platform: string }[] = [];
    let skipped = 0;
    for (const l of draftLinks) {
      if (l.isScheduled || !l.url || !l.url.trim()) continue;
      const key = canonicalKey(l.url);
      if (!key) continue;
      if (seen.has(key)) continue; // in-draft dup
      seen.add(key);
      if (storedKeys.has(key)) continue; // already stored — idempotent
      // Guard 4: parseable URL.
      try {
        new URL(l.url.trim());
      } catch {
        skipped++;
        continue;
      }
      // Guard 3: must have a valid, still-assigned account.
      const acctId = l.accountId?.trim();
      if (!acctId || !validAccount.has(acctId)) {
        skipped++;
        continue;
      }
      toInsert.push({ link: l, key, platform: validAccount.get(acctId)! });
    }

    if (toInsert.length === 0) {
      if (skipped > 0) totalSkipped += skipped;
      continue;
    }

    perPerson.push({ name: d.employee?.name ?? "(unknown)", date: d.dateKey, restore: toInsert.length, skipped });
    totalInserted += toInsert.length;
    totalSkipped += skipped;

    console.log(`${mode} ${(d.employee?.name ?? "?").padEnd(22)} ${d.dateKey}  restore ${toInsert.length} links (skipped ${skipped}) → report ${report.id}`);

    if (!DRY_RUN) {
      // firstSeenAt = draft saved time (their original add-time on that day).
      const firstSeenAt = d.savedAt;
      await prisma.reportLink.createMany({
        data: toInsert.map(({ link, platform }) => ({
          reportId: report.id,
          accountId: link.accountId!.trim(),
          url: link.url!.trim(),
          platform,
          description: link.description || null,
          mediaUrl: link.mediaUrl || null,
          likes: toInt(link.likes),
          comments: toInt(link.comments),
          shares: toInt(link.shares),
          views: toInt(link.views),
          isScheduled: false,
          scheduledFor: null,
          firstSeenAt,
        })),
      });
    }
  }

  console.log(`\n=== ${mode} SUMMARY ===`);
  for (const p of perPerson) console.log(`  ${p.name.padEnd(22)} ${p.date}  +${p.restore}`);
  console.log(`\n  Total links ${DRY_RUN ? "that WOULD be" : ""} restored: ${totalInserted}`);
  console.log(`  Total skipped (no-account / unparseable): ${totalSkipped}`);
  if (DRY_RUN) console.log(`\n  This was a DRY-RUN — no changes made. Re-run with --apply --confirm-prod to write.`);
  else console.log(`\n  ✅ Restore applied.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
