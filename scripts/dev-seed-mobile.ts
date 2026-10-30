/**
 * Local-only fixture so the MOBILE app's employee and admin journeys can be driven end to end
 * on a dev database: a Content Team (two employees, a team lead, an HR manager, one pending
 * hire), six social accounts with assignments, two weeks of daily reports carrying realistic
 * reel / short URLs, tasks with comments, leave, holidays, attendance, notifications, salary
 * slips, expenses, extra hours, an incentive, a review, a pending document, an announcement,
 * complaints, a bug report, an offer letter + signed contract, POAs, a job listing with two
 * applications, the Pipeline seed rows (board state + 7 phases) with two projects and a short
 * thread, `pipeline.mode=on`, and SOP content.
 *
 * Run from packages/db (so @prisma/client picks up packages/db/.env):
 *   cd packages/db && npx tsx ../../scripts/dev-seed-mobile.ts
 * Refuses to run unless DATABASE_URL points at localhost — this is dev data. Re-runnable:
 * every row is upserted on its unique key or looked up by a stable natural key first, and
 * every URL / count comes from a seeded PRNG so a re-run reproduces the same rows.
 *
 * Deliberately NOT created, so the journeys can create them themselves: Priya's daily report,
 * POA, attendance check-in and report draft for TODAY (the IST day, like the API). Arjun has a
 * report and a POA for today so the admin "who submitted today" views are not empty.
 *
 * Credentials — every seeded person signs in with  Employee@123456
 *   priya@digitalsukoon.com    Priya Sharma   Employee     (the main employee journey)
 *   arjun@digitalsukoon.com    Arjun Mehta    Employee
 *   rohan@digitalsukoon.com    Rohan Verma    Team Lead    (lead of "Content Team")
 *   meera@digitalsukoon.com    Meera Iyer     HR Manager   (Admin if that role is absent)
 *   newhire@digitalsukoon.com  Kabir Nair     ONBOARDING   (cannot sign in until approved)
 */
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import { todayIST, istMidnight, addDaysIST, dayOfWeekIST, keyBetween } from "@dashmani/shared";

const PASSWORD = "Employee@123456";
const TAG = "dev-seed-mobile";

// ───────────────────────────── helpers ─────────────────────────────
/** A Date at HH:MM on an IST calendar day (the API keys every day on IST). */
const atIST = (key: string, hhmm: string) => new Date(`${key}T${hhmm}:00.000+05:30`);
/** Deterministic PRNG so URLs and link counts are identical on every run. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const token = (rnd: () => number, n: number, alpha = ALPHA) => Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join("");
/** A plausible post URL for the platform — the shapes canonicalKey() recognises. */
function urlFor(platform: string, rnd: () => number): string {
  switch (platform) {
    case "instagram": return `https://www.instagram.com/reel/${token(rnd, 11)}/`;
    case "facebook": return `https://www.facebook.com/reel/${"123456789"[Math.floor(rnd() * 9)]}${token(rnd, 14, "0123456789")}`;
    case "youtube": return `https://youtube.com/shorts/${token(rnd, 11)}`;
    case "snapchat": return `https://www.snapchat.com/spotlight/W7_${token(rnd, 22)}`;
    default: return `https://example.com/p/${token(rnd, 10)}`;
  }
}
/** The n most recent working days (Mon–Sat; Sunday is the only weekend day) ending on `end`, oldest first. */
function workdaysBack(end: string, n: number): string[] {
  const out: string[] = [];
  let k = end;
  while (out.length < n) { if (dayOfWeekIST(k) !== 0) out.unshift(k); k = addDaysIST(k, -1); }
  return out;
}
const pad2 = (n: number) => String(n).padStart(2, "0");

async function main() {

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")) throw new Error("refusing: DATABASE_URL is not localhost");

const today = todayIST();
const yesterday = addDaysIST(today, -1);
const now = new Date();
const log = (s: string) => console.log(`[${TAG}] ${s}`);
log(`today (IST) = ${today}`);

const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@digitalsukoon.com" } });
const roleByName = new Map((await prisma.role.findMany()).map((r) => [r.name, r.id] as const));
const roleId = (name: string) => { const id = roleByName.get(name); if (!id) throw new Error(`role "${name}" missing — run the main seed first`); return id; };
const hrRoleName = roleByName.has("HR Manager") ? "HR Manager" : "Admin";
const passwordHash = await hash(PASSWORD, 12); // one hash, same password for everyone seeded here

// ───────────────────────────── 1. people ─────────────────────────────
const PEOPLE = [
  { key: "priya", email: "priya@digitalsukoon.com", name: "Priya Sharma", phone: "+919876543210", role: "Employee", status: "ACTIVE" },
  { key: "arjun", email: "arjun@digitalsukoon.com", name: "Arjun Mehta", phone: "+919876543211", role: "Employee", status: "ACTIVE" },
  { key: "rohan", email: "rohan@digitalsukoon.com", name: "Rohan Verma", phone: "+919876543212", role: "Team Lead", status: "ACTIVE" },
  { key: "meera", email: "meera@digitalsukoon.com", name: "Meera Iyer", phone: "+919876543213", role: hrRoleName, status: "ACTIVE" },
  { key: "newhire", email: "newhire@digitalsukoon.com", name: "Kabir Nair", phone: "+919876543214", role: "Employee", status: "ONBOARDING" },
] as const;
const users: Record<string, { id: string; name: string; email: string }> = {};
for (const p of PEOPLE) {
  const u = await prisma.user.upsert({
    where: { email: p.email },
    create: { email: p.email, name: p.name, phone: p.phone, passwordHash, status: p.status },
    update: { name: p.name, phone: p.phone, passwordHash, status: p.status, deletedAt: null },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: u.id, roleId: roleId(p.role) } },
    create: { userId: u.id, roleId: roleId(p.role) },
    update: {},
  });
  users[p.key] = u;
}
const priya = users.priya, arjun = users.arjun, rohan = users.rohan, meera = users.meera, newhire = users.newhire;
log(`users: ${PEOPLE.map((p) => `${p.email} (${p.role}${p.status !== "ACTIVE" ? `, ${p.status}` : ""})`).join(", ")}`);

// Team: OrgUnit "Content Team" led by Rohan; Priya, Arjun and Rohan are members (primary).
let team = await prisma.orgUnit.findFirst({ where: { name: "Content Team", type: "TEAM" } });
if (!team) team = await prisma.orgUnit.create({ data: { name: "Content Team", type: "TEAM", leadId: rohan.id } });
else team = await prisma.orgUnit.update({ where: { id: team.id }, data: { leadId: rohan.id } });
for (const u of [priya, arjun, rohan]) {
  await prisma.teamMembership.upsert({
    where: { userId_orgUnitId: { userId: u.id, orgUnitId: team.id } },
    create: { userId: u.id, orgUnitId: team.id, isPrimary: true },
    update: { isPrimary: true },
  });
  await prisma.user.update({ where: { id: u.id }, data: { orgUnitId: team.id } });
}
log(`team "${team.name}" (${team.id}) lead=${rohan.email}, members=3`);

// ───────────────────────────── 2. profiles ─────────────────────────────
const profiles = [
  {
    userId: priya.id,
    designation: "Social Media Executive",
    jobDescription: "Runs daily reels and stories for the Bollywood Society and Filmy Fever pages.",
    salary: 45000,
    bankAccountHolderName: "Priya Sharma",
    bankAccountNumber: "50100234567890",
    bankName: "HDFC Bank",
    bankBranch: "Andheri West, Mumbai",
    ifscCode: "HDFC0000123",
    mailingAddress: "B-402, Shanti Residency, Lokhandwala Complex, Andheri West, Mumbai 400053",
    aadhaarNumber: "XXXX-XXXX-4821",
    panNumber: "ABCPS1234K",
    familyContact1Name: "Sunita Sharma",
    familyContact1Phone: "+919812345678",
    familyContact1Relation: "Mother",
    familyContact2Name: "Rakesh Sharma",
    familyContact2Phone: "+919812345679",
    familyContact2Relation: "Father",
    joiningDate: istMidnight("2025-06-01"),
    joiningDateApproved: true,
    sopAcceptedAt: atIST("2025-06-02", "11:15"),
  },
  { userId: arjun.id, designation: "Content Associate", salary: 38000, joiningDate: istMidnight("2025-09-15"), joiningDateApproved: true, sopAcceptedAt: atIST("2025-09-16", "10:40"), bankAccountHolderName: "Arjun Mehta", bankName: "ICICI Bank", ifscCode: "ICIC0000456", bankAccountNumber: "001701234567" },
  { userId: rohan.id, designation: "Team Lead — Content", salary: 65000, joiningDate: istMidnight("2024-02-01"), joiningDateApproved: true, sopAcceptedAt: atIST("2024-02-01", "12:00") },
  { userId: meera.id, designation: "HR Manager", salary: 60000, joiningDate: istMidnight("2024-08-01"), joiningDateApproved: true, sopAcceptedAt: atIST("2024-08-01", "12:00") },
  { userId: newhire.id }, // registerEmployee() creates an empty profile for a self-registered hire
];
for (const p of profiles) {
  const { userId, ...data } = p;
  await prisma.employeeProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}
log(`employee profiles: ${profiles.length}`);

// ───────────────────────────── 3. social accounts + assignments ─────────────────────────────
const platformBySlug = new Map((await prisma.platform.findMany()).map((p) => [p.slug, p] as const));
const platform = (slug: string) => { const p = platformBySlug.get(slug); if (!p) throw new Error(`platform "${slug}" missing — run the main seed first`); return p; };
const ACCOUNTS = [
  { slug: "instagram", handle: "bollywoodsociety", displayName: "Bollywood Society", followers: 4_621_323, url: "https://www.instagram.com/bollywoodsociety/", owner: "priya" },
  { slug: "instagram", handle: "filmyfever", displayName: "Filmy Fever", followers: 1_238_410, url: "https://www.instagram.com/filmyfever/", owner: "priya" },
  { slug: "facebook", handle: "trollbollywood", displayName: "Troll Bollywood", followers: 3_104_552, url: "https://www.facebook.com/trollbollywood", owner: "priya" },
  { slug: "youtube", handle: "BollywoodSocietyTV", displayName: "Bollywood Society TV", followers: 892_000, url: "https://www.youtube.com/@BollywoodSocietyTV", owner: "arjun" },
  { slug: "facebook", handle: "filmyfever", displayName: "Filmy Fever", followers: 2_311_980, url: "https://www.facebook.com/filmyfever", owner: "arjun" },
  { slug: "snapchat", handle: "dashmani.gossip", displayName: "Dashmani Gossip", followers: 152_300, url: "https://www.snapchat.com/@dashmani.gossip", owner: "rohan" },
] as const;
const accountsByOwner: Record<string, Array<{ id: string; slug: string; handle: string; displayName: string }>> = { priya: [], arjun: [], rohan: [] };
for (const a of ACCOUNTS) {
  const pl = platform(a.slug);
  const acc = await prisma.socialAccount.upsert({
    where: { handle_platformId: { handle: a.handle, platformId: pl.id } },
    create: { handle: a.handle, displayName: a.displayName, platformId: pl.id, status: "ACTIVE", profileUrl: a.url, followerCount: a.followers },
    update: { displayName: a.displayName, status: "ACTIVE", profileUrl: a.url, followerCount: a.followers },
  });
  const owner = users[a.owner];
  const live = await prisma.accountAssignment.findFirst({ where: { accountId: acc.id, employeeId: owner.id, unassignedAt: null } });
  if (!live) {
    await prisma.accountAssignment.create({
      data: { accountId: acc.id, employeeId: owner.id, assignedBy: admin.id, assignedAt: atIST(addDaysIST(today, -60), "11:00"), reason: TAG },
    });
  }
  accountsByOwner[a.owner].push({ id: acc.id, slug: a.slug, handle: a.handle, displayName: a.displayName });
}
log(`social accounts: ${ACCOUNTS.length} (priya ${accountsByOwner.priya.length}, arjun ${accountsByOwner.arjun.length}, rohan ${accountsByOwner.rohan.length})`);

// ───────────────────────────── 4. daily reports ─────────────────────────────
/** One report with 3–12 links on `key`, unless a report already exists for that day. */
async function ensureReport(employee: { id: string; email: string }, key: string, accounts: typeof accountsByOwner.priya, opts: { isToday?: boolean; notes?: string } = {}) {
  const rnd = mulberry32(hashStr(`${employee.email}:${key}`));
  const count = 3 + Math.floor(rnd() * 10); // 3..12
  const base = opts.isToday ? new Date(now.getTime() - count * 7 * 60_000) : atIST(key, "11:20");
  const links = Array.from({ length: count }, (_, i) => {
    const acc = accounts[i % accounts.length];
    const seen = new Date(base.getTime() + i * (18 + Math.floor(rnd() * 25)) * 60_000);
    return { accountId: acc.id, platform: acc.slug, url: urlFor(acc.slug, rnd), firstSeenAt: seen, createdAt: seen };
  });
  const submittedAt = opts.isToday ? now : new Date(links[links.length - 1].createdAt.getTime() + 6 * 60_000);
  const existing = await prisma.dailyReport.findUnique({ where: { employeeId_date: { employeeId: employee.id, date: istMidnight(key) } }, include: { _count: { select: { links: true } } } });
  if (existing) return { created: false, links: existing._count.links };
  await prisma.dailyReport.create({
    data: { employeeId: employee.id, date: istMidnight(key), notes: opts.notes ?? null, submittedFrom: TAG, submittedAt, createdAt: submittedAt, links: { create: links } },
  });
  return { created: true, links: count };
}
let reportsCreated = 0, reportsSeen = 0, linksSeen = 0;
for (let d = 14; d >= 1; d--) {
  const key = addDaysIST(today, -d);
  if (dayOfWeekIST(key) === 0) continue; // no Sunday reports
  const r = await ensureReport(priya, key, accountsByOwner.priya, { notes: d % 5 === 0 ? "Posted the trending audio reels first; two carousels scheduled for the evening." : undefined });
  reportsSeen++; linksSeen += r.links; if (r.created) reportsCreated++;
}
for (const [key, isToday] of [[addDaysIST(today, -2), false], [today, true]] as const) {
  const r = await ensureReport(arjun, key, accountsByOwner.arjun, { isToday });
  reportsSeen++; linksSeen += r.links; if (r.created) reportsCreated++;
}
log(`daily reports: ${reportsSeen} (${reportsCreated} new), ${linksSeen} links — none for ${priya.email} today (${today}); ${arjun.email} has one today`);

// ───────────────────────────── 5. tasks ─────────────────────────────
const ig = (h: string) => accountsByOwner.priya.find((a) => a.handle === h)!;
const TASKS = [
  { title: "Post 3 reels on @bollywoodsociety before 6 PM", status: "TODO", priority: "HIGH", dueDate: atIST(addDaysIST(today, 1), "18:00"), accountId: ig("bollywoodsociety").id, createdAt: atIST(yesterday, "09:30"), description: "Use the trending audio from the shared drive. Tag the production house in each caption." },
  { title: "Edit the Diwali teaser for Filmy Fever", status: "IN_PROGRESS", priority: "CRITICAL", dueDate: atIST(addDaysIST(today, 3), "12:00"), accountId: ig("filmyfever").id, createdAt: atIST(addDaysIST(today, -3), "10:05"), description: "30-second vertical cut with the new logo sting at the end.", comments: [
    { author: admin.id, body: "Please keep the first 3 seconds punchy — the hook decides the retention.", at: atIST(addDaysIST(today, -3), "10:20") },
    { author: priya.id, body: "On it — first cut will be ready by tomorrow noon.", at: atIST(addDaysIST(today, -3), "15:45") },
  ] },
  { title: "Draft captions for the weekend celebrity roundup", status: "IN_REVIEW", priority: "MEDIUM", createdAt: atIST(addDaysIST(today, -4), "11:00"), description: "Ten captions, Hinglish, no more than 120 characters each." },
  { title: "Archive last month's Troll Bollywood memes", status: "DONE", priority: "LOW", createdAt: atIST(addDaysIST(today, -9), "16:30"), completedAt: atIST(addDaysIST(today, -2), "17:10"), accountId: ig("trollbollywood").id },
  { title: "Collect 10 trending audio tracks for reels", status: "TODO", priority: "MEDIUM", createdAt: atIST(addDaysIST(today, -1), "14:15"), description: "Instagram audio library + Spotify viral 50 (India)." },
] as const;
let tasksCreated = 0, commentsCreated = 0;
for (const t of TASKS) {
  let task = await prisma.task.findFirst({ where: { title: t.title, assigneeId: priya.id } });
  if (!task) {
    const { comments: _c, ...rest } = t as any;
    task = await prisma.task.create({ data: { ...rest, assigneeId: priya.id, createdById: admin.id } });
    tasksCreated++;
  }
  const wanted = ("comments" in t ? t.comments : []) as ReadonlyArray<{ author: string; body: string; at: Date }>;
  if (wanted.length) {
    const have = await prisma.taskComment.count({ where: { taskId: task.id } });
    if (have < wanted.length) {
      for (const c of wanted) await prisma.taskComment.create({ data: { taskId: task.id, authorId: c.author, body: c.body, createdAt: c.at } });
      commentsCreated += wanted.length;
    }
  }
}
log(`tasks for ${priya.email}: ${TASKS.length} (${tasksCreated} new), comments ${commentsCreated} new`);

// ───────────────────────────── 6. leave ─────────────────────────────
// The balance endpoint derives totals from LEAVE_QUOTAS (casual 12 / sick 6 / earned 15) and
// subtracts APPROVED days in the calendar year — so one approved casual leave is what makes
// "used" non-zero; there is no balance table.
async function ensureLeave(l: { employeeId: string; start: string; end: string; type: "CASUAL" | "SICK" | "EARNED" | "UNPAID" | "WFH" | "COMP_OFF"; status: "PENDING" | "APPROVED" | "REJECTED"; reason: string; createdAt: Date }) {
  const where = { employeeId: l.employeeId, type: l.type, startDate: istMidnight(l.start) };
  const decided = l.status === "PENDING" ? {} : { approvedBy: admin.id, approvedAt: new Date(l.createdAt.getTime() + 26 * 3600_000) };
  const existing = await prisma.leaveRequest.findFirst({ where });
  if (existing) return false;
  await prisma.leaveRequest.create({ data: { ...where, endDate: istMidnight(l.end), status: l.status, reason: l.reason, createdAt: l.createdAt, ...decided } });
  return true;
}
const [ty, tm] = today.split("-").map(Number);
const lastMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${pad2(tm - 1)}`;
const nextMonday = (() => { let k = addDaysIST(today, 1); while (dayOfWeekIST(k) !== 1) k = addDaysIST(k, 1); return k; })();
const leaves = [
  { employeeId: priya.id, start: `${lastMonth}-18`, end: `${lastMonth}-19`, type: "CASUAL" as const, status: "APPROVED" as const, reason: "Cousin's wedding in Jaipur", createdAt: atIST(`${lastMonth}-10`, "09:40") },
  { employeeId: priya.id, start: addDaysIST(nextMonday, 1), end: addDaysIST(nextMonday, 2), type: "SICK" as const, status: "PENDING" as const, reason: "Dental surgery — doctor advised two days of rest", createdAt: atIST(yesterday, "17:25") },
  { employeeId: priya.id, start: `${ty}-08-05`, end: `${ty}-08-05`, type: "SICK" as const, status: "REJECTED" as const, reason: "Viral fever", createdAt: atIST(`${ty}-08-05`, "08:10") },
  { employeeId: arjun.id, start: addDaysIST(nextMonday, 4), end: addDaysIST(nextMonday, 5), type: "CASUAL" as const, status: "PENDING" as const, reason: "Family trip to Lonavala", createdAt: atIST(today, "00:50") },
];
let leavesCreated = 0;
for (const l of leaves) if (await ensureLeave(l)) leavesCreated++;
log(`leave requests: ${leaves.length} (${leavesCreated} new) — pending: priya SICK ${leaves[1].start}, arjun CASUAL ${leaves[3].start}`);

// ───────────────────────────── 7. holidays ─────────────────────────────
const HOLIDAYS = [
  { date: `${ty}-01-26`, name: "Republic Day", type: "PUBLIC" },
  { date: `${ty}-03-04`, name: "Holi", type: "PUBLIC" },
  { date: `${ty}-08-15`, name: "Independence Day", type: "PUBLIC" },
  { date: `${ty}-11-08`, name: "Diwali (Lakshmi Puja)", type: "PUBLIC" },
  { date: `${ty}-11-11`, name: "Bhai Dooj", type: "PUBLIC" },
  { date: `${ty}-12-25`, name: "Christmas", type: "PUBLIC" },
] as const;
for (const h of HOLIDAYS) {
  await prisma.holiday.upsert({ where: { date: istMidnight(h.date) }, create: { date: istMidnight(h.date), name: h.name, type: h.type }, update: { name: h.name, type: h.type } });
}
log(`holidays ${ty}: ${HOLIDAYS.length} (${HOLIDAYS.filter((h) => h.date > today).length} in the future)`);

// ───────────────────────────── 8. attendance ─────────────────────────────
// Priya: the last 20 working days up to yesterday — 17 PRESENT, 2 LATE, 1 ABSENT. Today is left
// for the check-in journey. Arjun and Rohan get the last 10 working days PRESENT.
async function ensureAttendance(employeeId: string, key: string, status: "PRESENT" | "LATE" | "ABSENT", rnd: () => number) {
  const checkIn = status === "ABSENT" ? null : atIST(key, status === "LATE" ? `10:${20 + Math.floor(rnd() * 30)}` : `09:${pad2(28 + Math.floor(rnd() * 30))}`);
  const checkOut = status === "ABSENT" ? null : atIST(key, `18:${pad2(30 + Math.floor(rnd() * 29))}`);
  const hours = checkIn && checkOut ? (checkOut.getTime() - checkIn.getTime()) / 3600_000 : 0;
  const data = { checkIn, checkOut, status, overtimeHours: Math.max(0, Math.round((hours - 9) * 100) / 100), ipAddress: "49.36.12.101", note: status === "ABSENT" ? "No check-in recorded" : null };
  await prisma.attendance.upsert({ where: { employeeId_date: { employeeId, date: istMidnight(key) } }, create: { employeeId, date: istMidnight(key), ...data }, update: data });
}
const priyaDays = workdaysBack(yesterday, 20);
const aRnd = mulberry32(hashStr(`${priya.email}:attendance`));
for (let i = 0; i < priyaDays.length; i++) {
  const status = i === 7 ? "ABSENT" : i === 3 || i === 14 ? "LATE" : "PRESENT";
  await ensureAttendance(priya.id, priyaDays[i], status, aRnd);
}
for (const u of [arjun, rohan]) for (const key of workdaysBack(yesterday, 10)) await ensureAttendance(u.id, key, "PRESENT", mulberry32(hashStr(`${u.email}:${key}`)));
log(`attendance: priya ${priyaDays.length} days (${priyaDays[0]} → ${priyaDays[priyaDays.length - 1]}), arjun/rohan 10 days each`);

// ───────────────────────────── 9. the rest of the HR surface ─────────────────────────────
// Salary slips: the last three completed months (APPROVED, APPROVED, PENDING_APPROVAL — the enum
// has no PAID/PENDING).
const slipMonths = [3, 2, 1].map((back) => { const d = new Date(Date.UTC(ty, tm - 1 - back, 1)); return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() }; });
for (let i = 0; i < slipMonths.length; i++) {
  const { month, year } = slipMonths[i];
  const status = i < 2 ? "APPROVED" : "PENDING_APPROVAL";
  const earn = { basicSalary: 22500, hra: 9000, conveyance: 1600, medicalAllowance: 1250, specialAllowance: 10650, otherEarnings: i === 1 ? 2500 : 0 };
  const ded = { pf: 1800, esi: 0, tax: 1500, otherDeductions: 0 };
  const netSalary = Object.values(earn).reduce((a, b) => a + b, 0) - Object.values(ded).reduce((a, b) => a + b, 0);
  const data = { ...earn, ...ded, netSalary, status, generatedBy: admin.id, remarks: i === 1 ? "Includes September reel incentive" : null, ...(status === "APPROVED" ? { approvedBy: admin.id, approvedAt: atIST(`${year}-${pad2(month)}-28`, "18:00") } : { approvedBy: null, approvedAt: null }) };
  await prisma.salarySlip.upsert({ where: { employeeId_month_year: { employeeId: priya.id, month, year } }, create: { employeeId: priya.id, month, year, ...data }, update: data });
}
log(`salary slips for priya: ${slipMonths.map((m) => `${m.year}-${pad2(m.month)}`).join(", ")}`);

async function ensureOne<T>(find: () => Promise<T | null>, create: () => Promise<T>) { return (await find()) ?? (await create()); }
// Expense claims (PENDING / APPROVED / REJECTED)
const EXPENSES = [
  { title: "Ring light for reel shoots", amount: 2499, category: "EQUIPMENT", status: "PENDING", description: "Needed for the evening studio reels; the old one flickers.", createdAt: atIST(addDaysIST(today, -1), "13:10") },
  { title: "Cab to Film City shoot", amount: 850, category: "TRAVEL", status: "APPROVED", description: "Uber to the Film City set and back", createdAt: atIST(addDaysIST(today, -8), "20:30"), reviewedBy: admin.id, reviewedAt: atIST(addDaysIST(today, -7), "11:00"), reviewNotes: "Approved — attach the receipt next time" },
  { title: "Team lunch at Bandra", amount: 3200, category: "FOOD", status: "REJECTED", description: "Lunch with the content team after the Diwali shoot", createdAt: atIST(addDaysIST(today, -12), "15:45"), reviewedBy: admin.id, reviewedAt: atIST(addDaysIST(today, -11), "10:20"), reviewNotes: "Not pre-approved; team meals go through the lead" },
] as const;
for (const e of EXPENSES) await ensureOne(() => prisma.expenseClaim.findFirst({ where: { employeeId: priya.id, title: e.title } }), () => prisma.expenseClaim.create({ data: { employeeId: priya.id, ...e } }));
// Extra hours (PENDING)
const extraDay = addDaysIST(today, -3);
await ensureOne(() => prisma.extraWorkHour.findFirst({ where: { employeeId: priya.id, date: istMidnight(extraDay) } }), () => prisma.extraWorkHour.create({ data: { employeeId: priya.id, date: istMidnight(extraDay), hours: 2.5, description: "Stayed back for the late-night award show live coverage", status: "PENDING", createdAt: atIST(extraDay, "23:40") } }));
// Incentive
const incentiveReason = "Best performing reel of the month — 2.1M views on @bollywoodsociety";
await ensureOne(() => prisma.incentive.findFirst({ where: { employeeId: priya.id, reason: incentiveReason } }), () => prisma.incentive.create({ data: { employeeId: priya.id, amount: 2500, reason: incentiveReason, month: slipMonths[1].month, year: slipMonths[1].year, awardedBy: admin.id, createdAt: atIST(`${slipMonths[1].year}-${pad2(slipMonths[1].month)}-30`, "17:00") } }));
// Performance review
await ensureOne(() => prisma.performanceReview.findFirst({ where: { employeeId: priya.id, period: `Q2 ${ty} (Jul–Sep)` } }), () => prisma.performanceReview.create({ data: { employeeId: priya.id, reviewerId: rohan.id, period: `Q2 ${ty} (Jul–Sep)`, rating: 4, strengths: "Consistent daily output, strong eye for trending audio, reels regularly outperform the page average.", improvements: "Caption quality is uneven on busy days; plan captions in the morning.", comments: "Ready to own the Filmy Fever page end to end next quarter.", goals: "Grow Filmy Fever reels to a 1M average by December; mentor the new hire on Smart Paste.", createdAt: atIST(`${ty}-10-05`, "16:00") } }));
// Pending document
await ensureOne(() => prisma.employeeDocument.findFirst({ where: { employeeId: priya.id, fileName: "aadhaar-priya-sharma.pdf" } }), () => prisma.employeeDocument.create({ data: { employeeId: priya.id, documentType: "AADHAAR", fileName: "aadhaar-priya-sharma.pdf", filePath: `uploads/documents/${TAG}/aadhaar-priya-sharma.pdf`, fileSize: 184_320, mimeType: "application/pdf", status: "PENDING", createdAt: atIST(addDaysIST(today, -2), "12:30") } }));
// Offer letter + signed contract (so /hr/offer-letters and /hr/contract have rows)
await ensureOne(() => prisma.offerLetter.findFirst({ where: { employeeId: priya.id, letterType: "OFFER" } }), () => prisma.offerLetter.create({ data: { employeeId: priya.id, letterType: "OFFER", offerDate: istMidnight("2025-05-20"), joiningDate: istMidnight("2025-06-01"), designation: "Social Media Executive", department: "Content", salary: 45000, probationMonths: 3, noticePeriod: 30, location: "Mumbai", generatedBy: admin.id, createdAt: atIST("2025-05-20", "15:00") } }));
await ensureOne(() => prisma.employmentContract.findFirst({ where: { employeeId: priya.id, contractDate: istMidnight("2025-06-01") } }), () => prisma.employmentContract.create({ data: { employeeId: priya.id, contractDate: istMidnight("2025-06-01"), designation: "Social Media Executive", department: "Content", salary: 45000, probationMonths: 3, noticePeriod: 30, agreedAt: atIST("2025-06-01", "11:05"), agreedFromIp: "49.36.12.101", createdAt: atIST("2025-05-30", "10:00") } }));
// Assigned device
await ensureOne(() => prisma.assignedDevice.findFirst({ where: { employeeId: priya.id, serialNumber: "C02XK1ABJG5L" } }), () => prisma.assignedDevice.create({ data: { employeeId: priya.id, type: "LAPTOP", brand: "Apple", model: "MacBook Air M2", serialNumber: "C02XK1ABJG5L", assetTag: "DS-LAP-0042", condition: "Good", assignedAt: istMidnight("2025-06-01") } }));
// Announcement (org-wide, from admin)
const activeUsers = await prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } });
const announcement = await ensureOne(() => prisma.announcement.findFirst({ where: { title: "Diwali week schedule" } }), () => prisma.announcement.create({ data: { title: "Diwali week schedule", message: `The office is closed on ${HOLIDAYS[3].name.split(" (")[0]} (${HOLIDAYS[3].date}) and ${HOLIDAYS[4].name} (${HOLIDAYS[4].date}). Daily reports are still due on the working days in between — schedule your reels in advance and mark WFH in the portal if you are travelling.`, sentById: admin.id, recipientCount: activeUsers, orgUnitId: null, createdAt: atIST(addDaysIST(today, -1), "10:00") } }));
// Complaints
await ensureOne(() => prisma.complaint.findFirst({ where: { employeeId: priya.id, subject: "Laptop charger stopped working" } }), () => prisma.complaint.create({ data: { employeeId: priya.id, subject: "Laptop charger stopped working", description: "The MacBook charger (asset DS-LAP-0042) heats up and cuts out after ten minutes. I am borrowing Arjun's in the meantime.", category: "IT", status: "OPEN", createdAt: atIST(addDaysIST(today, -1), "11:45") } }));
await ensureOne(() => prisma.complaint.findFirst({ where: { employeeId: arjun.id, subject: "August salary credited late" } }), () => prisma.complaint.create({ data: { employeeId: arjun.id, subject: "August salary credited late", description: "The August salary reached my account on the 9th instead of the 1st.", category: "PAYROLL", status: "RESOLVED", adminResponse: "Bank NEFT batch was delayed on our side; September onwards it is scheduled for the 1st.", resolvedAt: atIST(`${ty}-09-12`, "16:20"), createdAt: atIST(`${ty}-09-10`, "09:15") } }));
// Bug report
await ensureOne(() => prisma.bugReport.findFirst({ where: { reportedBy: priya.id, title: "Report page loses pasted links after rotating the phone" } }), () => prisma.bugReport.create({ data: { reportedBy: priya.id, title: "Report page loses pasted links after rotating the phone", description: "Pasted 12 links with Smart Paste, rotated the phone to landscape to check a caption, and the rows were gone when I rotated back. Draft auto-save brought back 9 of them.", page: "/report", severity: "MEDIUM", status: "OPEN", createdAt: atIST(addDaysIST(today, -4), "19:05") } }));
// POAs: Priya's last 5 working days (not today); Arjun today — /admin/daily-reports/status counts POA rows.
for (const key of workdaysBack(yesterday, 5)) {
  await prisma.dailyPOA.upsert({ where: { employeeId_date: { employeeId: priya.id, date: istMidnight(key) } }, create: { employeeId: priya.id, date: istMidnight(key), tasks: "3 reels on Bollywood Society, 2 reels + 1 carousel on Filmy Fever, meme batch for Troll Bollywood", achievements: "All reels posted before 6 PM; one crossed 400k views by evening", blockers: null, tomorrowPlan: "Shoot the Diwali teaser; start the celebrity roundup captions", createdAt: atIST(key, "09:50") }, update: {} });
}
await prisma.dailyPOA.upsert({ where: { employeeId_date: { employeeId: arjun.id, date: istMidnight(today) } }, create: { employeeId: arjun.id, date: istMidnight(today), tasks: "Two YouTube shorts from yesterday's interview; FB reel cross-posts", achievements: null, blockers: "Waiting on the raw footage from the editor", tomorrowPlan: "Thumbnail refresh for the top 5 shorts" }, update: {} });
log("expenses 3, extra-hours 1, incentive 1, review 1, document 1, offer letter 1, contract 1, device 1, announcement 1, complaints 2, bug report 1, POAs 6");

// ───────────────────────────── 10. notifications ─────────────────────────────
const firstTask = await prisma.task.findFirst({ where: { title: TASKS[0].title, assigneeId: priya.id } });
const NOTIFS = [
  { userId: priya.id, type: "TASK_ASSIGNED", title: "New task assigned to you", message: `${admin.name} assigned you "${TASKS[0].title}"`, read: false, metadata: { taskId: firstTask?.id ?? null }, createdAt: atIST(yesterday, "09:31") },
  { userId: priya.id, type: "ANNOUNCEMENT", title: "Diwali week schedule", message: "Office closed on Diwali and Bhai Dooj — reports still due on the working days in between.", read: false, metadata: { announcementId: announcement.id }, createdAt: atIST(yesterday, "10:00") },
  { userId: priya.id, type: "LEAVE_APPROVED", title: "Leave approved", message: `Your CASUAL leave for ${leaves[0].start} to ${leaves[0].end} was approved.`, read: true, metadata: { type: "CASUAL" }, createdAt: atIST(`${lastMonth}-11`, "12:05") },
  { userId: priya.id, type: "SALARY_SLIP", title: `Salary slip for ${slipMonths[1].year}-${pad2(slipMonths[1].month)} is ready`, message: "Your salary slip has been approved and is available in the portal.", read: true, metadata: { month: slipMonths[1].month, year: slipMonths[1].year }, createdAt: atIST(`${slipMonths[1].year}-${pad2(slipMonths[1].month)}-28`, "18:05") },
  { userId: priya.id, type: "REPORT_REMINDER", title: "Daily Report Reminder", message: "You haven't submitted today's daily report yet.", read: true, metadata: { date: addDaysIST(today, -6) }, createdAt: atIST(addDaysIST(today, -6), "16:00") },
  { userId: admin.id, type: "LEAVE_REQUEST", title: "New CASUAL Request", message: `${arjun.name} has requested CASUAL from ${leaves[3].start} to ${leaves[3].end}`, read: false, metadata: { type: "CASUAL", employeeId: arjun.id }, createdAt: atIST(today, "00:51") },
  { userId: admin.id, type: "GENERAL", title: "New Expense Claim", message: `${priya.name} submitted an expense claim of ₹2499 for "Ring light for reel shoots"`, read: false, metadata: { employeeId: priya.id }, createdAt: atIST(addDaysIST(today, -1), "13:11") },
  { userId: admin.id, type: "GENERAL", title: "New Employee Registration", message: `${newhire.name} (${newhire.email}) has created an account and is waiting for approval — set them Active on the Employees page`, read: false, metadata: { userId: newhire.id, name: newhire.name, email: newhire.email }, createdAt: atIST(addDaysIST(today, -1), "18:40") },
] as const;
let notifsCreated = 0;
for (const n of NOTIFS) {
  const existing = await prisma.notification.findFirst({ where: { userId: n.userId, title: n.title } });
  if (!existing) { await prisma.notification.create({ data: { ...n, metadata: n.metadata as any } }); notifsCreated++; }
}
log(`notifications: priya 5 (2 unread), admin 3 (unread) — ${notifsCreated} new`);

// ───────────────────────────── 11. admin-side richness ─────────────────────────────
const job = await ensureOne(() => prisma.jobListing.findFirst({ where: { title: "Social Media Executive (Reels)" } }), () => prisma.jobListing.create({ data: { title: "Social Media Executive (Reels)", department: "Content", location: "Mumbai (Andheri West)", type: "FULL_TIME", experience: "1–3 years", salary: "₹3.6–5.4 LPA", description: "Own the daily reel output for two Bollywood entertainment pages: trend spotting, editing short vertical video, captions and scheduling.", requirements: "Hands-on with CapCut/Premiere, fluent Hinglish captions, Instagram and YouTube Shorts analytics.", responsibilities: "6–10 reels a day across pages, daily report in the HR portal, weekly performance review with the lead.", benefits: "Health insurance, performance incentives, six paid leaves a month cap-free WFH.", status: "ACTIVE", createdBy: admin.id, createdAt: atIST(addDaysIST(today, -20), "11:00") } }));
const APPLICANTS = [
  { applicantName: "Sneha Kulkarni", applicantEmail: "sneha.kulkarni@example.com", applicantPhone: "+919820011223", experience: "2 years", currentCompany: "Pinkvilla", status: "RECEIVED", coverLetter: "I run reels for a 900k entertainment page and would love to bring that to Digital Sukoon.", createdAt: atIST(addDaysIST(today, -3), "14:20") },
  { applicantName: "Dev Malhotra", applicantEmail: "dev.malhotra@example.com", applicantPhone: "+919820033445", experience: "3 years", currentCompany: "Freelance", status: "SHORTLISTED", linkedinUrl: "https://www.linkedin.com/in/dev-malhotra-example", notes: "Strong portfolio; schedule a 30-min call", reviewedBy: admin.id, createdAt: atIST(addDaysIST(today, -6), "10:10") },
] as const;
for (const a of APPLICANTS) await ensureOne(() => prisma.jobApplication.findFirst({ where: { jobId: job.id, applicantEmail: a.applicantEmail } }), () => prisma.jobApplication.create({ data: { jobId: job.id, ...a } }));
log(`job listing "${job.title}" with ${APPLICANTS.length} applications; pending registration ${newhire.email}`);

// SOP content: seeded only when nothing is stored (never overwrite an admin's edits). Each section
// carries both `items` (HR portal) and `content` (mobile renders s.content).
const SOP_SECTIONS = [
  { icon: "Clock", title: "Working Hours & Attendance", items: ["Standard working hours are 10:00 AM to 7:00 PM, Monday to Saturday.", "Mark attendance daily in the app; arrivals after 10:15 AM are recorded as late.", "Work from home must be requested and approved in advance."] },
  { icon: "ScrollText", title: "Daily Reports", items: ["Submit the daily report with every link you posted before the end of the day.", "Use Smart Paste; the app removes duplicate links automatically.", "A missed report shows in the leaderboard and the admin dashboard."] },
  { icon: "Users", title: "Leave & Time-Off", items: ["12 casual, 6 sick and 15 earned leaves a year.", "Apply in the app at least two working days ahead except for sick leave.", "Sunday is the only weekend day."] },
  { icon: "Shield", title: "Data & Social Media", items: ["Never share page logins; every account is assigned to one person.", "No personal posts from company pages.", "Report a suspicious login to the team lead immediately."] },
  { icon: "AlertTriangle", title: "Conduct & Exit", items: ["Thirty days' notice on either side after probation.", "Return assigned devices on the last working day.", "Complaints go through the app and are answered within three working days."] },
].map((s) => ({ ...s, content: s.items.join(" ") }));
await prisma.systemSetting.upsert({ where: { key: "sop_sections" }, create: { key: "sop_sections", value: JSON.stringify(SOP_SECTIONS) }, update: {} });

// ───────────────────────────── 12. pipeline ─────────────────────────────
// The tables come from `prisma db push`; the board row and the 7 phases are seeded ONLY by
// scripts/pipeline-ddl.sql (applied by hand on prod), so a dev database has the tables and no
// rows — the API then logs "pipeline_board_state row 1 is missing". Seed exactly what the DDL
// seeds (same keys, names, positions, terminal flag), then switch the feature on for HR users.
const [{ ok: pipelineTable }] = await prisma.$queryRawUnsafe<Array<{ ok: string | null }>>(`SELECT to_regclass('public.pipeline_board_state')::text AS ok`);
if (!pipelineTable) {
  log("pipeline: tables missing — apply scripts/pipeline-ddl.sql with psql first; skipped");
} else {
  await prisma.pipelineBoardState.upsert({ where: { id: 1 }, create: { id: 1, seq: 0 }, update: {} });
  const PHASES = [["brief", "Brief", 1], ["planning", "Planning", 2], ["in_production", "In Production", 3], ["review", "Review", 4], ["approved", "Approved", 5], ["live", "Live", 6], ["done", "Done", 7]] as const;
  for (const [key, name, position] of PHASES) {
    await prisma.pipelinePhase.upsert({ where: { key }, create: { key, name, position, isTerminal: key === "done" }, update: {} });
  }
  await prisma.systemSetting.upsert({ where: { key: "pipeline.mode" }, create: { key: "pipeline.mode", value: "on" }, update: { value: "on" } });
  const phaseId = async (key: string) => (await prisma.pipelinePhase.findUniqueOrThrow({ where: { key } })).id;

  const PROJECTS = [
    { clientId: `${TAG}-p1`, title: "Diwali campaign — Bollywood Society reels", description: "Six festive reels plus a story series for the Diwali week. Brand tie-in with the Filmy Fever rebrand teaser.", owner: admin, phase: "in_production", start: addDaysIST(today, -10), due: addDaysIST(today, 5), members: [priya], messages: [
      { clientId: `${TAG}-p1-m1`, author: admin, body: "Brief is final — six reels, one a day from the 3rd. Priya owns the Bollywood Society side.", at: atIST(addDaysIST(today, -9), "10:30") },
      { clientId: `${TAG}-p1-m2`, author: priya, body: "First two reels are cut; sharing the drive link tonight. Audio cleared for all six.", at: atIST(addDaysIST(today, -2), "19:10") },
      { clientId: `${TAG}-p1-m3`, author: admin, body: `@{${priya.id}} looks great — please add the sponsor tag on reel 2 before it goes live.`, mentions: [priya.id], at: atIST(yesterday, "11:45") },
    ] },
    { clientId: `${TAG}-p2`, title: "Filmy Fever rebrand — new logo + bio", description: "New logo sting, profile grid refresh and bio copy for Instagram and Facebook.", owner: rohan, phase: "planning", start: addDaysIST(today, -3), due: addDaysIST(today, 14), members: [priya, arjun], messages: [] },
  ];
  let projectsCreated = 0, messagesCreated = 0;
  for (const p of PROJECTS) {
    const everyone = [p.owner, ...p.members];
    let project = await prisma.pipelineProject.findUnique({ where: { createdById_clientId: { createdById: p.owner.id, clientId: p.clientId } } });
    if (!project) {
      const createdAt = atIST(p.start, "10:00");
      project = await prisma.pipelineProject.create({
        data: {
          clientId: p.clientId, title: p.title, description: p.description, ownerId: p.owner.id, createdById: p.owner.id,
          phaseId: await phaseId(p.phase), rank: keyBetween(null, null),
          startDate: istMidnight(p.start), dueDate: istMidnight(p.due), memberCount: everyone.length, phaseChangedAt: createdAt, phaseChangedById: p.owner.id,
          createdAt, updatedAt: createdAt,
          participants: { create: everyone.map((u, i) => ({ userId: u.id, role: "MEMBER", notify: true, memberAddedById: i === 0 ? null : p.owner.id, memberAddedAt: i === 0 ? null : createdAt, createdAt: new Date(createdAt.getTime() + i) })) },
        },
      });
      projectsCreated++;
    }
    if (p.messages.length && (await prisma.pipelineMessage.count({ where: { projectId: project.id } })) === 0) {
      // Mirrors postMessage(): seq and rev advance together, the project's counters follow, the
      // author's read cursor moves to their own message, and every message gets a stable clientId.
      for (let i = 0; i < p.messages.length; i++) {
        const m = p.messages[i];
        await prisma.pipelineMessage.create({ data: { clientId: m.clientId, projectId: project.id, seq: i + 1, rev: i + 1, authorId: m.author.id, body: m.body, mentionIds: m.mentions ?? [], createdAt: m.at, updatedAt: m.at } });
        await prisma.pipelineParticipant.update({ where: { projectId_userId: { projectId: project.id, userId: m.author.id } }, data: { lastReadSeq: i + 1, engagedAt: m.at } });
        messagesCreated++;
      }
      const last = p.messages[p.messages.length - 1];
      await prisma.pipelineProject.update({ where: { id: project.id }, data: { lastMessageSeq: p.messages.length, threadRev: p.messages.length, lastMessageAt: last.at } });
    }
  }
  if (projectsCreated || messagesCreated) await prisma.pipelineBoardState.update({ where: { id: 1 }, data: { seq: { increment: 1 } } });
  log(`pipeline: board row + ${PHASES.length} phases, mode=on, projects ${PROJECTS.length} (${projectsCreated} new), messages ${messagesCreated} new — the API re-reads the mode within 15 s`);
}

// ───────────────────────────── summary ─────────────────────────────
const counts = {
  users: await prisma.user.count({ where: { email: { in: PEOPLE.map((p) => p.email) } } }),
  accounts: await prisma.socialAccount.count(),
  assignments: await prisma.accountAssignment.count({ where: { unassignedAt: null } }),
  reports: await prisma.dailyReport.count({ where: { employeeId: { in: [priya.id, arjun.id] } } }),
  links: await prisma.reportLink.count({ where: { report: { employeeId: { in: [priya.id, arjun.id] } } } }),
  tasks: await prisma.task.count({ where: { assigneeId: priya.id } }),
  leaves: await prisma.leaveRequest.count(),
  pendingLeaves: await prisma.leaveRequest.count({ where: { status: "PENDING" } }),
  holidays: await prisma.holiday.count(),
  attendance: await prisma.attendance.count({ where: { employeeId: priya.id } }),
  notifications: await prisma.notification.count({ where: { userId: { in: [priya.id, admin.id] } } }),
  salarySlips: await prisma.salarySlip.count({ where: { employeeId: priya.id } }),
  expenses: await prisma.expenseClaim.count({ where: { employeeId: priya.id } }),
  pipelineProjects: pipelineTable ? await prisma.pipelineProject.count() : "n/a",
};
log(`ready: ${JSON.stringify(counts)}`);
log(`sign in (HR/mobile) with any of ${PEOPLE.filter((p) => p.status === "ACTIVE").map((p) => p.email).join(", ")} / ${PASSWORD}`);
await prisma.$disconnect();

}
main().catch((e) => { console.error(e); process.exit(1); });
