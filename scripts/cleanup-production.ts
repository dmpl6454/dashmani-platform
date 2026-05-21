/**
 * Production data cleanup script — Wave 5
 *
 * Removes test/demo rows, fixes casing, strips UTM from account names.
 * ALL operations are logged before execution.
 *
 * Usage (dry-run — default, no writes):
 *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/cleanup-production.ts
 *
 * Usage (apply — writes to DB, requires explicit flags):
 *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/cleanup-production.ts --apply --confirm-prod
 *
 * ALWAYS take a database backup before running with --apply:
 *   pg_dump dashmani_prod > /tmp/backup_$(date +%Y%m%d_%H%M%S).sql
 *
 * Each operation prints:
 *   [DRY-RUN] Would <action> <N> rows from <table>: [preview...]
 *   [APPLY]   <action> <N> rows from <table>
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");
const DRY_RUN = !APPLY;

if (APPLY && !CONFIRM_PROD) {
  console.error(
    "\n[ERROR] --apply requires --confirm-prod to prevent accidental production writes.\n" +
    "Run: npx tsx scripts/cleanup-production.ts --apply --confirm-prod\n"
  );
  process.exit(1);
}

const mode = DRY_RUN ? "[DRY-RUN]" : "[APPLY]  ";

function log(msg: string) {
  console.log(`${mode} ${msg}`);
}

function section(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ─── Utility: strip URL query string from a social media handle ───
export function sanitizeAccountUsername(raw: string): string {
  return raw.split("?")[0].split("#")[0].trim();
}

// ─── Utility: title-case a name string ───
function toTitleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── 1. Test Announcements ────────────────────────────────────────
async function deleteTestAnnouncements() {
  section("1. Test Announcements");
  const rows = await prisma.announcement.findMany({
    where: {
      OR: [
        { title: { contains: "test", mode: "insensitive" } },
        { title: { contains: "demo", mode: "insensitive" } },
        { title: { contains: "hello world", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true },
  });
  log(`Would delete ${rows.length} announcement(s): ${rows.map((r: any) => `"${r.title}"`).join(", ") || "none"}`);
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.announcement.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} announcements.`);
  }
}

// ─── 2. Test Tasks ────────────────────────────────────────────────
async function deleteTestTasks() {
  section("2. Test Tasks");
  const rows = await prisma.task.findMany({
    where: {
      OR: [
        { title: { in: ["test", "demo tabish", "sdfdg", "demo", "testing"] } },
        { title: { startsWith: "demo ", mode: "insensitive" } },
        { title: { contains: "test", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true },
  });
  log(`Would delete ${rows.length} task(s): ${rows.map((r: any) => `"${r.title}"`).join(", ") || "none"}`);
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.task.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} tasks.`);
  }
}

// ─── 3. Test Content Posts ────────────────────────────────────────
async function deleteTestContent() {
  section("3. Test Content Posts");
  const rows = await prisma.contentPost.findMany({
    where: {
      OR: [
        { title: { contains: "just testing", mode: "insensitive" } },
        { title: { contains: "QA Test", mode: "insensitive" } },
        { title: { contains: "Demo Content", mode: "insensitive" } },
        { title: { startsWith: "demo ", mode: "insensitive" } },
        { title: { contains: "test brief", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true },
  });
  log(`Would delete ${rows.length} content post(s): ${rows.map((r: any) => `"${r.title}"`).join(", ") || "none"}`);
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.contentPost.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} content posts.`);
  }
}

// ─── 4. Test Clients ──────────────────────────────────────────────
async function deleteTestClients() {
  section("4. Test Clients");
  const rows = await prisma.client.findMany({
    where: {
      OR: [
        { companyName: { contains: "demo", mode: "insensitive" } },
        { companyName: { contains: "test", mode: "insensitive" } },
      ],
    },
    select: { id: true, companyName: true, email: true },
  });
  log(`Would delete ${rows.length} client(s):`);
  rows.forEach((r: any) => log(`  - "${r.companyName}" (${r.email})`));
  if (!rows.length) log("  none");
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.client.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} clients.`);
  }
}

// ─── 5. Test Holidays ─────────────────────────────────────────────
async function deleteTestHolidays() {
  section("5. Test Holidays");
  const rows = await prisma.holiday.findMany({
    where: {
      OR: [
        { name: { contains: "demo", mode: "insensitive" } },
        { name: { contains: "test", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true },
  });
  log(`Would delete ${rows.length} holiday(s): ${rows.map((r: any) => `"${r.name}"`).join(", ") || "none"}`);
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.holiday.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} holidays.`);
  }
}

// ─── 6. Test Job Postings ─────────────────────────────────────────
async function deleteTestJobs() {
  section("6. Test Job Postings");
  const rows = await prisma.jobListing.findMany({
    where: {
      OR: [
        { title: { contains: "demo", mode: "insensitive" } },
        { title: { contains: "test", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true },
  });
  log(`Would delete ${rows.length} job listing(s): ${rows.map((r: any) => `"${r.title}"`).join(", ") || "none"}`);
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.jobListing.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} job listings.`);
  }
}

// ─── 7. Test Complaints ───────────────────────────────────────────
async function deleteTestComplaints() {
  section("7. Test Complaints");
  const rows = await prisma.complaint.findMany({
    where: {
      OR: [
        { subject: { contains: "dsfds", mode: "insensitive" } },
        { subject: { contains: "test", mode: "insensitive" } },
        { subject: { contains: "demo", mode: "insensitive" } },
        { description: { contains: "dsfdsf", mode: "insensitive" } },
      ],
    },
    select: { id: true, subject: true },
  });
  log(`Would delete ${rows.length} complaint(s): ${rows.map((r: any) => `"${r.subject}"`).join(", ") || "none"}`);
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.complaint.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} complaints.`);
  }
}

// ─── 8. Test Bug Reports ──────────────────────────────────────────
async function deleteTestBugReports() {
  section("8. Test Bug Reports");
  const rows = await prisma.bugReport.findMany({
    where: {
      OR: [
        { title: { contains: "demo", mode: "insensitive" } },
        { title: { contains: "test", mode: "insensitive" } },
        { description: { contains: "demo", mode: "insensitive" } },
      ],
    },
    select: { id: true, title: true },
  });
  log(`Would delete ${rows.length} bug report(s): ${rows.map((r: any) => `"${r.title}"`).join(", ") || "none"}`);
  if (!DRY_RUN && rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    await prisma.bugReport.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} bug reports.`);
  }
}

// ─── 9. OrgUnit (Team) cleanup ───────────────────────────────────
async function cleanupTeams() {
  section("9. Team / OrgUnit Cleanup");

  // Empty OrgUnit named "Facebook"
  const fbTeam = await prisma.orgUnit.findFirst({
    where: { name: "Facebook" },
    include: { _count: { select: { children: true } } },
  });
  if (fbTeam) {
    log(`Would delete empty "Facebook" OrgUnit (id: ${fbTeam.id}, children: ${fbTeam._count.children})`);
    if (!DRY_RUN && fbTeam._count.children === 0) {
      await prisma.orgUnit.delete({ where: { id: fbTeam.id } });
      log("Deleted empty Facebook OrgUnit.");
    } else if (!DRY_RUN) {
      log(`Skipping Facebook OrgUnit — it has ${fbTeam._count.children} child(ren). Reassign first.`);
    }
  } else {
    log("No empty 'Facebook' OrgUnit found.");
  }

  // "total filmi" → title-case
  const totalFilmi = await prisma.orgUnit.findFirst({ where: { name: { contains: "total filmi", mode: "insensitive" } } });
  if (totalFilmi) {
    log(`Would rename "${totalFilmi.name}" → "Total Filmi" (id: ${totalFilmi.id})`);
    if (!DRY_RUN) {
      await prisma.orgUnit.update({ where: { id: totalFilmi.id }, data: { name: "Total Filmi" } });
      log("Renamed to Total Filmi.");
    }
  } else {
    log("No 'total filmi' OrgUnit found.");
  }

  // Duplicate TellyDrama OrgUnits
  const tellyDrama = await prisma.orgUnit.findMany({
    where: { name: { contains: "TellyDrama", mode: "insensitive" } },
    include: { _count: { select: { children: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (tellyDrama.length > 1) {
    log(`Found ${tellyDrama.length} TellyDrama-named OrgUnits:`);
    tellyDrama.forEach((t) => log(`  - "${t.name}" (id: ${t.id}, children: ${t._count.children})`));
    const [keep, ...dupes] = tellyDrama;
    log(`Would keep: "${keep.name}" (id: ${keep.id})`);
    const emptyDupes = dupes.filter((t) => t._count.children === 0);
    log(`Would delete ${emptyDupes.length} empty duplicate(s).`);
    if (!DRY_RUN && emptyDupes.length > 0) {
      await prisma.orgUnit.deleteMany({ where: { id: { in: emptyDupes.map((t) => t.id) } } });
      log(`Deleted ${emptyDupes.length} empty TellyDrama duplicates.`);
    }
    const nonEmpty = dupes.filter((t) => t._count.children > 0);
    if (nonEmpty.length > 0) {
      log(`[MANUAL REQUIRED] ${nonEmpty.length} duplicate(s) have children — reassign before deleting.`);
    }
  } else {
    log(`Found ${tellyDrama.length} TellyDrama OrgUnit(s) — no duplicates.`);
  }
}

// ─── 10. Deduplicate Admin Accounts ──────────────────────────────
async function deduplicateAdmins() {
  section("10. Duplicate Admin Accounts");

  // Find users with "sudhanshu" in name — known duplicate
  const sudh = await prisma.user.findMany({
    where: {
      name: { contains: "sudhanshu", mode: "insensitive" },
      deletedAt: null,
    },
    select: { id: true, name: true, email: true, status: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (sudh.length > 1) {
    log(`Found ${sudh.length} Sudhanshu accounts:`);
    sudh.forEach((u: any) => log(`  - "${u.name}" <${u.email}> (id: ${u.id}, status: ${u.status})`));
    const [keep, ...extras] = sudh;
    log(`Would keep: "${keep.name}" <${keep.email}>`);
    log(`Would soft-delete ${extras.length} duplicate(s) (set deletedAt = now).`);
    if (!DRY_RUN) {
      for (const u of extras) {
        await prisma.user.update({
          where: { id: u.id },
          data: { deletedAt: new Date(), status: "INACTIVE" },
        });
      }
      log(`Soft-deleted ${extras.length} duplicate Sudhanshu accounts.`);
    }
  } else {
    log(`Found ${sudh.length} Sudhanshu account(s) — no duplicates.`);
  }
}

// ─── 11. Title-case Employee Names ───────────────────────────────
async function titleCaseEmployeeNames() {
  section("11. Title-case Employee Names");

  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true },
  });

  const toFix = users.filter((u: any) => {
    if (!u.name) return false;
    return u.name !== toTitleCase(u.name);
  });

  log(`Would title-case ${toFix.length} employee name(s):`);
  toFix.slice(0, 10).forEach((u: any) => log(`  - "${u.name}" → "${toTitleCase(u.name)}"`));
  if (toFix.length > 10) log(`  ... and ${toFix.length - 10} more`);
  if (!toFix.length) log("  All employee names already title-cased.");

  if (!DRY_RUN && toFix.length > 0) {
    for (const u of toFix) {
      await prisma.user.update({
        where: { id: u.id },
        data: { name: toTitleCase(u.name) },
      });
    }
    log(`Updated ${toFix.length} employee names.`);
  }
}

// ─── 12. Title-case Account Display Names ────────────────────────
async function titleCaseAccountNames() {
  section("12. Title-case Social Account Display Names");

  const accounts = await prisma.socialAccount.findMany({
    select: { id: true, displayName: true },
  });

  const toFix = accounts.filter((a) => {
    if (!a.displayName) return false;
    return a.displayName !== toTitleCase(a.displayName);
  });

  log(`Would title-case ${toFix.length} account displayName(s):`);
  toFix.slice(0, 10).forEach((a) => log(`  - "${a.displayName}" → "${toTitleCase(a.displayName ?? "")}"`));
  if (!toFix.length) log("  All account display names already title-cased.");

  if (!DRY_RUN && toFix.length > 0) {
    for (const a of toFix) {
      await prisma.socialAccount.update({
        where: { id: a.id },
        data: { displayName: toTitleCase(a.displayName ?? "") },
      });
    }
    log(`Updated ${toFix.length} account display names.`);
  }
}

// ─── 13. Title-case Device Names ─────────────────────────────────
async function titleCaseDeviceNames() {
  section("13. Title-case Device Names");

  const devices = await prisma.assignedDevice.findMany({
    select: { id: true, brand: true, model: true },
  });

  const toFix = devices.filter((d) => {
    const fullName = [d.brand, d.model].filter(Boolean).join(" ");
    return fullName !== toTitleCase(fullName);
  });

  log(`Would title-case ${toFix.length} device name(s):`);
  toFix.slice(0, 10).forEach((d) => log(`  - "${d.brand} ${d.model}" → "${toTitleCase([d.brand, d.model].filter(Boolean).join(" "))}"`));
  if (!toFix.length) log("  All device names already title-cased.");

  if (!DRY_RUN && toFix.length > 0) {
    for (const d of toFix) {
      await prisma.assignedDevice.update({
        where: { id: d.id },
        data: {
          brand: d.brand ? toTitleCase(d.brand) : d.brand,
          model: d.model ? toTitleCase(d.model) : d.model,
        },
      });
    }
    log(`Updated ${toFix.length} device names.`);
  }
}

// ─── 14. Delete Test Internship Applications ──────────────────────
async function deleteTestInternshipApps() {
  section("14. Test Internship Applications");

  const rows = await prisma.internshipApplication.findMany({
    where: {
      OR: [
        { name: { contains: "sdsf", mode: "insensitive" } },
        { name: { contains: "fdgfd", mode: "insensitive" } },
        { email: { contains: "test@test", mode: "insensitive" } },
        { college: { contains: "fdg", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, email: true },
  }).catch(() => {
    log("internshipApplication table not found — skipping.");
    return [];
  });

  log(`Would delete ${rows.length} test internship application(s):`);
  (rows as any[]).forEach((r: any) => log(`  - "${r.name}" <${r.email}>`));
  if (!rows.length) log("  none");

  if (!DRY_RUN && rows.length > 0) {
    const ids = (rows as any[]).map((r: any) => r.id);
    await prisma.internshipApplication.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} test internship applications.`);
  }
}

// ─── 15. Delete Admin Self-applied Internship ────────────────────
async function deleteAdminInternshipApp() {
  section("15. Admin Self-applied Internship");

  const adminEmails = ["admin@digitalsukoon.com", "tabish@dashmani.com"];
  const rows = await prisma.internshipApplication.findMany({
    where: { email: { in: adminEmails } },
    select: { id: true, name: true, email: true },
  }).catch(() => {
    log("internshipApplication table not found — skipping.");
    return [];
  });

  log(`Would delete ${rows.length} admin self-applied internship(s):`);
  (rows as any[]).forEach((r: any) => log(`  - "${r.name}" <${r.email}>`));
  if (!rows.length) log("  none");

  if (!DRY_RUN && rows.length > 0) {
    const ids = (rows as any[]).map((r: any) => r.id);
    await prisma.internshipApplication.deleteMany({ where: { id: { in: ids } } });
    log(`Deleted ${ids.length} admin internship self-applications.`);
  }
}

// ─── 16. Strip UTM params from Social Account Handles ────────────
async function stripUtmFromAccountNames() {
  section("16. Strip UTM / query-string from Social Account Handles");

  const accounts = await prisma.socialAccount.findMany({
    select: { id: true, handle: true },
  });

  const toFix = accounts.filter((a) => {
    if (!a.handle) return false;
    return sanitizeAccountUsername(a.handle) !== a.handle;
  });

  log(`Would strip UTM from ${toFix.length} account handle(s):`);
  toFix.forEach((a) => log(`  - "${a.handle}" → "${sanitizeAccountUsername(a.handle ?? "")}"`));
  if (!toFix.length) log("  All handles already clean.");

  if (!DRY_RUN && toFix.length > 0) {
    for (const a of toFix) {
      await prisma.socialAccount.update({
        where: { id: a.id },
        data: { handle: sanitizeAccountUsername(a.handle ?? "") },
      });
    }
    log(`Cleaned ${toFix.length} account handles.`);
  }
}

// ─── 17. Fix "bollywood mirrorr" typo ────────────────────────────
async function fixBollywoodMirrorr() {
  section("17. Fix 'bollywood mirrorr' typo");

  const row = await prisma.socialAccount.findFirst({
    where: { handle: { contains: "bollywood mirrorr", mode: "insensitive" } },
    select: { id: true, handle: true },
  });

  if (row) {
    const fixed = (row.handle ?? "").replace(/mirrorr/gi, "mirror");
    log(`Would rename "${row.handle}" → "${fixed}" (id: ${row.id})`);
    if (!DRY_RUN) {
      await prisma.socialAccount.update({ where: { id: row.id }, data: { handle: fixed } });
      log("Fixed bollywood mirrorr → bollywood mirror.");
    }
  } else {
    log("No 'bollywood mirrorr' account found.");
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  PRODUCTION DATA CLEANUP — Wave 5");
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "APPLY (writing to DB)"}`);
  console.log("═".repeat(60));

  if (!DRY_RUN) {
    console.log("\n  ⚠  WRITING TO DATABASE. ENSURE YOU HAVE A BACKUP.\n");
  }

  await deleteTestAnnouncements();
  await deleteTestTasks();
  await deleteTestContent();
  await deleteTestClients();
  await deleteTestHolidays();
  await deleteTestJobs();
  await deleteTestComplaints();
  await deleteTestBugReports();
  await cleanupTeams();
  await deduplicateAdmins();
  await titleCaseEmployeeNames();
  await titleCaseAccountNames();
  await titleCaseDeviceNames();
  await deleteTestInternshipApps();
  await deleteAdminInternshipApp();
  await stripUtmFromAccountNames();
  await fixBollywoodMirrorr();

  console.log("\n" + "═".repeat(60));
  console.log(`  Cleanup ${DRY_RUN ? "dry run" : "apply"} complete.`);
  if (DRY_RUN) {
    console.log("  Review the output above. To apply, run:");
    console.log("  cd packages/db && npx tsx ../../scripts/cleanup-production.ts --apply --confirm-prod");
  }
  console.log("═".repeat(60) + "\n");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
