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

// Monotonic counter so each seedBase() Platform row gets a unique name+slug.
let seedCounter = 0;

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
  // Platform.name is @unique — use a unique name so a leftover row from a prior run
  // (this is the prod-mirror DB) doesn't 409 this create. The tests only use platform.id
  // (FK); the name string is never asserted, so uniquifying it is safe.
  const uniq = `${Date.now()}_${seedCounter++}`;
  const platform = await prisma.platform.create({
    data: { name: `YT_${uniq}`, slug: `yt-${uniq}` },
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

  it("coverage exposes honest searchable/unsearchable/submitted (self-healing accuracy)", async () => {
    if (!dbAvailable) return;

    const NAME = `${NAME_PREFIX}Salman`;
    await seedEntityWithContent(NAME); // 2 'ok' (searchable) youtube rows
    // a not_found row = ATTEMPTED but UNSEARCHABLE — must NOT count toward searchable
    await prisma.linkContent.create({
      data: { canonicalKey: `${KEY_PREFIX}NF1`, platform: "facebook", status: "not_found" },
    });

    const res = await searchLinksByEntity({ q: NAME });
    const c = res.coverage;

    // honest fields present and self-consistent
    expect(c.searchable).toBeGreaterThanOrEqual(2);
    expect(c.unsearchable).toBeGreaterThanOrEqual(1); // the not_found row
    // legacy alias holds: enriched == searchable
    expect(c.enriched).toBe(c.searchable);
    // a not_found FB row contributes to unsearchable, never to searchable
    const fb = c.byPlatform.facebook;
    expect(fb).toBeTruthy();
    expect(fb.searchable).toBe(0);
    expect(fb.unsearchable).toBeGreaterThanOrEqual(1);
    // submitted is the report_links denominator (>= 0; may be 0 in an isolated test DB)
    expect(typeof c.submitted).toBe("number");
    expect(c.submitted).toBeGreaterThanOrEqual(0);
  });

  it("coverage.byPlatform[platform].since = earliest enriched createdAt, and does NOT drift with fetchedAt (F9)", async () => {
    if (!dbAvailable) return;

    // `since` is the date we FIRST captured a caption = min(createdAt), which is
    // immutable. It must NOT track fetchedAt (which upsertLinkContent bumps on every
    // re-harvest → would drift forward). Seed an early-createdAt row whose fetchedAt is
    // LATER than a later-createdAt row's: `since` must still be the early createdAt.
    const earlyCreated = new Date("2026-06-23T05:00:00.000Z");
    const lateCreated = new Date("2026-06-25T09:30:00.000Z");
    await prisma.linkContent.create({
      // earliest createdAt, but a RECENT fetchedAt (re-harvested) — must still win `since`
      data: { canonicalKey: `${KEY_PREFIX}S1A`, platform: "youtube", status: "ok", createdAt: earlyCreated, fetchedAt: new Date() },
    });
    await prisma.linkContent.create({
      data: { canonicalKey: `${KEY_PREFIX}S1B`, platform: "youtube", status: "ok", createdAt: lateCreated, fetchedAt: lateCreated },
    });

    const res = await searchLinksByEntity({ q: "" });
    const yt = res.coverage.byPlatform.youtube;
    expect(yt).toBeTruthy();
    expect(yt.since).toBeTruthy();
    // `since` reflects the earliest createdAt (06-23), NOT the recent fetchedAt bump.
    expect(new Date(yt.since!).getTime()).toBeLessThanOrEqual(earlyCreated.getTime());
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

  it("exact-name match resolves directly even when it's a SUBSTRING of a longer entity (no infinite disambiguation) — F4 fix", async () => {
    if (!dbAvailable) return;

    // "Kareena Kapoor" is a substring of "Kareena Kapoor Khan" → a `contains` query for
    // the shorter name matches BOTH and used to disambiguate forever (the shorter name
    // was unreachable). An EXACT-name query must now resolve straight to it.
    const SHORT = `${NAME_PREFIX}Kareena Kapoor`;
    const LONG = `${NAME_PREFIX}Kareena Kapoor Khan`;
    await seedEntityWithContent(SHORT); // give the short entity real content
    await prisma.entity.create({ data: { canonicalName: LONG, type: "PERSON", aliases: [] } });

    // Exact query for the short name → resolves to the short entity, NOT disambiguation.
    const res = await searchLinksByEntity({ q: SHORT });
    expect(res.entity).not.toBeNull();
    expect(res.entity!.canonicalName).toBe(SHORT);
    expect(res.disambiguation ?? []).toHaveLength(0);

    // A genuine partial (matches both, exact-matches neither) still disambiguates.
    const partial = await searchLinksByEntity({ q: `${NAME_PREFIX}Kareena` });
    expect(partial.entity).toBeNull();
    expect(partial.disambiguation!.length).toBeGreaterThanOrEqual(2);
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
