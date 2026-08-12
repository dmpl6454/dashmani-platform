import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";
import {
  getTrueLinksBreakdown,
  invalidateTrueLinksCache,
  type TrueLinksBreakdown,
} from "../src/services/true-links.service";
import { createTestUser, createTestRole } from "./helpers";
import "./setup";

/**
 * CHARACTERIZATION LOCK: the service's SQL derived-key CASE must produce the SAME
 * grouping as the JS canonicalKey() arbiter over the same rows. This is the 4th
 * copy of the derived-key CASE in the codebase — this test is what stops it from
 * silently drifting (the documented failure mode: PR #104 found the coverage CTE
 * dropping watch?v= links via the cooked-backslash trap; an early draft of this
 * service would have merged unrelated URLs into one NULL group).
 *
 * The expected values are computed HERE, in JS, by running canonicalKey() over the
 * exact rows we seeded — never hand-written constants — so the test asserts
 * "SQL == arbiter", not "SQL == what I assumed".
 */

interface SeededLink {
  employeeId: string;
  url: string;
}

/** Pure-JS ground truth: what the breakdown SHOULD be, per canonicalKey(). */
function jsGroundTruth(
  links: SeededLink[],
  names: Map<string, string>,
): TrueLinksBreakdown {
  const keyToEmps = new Map<string, Set<string>>();
  const keySubs = new Map<string, number>();
  const empKeySubs = new Map<string, Map<string, number>>();
  for (const l of links) {
    const k = canonicalKey(l.url);
    if (!k) continue;
    let set = keyToEmps.get(k);
    if (!set) { set = new Set(); keyToEmps.set(k, set); }
    set.add(l.employeeId);
    keySubs.set(k, (keySubs.get(k) ?? 0) + 1);
    let m = empKeySubs.get(l.employeeId);
    if (!m) { m = new Map(); empKeySubs.set(l.employeeId, m); }
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  let totalSubmissions = 0, crossDupLinks = 0, crossDupSubs = 0;
  for (const [k, subs] of keySubs) {
    totalSubmissions += subs;
    if ((keyToEmps.get(k)?.size ?? 0) >= 2) { crossDupLinks++; crossDupSubs += subs; }
  }
  const byEmployee = [...empKeySubs.entries()].map(([empId, m]) => {
    let subs = 0, shared = 0, uniq = 0;
    for (const [k, s] of m) {
      subs += s;
      if ((keyToEmps.get(k)?.size ?? 0) >= 2) shared++;
      else uniq++;
    }
    return {
      id: empId,
      name: names.get(empId) ?? "",
      totalSubmissions: subs,
      distinctLinks: m.size,
      sharedDupLinks: shared,
      trueUniqueLinks: uniq,
    };
  });
  byEmployee.sort(
    (a, b) =>
      b.sharedDupLinks - a.sharedDupLinks ||
      b.trueUniqueLinks - a.trueUniqueLinks ||
      a.name.localeCompare(b.name),
  );
  return {
    totalSubmissions,
    trueLinks: keySubs.size,
    crossEmployeeDupLinks: crossDupLinks,
    crossEmployeeDupSubmissions: crossDupSubs,
    byEmployee,
  };
}

describe("true-links.service — SQL derived-key vs canonicalKey() arbiter", () => {
  let empA: string;
  let empB: string;
  let accountId: string;
  const names = new Map<string, string>();

  beforeEach(async () => {
    // ⚠️ Mandatory: module-level TTL cache — reset per test or results bleed
    // between tests (the documented cross-test cache-pollution class).
    invalidateTrueLinksCache();

    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
    ]);
    const a = await createTestUser({ email: "tla@digitalsukoon.com", name: "Alice A", roleNames: ["Employee"] });
    const b = await createTestUser({ email: "tlb@digitalsukoon.com", name: "Bob B", roleNames: ["Employee"] });
    empA = a.id; empB = b.id;
    names.clear();
    names.set(empA, a.name); names.set(empB, b.name);

    const platform = await prisma.platform.create({ data: { name: "Instagram", slug: "instagram" } });
    const account = await prisma.socialAccount.create({
      data: { handle: "@tl", displayName: "TL", platformId: platform.id, clientName: "C", status: "ACTIVE" },
    });
    accountId = account.id;
  });

  async function seedReport(employeeId: string, dateStr: string, urls: (string | null)[], scheduled = false) {
    const report = await prisma.dailyReport.create({
      data: { employeeId, date: new Date(dateStr) },
    });
    for (const url of urls) {
      await prisma.reportLink.create({
        data: { reportId: report.id, accountId, url, platform: "instagram", isScheduled: scheduled },
      });
    }
    return report.id;
  }

  it("matches the JS arbiter across every tricky URL shape (igsh tokens, watch?v=, slashes, case, raw fallback)", async () => {
    // The seeded universe — every documented trap in one dataset:
    const linksA: string[] = [
      // Same IG reel, different ?igsh= share tokens (must collapse) — A + B share it.
      "https://www.instagram.com/reel/DZ43YhAz0mI/?igsh=aaaa",
      // IG case-sensitivity: distinct from the lowercase variant B posts (must NOT merge).
      "https://www.instagram.com/reel/CASEsens/",
      // YouTube: three forms of the SAME 11-char video id (must collapse to ONE key) —
      // watch?v= is the cooked-backslash regression case from PR #104.
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      // FB reel without trailing slash — B posts WITH slash (must collapse).
      "https://www.facebook.com/reel/1002879505421456",
      // Matched-WHEN-but-failed-capture: youtu.be with a too-short id. JS canonicalKey
      // falls through to the raw-lowercase fallback; SQL must COALESCE to the same —
      // and two DIFFERENT such URLs must NEVER merge (the NULL-group trap).
      "https://youtu.be/abc",
      // Opaque FB share tokens: distinct raw keys, never merged.
      "https://www.facebook.com/share/r/tokenAAA/",
      // ⚠️ The live-prod divergence (2026-07-22): a FB reel with a trailing
      // apostrophe. JS requires TERMINAL digits → raw fallback; a permissive SQL
      // capture would merge it with B's clean reel and fabricate a phantom dup.
      "https://www.facebook.com/reel/7770001112223334'",
      // Short (invalid, non-11-char) YT id with a query token — JS treats as a raw
      // url. B posts the same short id with a DIFFERENT token: must stay DISTINCT.
      "https://youtu.be/abcdef?si=aaa",
      // v= param that is NOT all digits: JS falls through to the PATH branch and
      // keys on the path digits — the SQL must do the same, not go raw.
      "https://www.facebook.com/reel/8880001112223334?v=123x",
      // Mixed-case IG path segment: ~* WHEN matches; the capture must too ((?i)).
      "https://www.instagram.com/Reel/MixedCase01/",
      // HOST-ANCHOR cases (adversarial review 2026-07-22): an EMBEDDED platform url
      // must NOT be keyed — JS validates the parsed hostname (l.facebook.com here),
      // so this is a raw url DISTINCT from B's direct video below.
      "https://l.facebook.com/l.php?u=https://www.youtube.com/watch?v=dQw4w9WgXcR",
      // The real PR #108 glued-URL prod shape: two urls fused with no separator.
      // JS parses ONE url whose path digits aren't terminal → raw; the anchored SQL
      // boundary must agree (never merge with B's clean twin of the leading reel).
      "https://www.facebook.com/reel/5550001112223334https://www.facebook.com/reel/6660001112223334",
    ];
    const linksB: string[] = [
      "https://www.instagram.com/reel/DZ43YhAz0mI/?igsh=bbbb", // shares A's reel
      "https://www.instagram.com/reel/casesens/",              // lowercase ≠ A's CASEsens
      "https://www.facebook.com/reel/1002879505421456/",       // trailing slash = A's reel
      "https://youtu.be/xyz",                                   // 2nd short-id URL ≠ A's
      "https://www.facebook.com/share/r/tokenBBB/",            // ≠ A's opaque token
      "https://www.instagram.com/reel/BonlyReel/",             // unique to B
      "https://www.facebook.com/reel/7770001112223334/",       // clean twin of A's apostrophe reel — must NOT merge
      "https://youtu.be/abcdef?si=bbb",                         // same short id, different token — must NOT merge
      "https://www.facebook.com/reel/8880001112223334",        // B shares A's v=123x reel BY PATH — must merge
      "https://www.youtube.com/watch?v=dQw4w9WgXcR",           // direct video ≠ A's l.php wrapper — must NOT merge
      "https://www.facebook.com/reel/5550001112223334",        // clean twin of A's glued leading reel — must NOT merge
    ];

    await seedReport(empA, "2026-06-10", linksA);
    await seedReport(empB, "2026-06-11", linksB);
    // Excluded rows: a scheduled link and a null-url link must not count at all.
    await seedReport(empA, "2026-06-12", ["https://www.instagram.com/reel/SCHEDULED1/"], true);
    await seedReport(empB, "2026-06-13", [null]);

    const expected = jsGroundTruth(
      [
        ...linksA.map((url) => ({ employeeId: empA, url })),
        ...linksB.map((url) => ({ employeeId: empB, url })),
      ],
      names,
    );
    const actual = await getTrueLinksBreakdown("2026-06-01", "2026-06-30");

    expect(actual).toEqual(expected);

    // Belt-and-suspenders on the specific traps (fail loudly with a named reason):
    // 1. Exactly 3 shared links: the igsh-variant IG reel, the trailing-slash FB
    //    reel, and the v=123x-falls-through-to-path FB reel. NOT the apostrophe
    //    reel (raw ≠ clean), NOT the short-YT-id pair (different tokens = distinct).
    expect(actual.crossEmployeeDupLinks).toBe(3);
    // 2. The three YouTube forms collapsed to ONE key (A's distinct count reflects it).
    const aRow = actual.byEmployee.find((e) => e.id === empA)!;
    expect(aRow.totalSubmissions).toBe(linksA.length);
    expect(aRow.distinctLinks).toBe(linksA.length - 2); // 3 YT forms → 1 key
    // 3. Case-sensitive IG codes stayed distinct; apostrophe/short-id/opaque URLs never merged.
    const bRow = actual.byEmployee.find((e) => e.id === empB)!;
    expect(bRow.sharedDupLinks).toBe(3);
    expect(bRow.trueUniqueLinks).toBe(bRow.distinctLinks - 3);
  });

  it("respects the date window (a link outside the window is invisible)", async () => {
    await seedReport(empA, "2026-05-01", ["https://www.instagram.com/reel/OUTSIDE1/"]);
    await seedReport(empA, "2026-06-10", ["https://www.instagram.com/reel/INSIDE01/"]);
    const res = await getTrueLinksBreakdown("2026-06-01", "2026-06-30");
    expect(res.totalSubmissions).toBe(1);
    expect(res.trueLinks).toBe(1);
    expect(res.crossEmployeeDupLinks).toBe(0);
  });

  it("empty window → clean zeros, empty leaderboard (never throws)", async () => {
    const res = await getTrueLinksBreakdown("2001-01-01", "2001-01-31");
    expect(res).toEqual({
      totalSubmissions: 0,
      trueLinks: 0,
      crossEmployeeDupLinks: 0,
      crossEmployeeDupSubmissions: 0,
      byEmployee: [],
    });
  });

  it("60s TTL cache serves repeat calls and invalidateTrueLinksCache() busts it", async () => {
    await seedReport(empA, "2026-06-10", ["https://www.instagram.com/reel/CACHE0001/"]);
    const first = await getTrueLinksBreakdown("2026-06-01", "2026-06-30");
    expect(first.totalSubmissions).toBe(1);
    // New data lands but the cache (same key, within TTL) still serves the old value…
    await seedReport(empB, "2026-06-11", ["https://www.instagram.com/reel/CACHE0002/"]);
    const cached = await getTrueLinksBreakdown("2026-06-01", "2026-06-30");
    expect(cached.totalSubmissions).toBe(1);
    // …until invalidated.
    invalidateTrueLinksCache();
    const fresh = await getTrueLinksBreakdown("2026-06-01", "2026-06-30");
    expect(fresh.totalSubmissions).toBe(2);
  });
});
