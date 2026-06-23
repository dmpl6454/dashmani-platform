import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";
import { searchLinksByEntity, listEntities } from "../src/services/link-search.service";

// ── DB-backed tests (skip cleanly if no DB) ───────────────────────────────
// setup.ts's TRUNCATE covers report_links / daily_reports / social_accounts /
// platforms / users (re-seeded inside each test below), but does NOT cover
// entities / link_content / link_content_entities — so this file owns the
// cleanup of those three. Distinctive prefixes keep us off real data.
const NAME_PREFIX = "ZZTEST_";
const KEY_PREFIX = "yt:ZZTESTvid"; // followed by an 11-char-ending video id

// Two real-shaped 11-char YouTube video ids so canonicalKey() yields yt:<id>.
const VID1 = "ZZTESTvid01"; // 11 chars [A-Za-z0-9_-]
const VID2 = "ZZTESTvid02";
const URL1 = `https://www.youtube.com/watch?v=${VID1}`;
const URL2 = `https://youtu.be/${VID2}`;

let dbAvailable = false;

async function cleanupEntities() {
  // FK order: join rows first, then content + entities.
  await prisma.linkContentEntity.deleteMany({
    where: {
      OR: [
        { content: { canonicalKey: { startsWith: KEY_PREFIX } } },
        { entity: { canonicalName: { startsWith: NAME_PREFIX } } },
      ],
    },
  });
  await prisma.linkContent.deleteMany({ where: { canonicalKey: { startsWith: KEY_PREFIX } } });
  await prisma.entity.deleteMany({ where: { canonicalName: { startsWith: NAME_PREFIX } } });
}

beforeAll(async () => {
  try {
    await cleanupEntities();
    dbAvailable = true;
  } catch (err) {
    console.warn("[link-search.test] DB unavailable — skipping DB-backed tests:", err);
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (dbAvailable) await cleanupEntities();
});

afterAll(async () => {
  if (dbAvailable) {
    try {
      await cleanupEntities();
    } catch {
      /* ignore cleanup error */
    }
  }
});

/**
 * Seed the base records report_links need (platform, account, employees, daily
 * reports). These live in tables the global TRUNCATE wipes each test, so they
 * are created fresh here. Returns ids the tests use to build report_links.
 */
async function seedBase() {
  const platform = await prisma.platform.create({
    data: { name: "YouTube", slug: `yt-${Date.now()}` },
  });
  const accountA = await prisma.socialAccount.create({
    data: { handle: "channelA", displayName: "Channel A", platformId: platform.id },
  });
  const accountB = await prisma.socialAccount.create({
    data: { handle: "channelB", displayName: "Channel B", platformId: platform.id },
  });
  async function mkEmployee(suffix: string) {
    const u = await prisma.user.create({
      data: {
        name: `ZZEmp ${suffix}`,
        email: `zzemp-${suffix}-${Date.now()}@example.test`,
        passwordHash: "x",
        status: "ACTIVE",
      },
    });
    return u;
  }
  const emp1 = await mkEmployee("1");
  const emp2 = await mkEmployee("2");
  const emp3 = await mkEmployee("3");

  return { platform, accountA, accountB, emp1, emp2, emp3 };
}

// daily_reports has @@unique([employeeId, date]) — one report per employee per
// day, many report_links under it. So reuse (upsert) the report and add a link,
// faithfully modelling how the real submit flow stacks links in one daily report.
async function addLink(args: {
  employeeId: string;
  accountId: string;
  url: string;
  date: Date;
  platform?: string;
}) {
  const report = await prisma.dailyReport.upsert({
    where: { employeeId_date: { employeeId: args.employeeId, date: args.date } },
    create: { employeeId: args.employeeId, date: args.date },
    update: {},
  });
  await prisma.reportLink.create({
    data: {
      reportId: report.id,
      accountId: args.accountId,
      url: args.url,
      platform: args.platform ?? "youtube",
    },
  });
  return report;
}

/** Create the entity + two LinkContent rows joined to it (VID1 + VID2). */
async function seedEntityWithContent(name: string, aliases: string[] = []) {
  const entity = await prisma.entity.create({
    data: { canonicalName: name, type: "PERSON", aliases },
  });
  const c1 = await prisma.linkContent.create({
    data: { canonicalKey: canonicalKey(URL1), platform: "youtube", status: "ok", extractedAt: new Date() },
  });
  const c2 = await prisma.linkContent.create({
    data: { canonicalKey: canonicalKey(URL2), platform: "youtube", status: "ok", extractedAt: new Date() },
  });
  await prisma.linkContentEntity.create({ data: { linkContentId: c1.id, entityId: entity.id, confidence: 1 } });
  await prisma.linkContentEntity.create({ data: { linkContentId: c2.id, entityId: entity.id, confidence: 1 } });
  return { entity, c1, c2 };
}

describe("searchLinksByEntity — same vs unique (DB-backed)", () => {
  it("counts every matching row (totalPosts) and distinct canonicalKey (uniquePosts); duplicates carry dupCount", async () => {
    if (!dbAvailable) return; // skipped — DB unavailable

    const { accountA, accountB, emp1, emp2, emp3 } = await seedBase();
    const NAME = `${NAME_PREFIX}Salman`;
    await seedEntityWithContent(NAME);

    const day = new Date("2026-06-01T00:00:00.000Z");
    // VID1 submitted 3x across 3 different employees/reports (same post)
    await addLink({ employeeId: emp1.id, accountId: accountA.id, url: URL1, date: day });
    await addLink({ employeeId: emp2.id, accountId: accountA.id, url: URL1, date: day });
    await addLink({ employeeId: emp3.id, accountId: accountB.id, url: URL1, date: day });
    // VID2 submitted once
    await addLink({ employeeId: emp1.id, accountId: accountB.id, url: URL2, date: day });

    const res = await searchLinksByEntity({ q: NAME });

    expect(res.entity).not.toBeNull();
    expect(res.entity!.canonicalName).toBe(NAME);
    expect(res.totalPosts).toBe(4);
    expect(res.uniquePosts).toBe(2);
    expect(res.duplicatePosts).toBe(2);

    // Every VID1 post row should carry dupCount=3
    const vid1Posts = res.posts.filter((p) => p.canonicalKey === canonicalKey(URL1));
    expect(vid1Posts).toHaveLength(3);
    expect(vid1Posts.every((p) => p.dupCount === 3)).toBe(true);

    const vid2Posts = res.posts.filter((p) => p.canonicalKey === canonicalKey(URL2));
    expect(vid2Posts).toHaveLength(1);
    expect(vid2Posts[0].dupCount).toBe(1);
  });

  it("channelCount = distinct accounts; channels[].postCount is correct per account", async () => {
    if (!dbAvailable) return;

    const { accountA, accountB, emp1, emp2, emp3 } = await seedBase();
    const NAME = `${NAME_PREFIX}Salman`;
    await seedEntityWithContent(NAME);

    const day = new Date("2026-06-01T00:00:00.000Z");
    // accountA: 2 posts (VID1 x2), accountB: 2 posts (VID1 x1 + VID2 x1)
    await addLink({ employeeId: emp1.id, accountId: accountA.id, url: URL1, date: day });
    await addLink({ employeeId: emp2.id, accountId: accountA.id, url: URL1, date: day });
    await addLink({ employeeId: emp3.id, accountId: accountB.id, url: URL1, date: day });
    await addLink({ employeeId: emp1.id, accountId: accountB.id, url: URL2, date: day });

    const res = await searchLinksByEntity({ q: NAME });

    expect(res.channelCount).toBe(2);
    const a = res.channels.find((c) => c.accountId === accountA.id);
    const b = res.channels.find((c) => c.accountId === accountB.id);
    expect(a?.postCount).toBe(2);
    expect(b?.postCount).toBe(2);
    expect(a?.handle).toBe("channelA");
  });

  it("coverage reflects enriched ('ok') vs not-yet-enriched ('pending') LinkContent", async () => {
    if (!dbAvailable) return;

    const NAME = `${NAME_PREFIX}Salman`;
    await seedEntityWithContent(NAME); // 2 'ok' rows (VID1, VID2)
    // an extra pending row in the same prefix space (not joined to anyone)
    await prisma.linkContent.create({
      data: { canonicalKey: `${KEY_PREFIX}99X`, platform: "youtube", status: "pending" },
    });

    const res = await searchLinksByEntity({ q: NAME });

    // Scope-tolerant: assert the deltas we seeded are reflected.
    expect(res.coverage.total).toBeGreaterThanOrEqual(3);
    expect(res.coverage.enriched).toBeGreaterThanOrEqual(2);
    expect(res.coverage.notYetEnriched).toBeGreaterThanOrEqual(1);
    expect(res.coverage.enriched + res.coverage.notYetEnriched).toBe(res.coverage.total);
    // per-platform youtube bucket present
    expect(res.coverage.byPlatform.youtube).toBeTruthy();
    expect(res.coverage.byPlatform.youtube.total).toBeGreaterThanOrEqual(3);
  });

  it("resolves the entity by an exact alias (case-insensitive input)", async () => {
    if (!dbAvailable) return;

    const NAME = `${NAME_PREFIX}Salman`;
    // alias stored lowercase
    await seedEntityWithContent(NAME, ["zztest sallu"]);

    const res = await searchLinksByEntity({ q: "ZZTEST Sallu" });
    expect(res.entity).not.toBeNull();
    expect(res.entity!.canonicalName).toBe(NAME);
  });

  it(">1 matching entity → disambiguation populated, entity null", async () => {
    if (!dbAvailable) return;

    // both share the substring 'Khan' → partial canonicalName match returns 2
    await prisma.entity.create({ data: { canonicalName: `${NAME_PREFIX}Salman Khan`, type: "PERSON", aliases: [] } });
    await prisma.entity.create({ data: { canonicalName: `${NAME_PREFIX}Aamir Khan`, type: "PERSON", aliases: [] } });

    const res = await searchLinksByEntity({ q: "ZZTEST_" });
    expect(res.entity).toBeNull();
    expect(res.disambiguation).toBeDefined();
    expect(res.disambiguation!.length).toBeGreaterThanOrEqual(2);
  });

  it("empty q → zero result but coverage still filled", async () => {
    if (!dbAvailable) return;

    await seedEntityWithContent(`${NAME_PREFIX}Salman`); // 2 'ok' rows exist

    const res = await searchLinksByEntity({ q: "" });
    expect(res.entity).toBeNull();
    expect(res.totalPosts).toBe(0);
    expect(res.uniquePosts).toBe(0);
    expect(res.coverage.total).toBeGreaterThanOrEqual(2);
  });

  it("OOM-safety: only report_links matching the entity's canonicalKeys are returned (a foreign post is excluded)", async () => {
    if (!dbAvailable) return;

    const { accountA, emp1 } = await seedBase();
    const NAME = `${NAME_PREFIX}Salman`;
    await seedEntityWithContent(NAME); // joined to VID1 + VID2 only

    const day = new Date("2026-06-01T00:00:00.000Z");
    await addLink({ employeeId: emp1.id, accountId: accountA.id, url: URL1, date: day });
    // A completely unrelated post NOT joined to the entity — must be excluded.
    const FOREIGN = "https://www.youtube.com/watch?v=ZZFOREIGNxx"; // 11-char id, different
    await addLink({ employeeId: emp1.id, accountId: accountA.id, url: FOREIGN, date: day });

    const res = await searchLinksByEntity({ q: NAME });
    expect(res.totalPosts).toBe(1); // only VID1; FOREIGN excluded
    expect(res.posts.every((p) => p.canonicalKey !== canonicalKey(FOREIGN))).toBe(true);
  });

  it("platform filter narrows the matched rows", async () => {
    if (!dbAvailable) return;

    const { accountA, emp1 } = await seedBase();
    const NAME = `${NAME_PREFIX}Salman`;
    await seedEntityWithContent(NAME);

    const day = new Date("2026-06-01T00:00:00.000Z");
    await addLink({ employeeId: emp1.id, accountId: accountA.id, url: URL1, date: day });

    const matchYt = await searchLinksByEntity({ q: NAME, platform: "youtube" });
    expect(matchYt.totalPosts).toBe(1);

    const matchIg = await searchLinksByEntity({ q: NAME, platform: "instagram" });
    expect(matchIg.totalPosts).toBe(0);
  });
});

describe("listEntities — autocomplete (DB-backed)", () => {
  it("returns up to 10 entities matching name substring or exact alias, asc by name", async () => {
    if (!dbAvailable) return;

    await prisma.entity.create({ data: { canonicalName: `${NAME_PREFIX}Bravo`, type: "PERSON", aliases: ["zzalias-x"] } });
    await prisma.entity.create({ data: { canonicalName: `${NAME_PREFIX}Alpha`, type: "TOPIC", aliases: [] } });

    const byName = await listEntities("ZZTEST_");
    expect(byName.length).toBeGreaterThanOrEqual(2);
    // ascending: Alpha before Bravo
    const names = byName.map((e) => e.canonicalName);
    expect(names.indexOf(`${NAME_PREFIX}Alpha`)).toBeLessThan(names.indexOf(`${NAME_PREFIX}Bravo`));

    const byAlias = await listEntities("zzalias-x");
    expect(byAlias.some((e) => e.canonicalName === `${NAME_PREFIX}Bravo`)).toBe(true);
  });
});
