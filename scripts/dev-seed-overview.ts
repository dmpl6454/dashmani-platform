/**
 * Local-only fixture estate for eyeballing /overview against realistic data.
 *
 * Run from the repo root:  npx tsx scripts/dev-seed-overview.ts
 * Refuses to run unless DATABASE_URL points at localhost — this is dev data.
 * Magnitudes mirror production (Sept 2026): ~14 channels, 95 days of daily
 * flows, Meta-style demographic bucket strings, fresh posts, live activity.
 * Re-runnable: everything it creates is namespaced "fx-" and removed first.
 */
import { prisma } from "@dashmani/db";

const DAY = 86_400_000;
const today = new Date();
const dayIso = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);
let seed = 7;
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

const CHANNELS = [
  { kind: "FACEBOOK_PAGE", name: "Bollywood Society", username: "BollywoodSociety", followers: 14_781_280, metaId: "100064123400001", earn: true },
  { kind: "FACEBOOK_PAGE", name: "Paparazzi Feed", username: "paparazzifeed", followers: 16_291_445, metaId: "100064123400002", earn: true },
  { kind: "FACEBOOK_PAGE", name: "Bollywood Reporter", username: "bollywoodreporter", followers: 6_712_930, metaId: "100064123400003", earn: true },
  { kind: "FACEBOOK_PAGE", name: "Crazy 4 Bollywood", username: "crazy4bollywood", followers: 4_836_112, metaId: "100064123400004", earn: true },
  { kind: "FACEBOOK_PAGE", name: "Dashmani", username: "dashmanimedia", followers: 1_922_407, metaId: "100064123400005", earn: true },
  { kind: "FACEBOOK_PAGE", name: "Moviefied Bollywood", username: "moviefiedbollywood", followers: 5_235_735, metaId: "100064123400006", earn: true },
  { kind: "FACEBOOK_PAGE", name: "The Candid Couch", username: "thecandidcouch", followers: 3_214_990, metaId: "100064123400007", earn: false },
  { kind: "FACEBOOK_PAGE", name: "Filmy Gossip", username: "filmygossip", followers: 1_316_402, metaId: "100064123400008", earn: false },
  { kind: "FACEBOOK_PAGE", name: "Bollywood Insider", username: "bollywoodinsider", followers: 927_744, metaId: "100064123400009", earn: true },
  { kind: "INSTAGRAM_ACCOUNT", name: "Paparazzi", username: "paparazzziii", followers: 7_164_810, metaId: "17841400000001", earn: false },
  { kind: "INSTAGRAM_ACCOUNT", name: "Bollywood Society", username: "bollywoodsocietyy", followers: 4_621_323, metaId: "17841400000002", earn: false },
  { kind: "INSTAGRAM_ACCOUNT", name: "Moviefied Bollywood", username: "moviefiedbollywood", followers: 2_318_004, metaId: "17841400000003", earn: false },
  { kind: "INSTAGRAM_ACCOUNT", name: "Bollywood Reporter", username: "bollywood.reporter", followers: 1_077_958, metaId: "17841400000004", earn: false },
  { kind: "INSTAGRAM_ACCOUNT", name: "Dashmani", username: "dashmani", followers: 612_340, metaId: "17841400000005", earn: false },
] as const;

const CITIES: Array<[string, number]> = [
  ["Delhi, Delhi", 4_434_333], ["Mumbai, Maharashtra", 3_207_283], ["Ahmedabad, Gujarat", 1_702_696], ["Bangalore, Karnataka", 1_630_792],
  ["Surat, Gujarat", 1_288_609], ["Chennai, Tamil Nadu", 1_158_684], ["Kolkata, West Bengal", 1_111_471], ["Lucknow, Uttar Pradesh", 1_002_667],
  ["Pune, Maharashtra", 956_760], ["Jaipur, Rajasthan", 939_717], ["Hyderabad, Telangana", 866_114], ["Karachi, Sindh", 673_657],
  ["Ludhiana, Punjab region", 601_922], ["Gurugram, Haryana", 553_502], ["Ghaziabad, Uttar Pradesh", 540_230], ["Dubai, Dubai", 479_063],
  ["Lahore, Punjab", 476_248], ["Indore, Madhya Pradesh", 470_734], ["Kanpur, Uttar Pradesh", 451_817], ["Patna, Bihar", 403_351],
  ["Nagpur, Maharashtra", 359_465], ["Gauhati, Assam", 252_656], ["Dehra Dun, Uttarakhand", 122_819], ["Kochi, Kerala", 98_400],
];
const AGE: Array<[string, number]> = [["13-17", 3.3], ["18-24", 29.4], ["25-34", 44.5], ["35-44", 14.8], ["45-54", 4.6], ["55-64", 1.6], ["65+", 1.9]];
const GENDER: Array<[string, number]> = [["M", 55.5], ["U", 28.3], ["F", 16.2]];
const COUNTRY: Array<[string, number]> = [["IN", 84.6], ["PK", 2.5], ["BR", 1.9], ["US", 1.3], ["SA", 0.9], ["BD", 0.9], ["AE", 0.85], ["ID", 0.76], ["IR", 0.67], ["NP", 0.34], ["MY", 0.33], ["TR", 0.32]];

const POSTS = [
  ["Kritika Kamra makes a stylish appearance at the Lust Stories 3 screening ✨", "REELS", 12],
  ["गणपति बप्पा मोरया 🙏🌺 विसर्जन की झलकियां", "REELS", 24],
  ["तमन्ना भाटिया का छठ पूजा वाला अंदाज़ दिल छू गया।", null, 41],
  ["Kriti Sanon spotted at the airport in an all-black look 🖤", "REELS", 58],
  ["Ambani family arrives for the Ganesh Chaturthi celebrations at Antilia", null, 95],
  ["Salman Khan's new look for Sikandar 2 has the internet talking", "FEED", 140],
  ["Shraddha Kapoor dances with fans outside her building 💃", "REELS", 190],
  ["Ranveer Singh and Deepika Padukone at the Mumbai airport", "REELS", 260],
  ["Bigg Boss 20 house tour: everything we know so far", "FEED", 330],
  ["Janhvi Kapoor's saree moment at the Filmfare Glamour awards", "REELS", 410],
] as const;

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error("dev-seed-overview only runs against a localhost DATABASE_URL — it inserts fixture data");
  }
  // ── wipe previous fixture ──
  await prisma.metaConnection.deleteMany({ where: { metaUserId: "fx-meta-user" } });
  await prisma.socialAccount.deleteMany({ where: { handle: { startsWith: "fx-" } } });
  await prisma.linkContentEntity.deleteMany({ where: { content: { canonicalKey: { startsWith: "fx:" } } } });
  await prisma.linkContent.deleteMany({ where: { canonicalKey: { startsWith: "fx:" } } });
  await prisma.entity.deleteMany({ where: { canonicalName: { startsWith: "fx " } } });
  await prisma.announcement.deleteMany({ where: { title: { startsWith: "fx " } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@fx.dashmani.test" } } });

  const admin = await prisma.user.findFirst({ where: { email: "admin@digitalsukoon.com" } });
  if (!admin) throw new Error("run the db seed first");
  const platforms = await prisma.platform.findMany({ select: { id: true, slug: true } });
  const platformId = (slug: string) => platforms.find((p) => p.slug === slug)?.id ?? platforms[0].id;

  const conn = await prisma.metaConnection.create({
    data: { metaUserId: "fx-meta-user", metaUserName: "Sudhanshu Kumar", connectedById: admin.id, status: "ACTIVE", discoveryState: "done", tokenExpiresAt: new Date(Date.now() + 80 * DAY) },
  });

  const employees = [];
  for (const [i, name] of ["Roshan Shaikh", "Muskan Khatoon", "Kajal Yadav", "Prashant Shukla", "Anish Verma", "Fareen Sabir"].entries()) {
    employees.push(await prisma.user.create({
      data: { name, email: `emp${i}@fx.dashmani.test`, passwordHash: "x", status: "ACTIVE", createdAt: new Date(Date.now() - (i === 5 ? 2 * 3600_000 : (30 + i) * DAY)) },
    }));
  }

  let dailyRows = 0;
  for (const [ci, c] of CHANNELS.entries()) {
    const isFb = c.kind === "FACEBOOK_PAGE";
    const account = await prisma.socialAccount.create({
      data: { handle: `fx-${c.username}`, displayName: c.name, platformId: platformId(isFb ? "facebook" : "instagram"), followerCount: c.followers, syncSource: "api", lastSyncedAt: today },
    });
    const asset = await prisma.metaAsset.create({
      data: {
        connectionId: conn.id, kind: c.kind, metaId: c.metaId, name: c.name, username: c.username, followerCount: c.followers,
        socialAccountId: account.id, metricsFetchedAt: today, postCount: 1200 + ci * 37,
      },
    });
    // Daily flows: views scale with audience, weekly seasonality, gentle upward drift.
    const perFollowerDay = isFb ? 0.11 : 0.06;
    const daily: Array<Record<string, unknown>> = [];
    let weekViews = 0, weekEng = 0, weekEarn = 0, m28Views = 0, m28Eng = 0, m28Earn = 0;
    for (let n = 1; n <= 95; n++) {
      const iso = dayIso(n);
      const dow = dateOf(iso).getUTCDay();
      const season = dow === 0 ? 1.22 : dow === 6 ? 1.12 : 1;
      const drift = 1 + (95 - n) * 0.0028;
      const views = Math.round(c.followers * perFollowerDay * season * drift * (0.8 + rnd() * 0.45));
      const eng = Math.round(views * (0.028 + rnd() * 0.012));
      const reactions = Math.round(eng * (0.55 + rnd() * 0.1));
      const shares = Math.round(eng * (0.04 + rnd() * 0.02));
      const earn = c.earn ? Math.round((views / 1_000_000) * (300 + rnd() * 160)) : isFb ? 0 : null;
      daily.push({ assetId: asset.id, date: dateOf(iso), views: BigInt(views), engagements: BigInt(eng), reactions: BigInt(reactions), shares, earningsCents: earn });
      if (n <= 7) { weekViews += views; weekEng += eng; weekEarn += earn ?? 0; }
      if (n <= 28) { m28Views += views; m28Eng += eng; m28Earn += earn ?? 0; }
    }
    await prisma.metaAssetDaily.createMany({ data: daily as never });
    dailyRows += daily.length;
    for (const [window, views, eng, earn] of [["week", weekViews, weekEng, weekEarn], ["days_28", m28Views, m28Eng, m28Earn], ["day", Math.round(weekViews / 7), Math.round(weekEng / 7), Math.round(weekEarn / 7)]] as const) {
      await prisma.metaAssetMetric.create({
        data: {
          assetId: asset.id, window, views: BigInt(views), engagements: BigInt(eng), reach: BigInt(Math.round(views * (0.38 + rnd() * 0.08))),
          earningsCents: c.earn ? earn : isFb ? 0 : null, followerDelta: isFb ? null : Math.round(c.followers * 0.004 * (window === "week" ? 1 : 4)),
          fetchedAt: today, periodEnd: dateOf(dayIso(1)),
        },
      });
    }
    // Follower history — a gently rising stock, 95 daily API snapshots.
    const snaps = [];
    for (let n = 0; n <= 95; n++) {
      const growth = 1 - n * (0.0006 + (ci % 3) * 0.0002) - Math.sin(n / 9) * 0.0008;
      snaps.push({ accountId: account.id, date: dateOf(dayIso(n)), followerCount: Math.round(c.followers * growth), source: "api" });
    }
    await prisma.accountGrowthSnapshot.createMany({ data: snaps });
    // Instagram audience demographics with Meta's real bucket strings.
    if (!isFb) {
      const share = c.followers / 15_794_435;
      const demo: Array<{ dimension: string; bucket: string; value: number }> = [];
      for (const [bucket, v] of CITIES) demo.push({ dimension: "city", bucket, value: Math.round(v * share * (0.9 + rnd() * 0.2)) });
      for (const [bucket, pct] of AGE) demo.push({ dimension: "age", bucket, value: Math.round(c.followers * 0.72 * pct / 100) });
      for (const [bucket, pct] of GENDER) demo.push({ dimension: "gender", bucket, value: Math.round(c.followers * 0.72 * pct / 100) });
      for (const [bucket, pct] of COUNTRY) demo.push({ dimension: "country", bucket, value: Math.round(c.followers * 0.72 * pct / 100) });
      await prisma.metaAssetDemographic.createMany({ data: demo.map((d) => ({ ...d, assetId: asset.id, audience: "follower", fetchedAt: today })) });
    }
    // Recent posts.
    for (const [pi, [caption, type, minutesAgo]] of POSTS.entries()) {
      if ((pi + ci) % 3 !== 0) continue;
      const age = minutesAgo * 60_000 + ci * 90_000;
      await prisma.metaPost.create({
        data: {
          assetId: asset.id, metaPostId: `fx-${ci}-${pi}`, caption, mediaProductType: type, mediaType: type ? "VIDEO" : null,
          permalink: isFb ? `https://www.facebook.com/reel/1${ci}${pi}00123` : `https://www.instagram.com/reel/DX${ci}${pi}abc/`,
          postedAt: new Date(Date.now() - age), views: Math.round(age / 60_000 * (isFb ? 210 : 140) * (0.5 + rnd())), likes: Math.round(age / 60_000 * 6 * rnd()), comments: Math.round(age / 60_000 * 0.4 * rnd()),
          metricsStatus: "ok", metricsFetchedAt: today,
        },
      });
    }
  }

  // Daily reports today with links, a leave request, an announcement.
  const accounts = await prisma.socialAccount.findMany({ where: { handle: { startsWith: "fx-" } }, select: { id: true } });
  for (const [i, emp] of employees.slice(0, 4).entries()) {
    const report = await prisma.dailyReport.create({
      data: { employeeId: emp.id, date: dateOf(dayIso(0)), submittedAt: new Date(Date.now() - (9 + i * 17) * 60_000) },
    });
    const links = Array.from({ length: 12 + i * 9 }, (_, k) => ({
      reportId: report.id, accountId: accounts[(k + i) % accounts.length].id,
      url: `https://www.instagram.com/reel/FX${i}${k}${Math.floor(rnd() * 1e6)}/`, platform: "instagram",
    }));
    await prisma.reportLink.createMany({ data: links });
  }
  await prisma.leaveRequest.create({
    data: { employeeId: employees[4].id, startDate: dateOf(dayIso(-3)), endDate: dateOf(dayIso(-4)), type: "SICK", reason: "Fever", createdAt: new Date(Date.now() - 52 * 60_000) },
  });
  await prisma.announcement.create({
    data: { title: "fx Festive-week posting schedule", message: "Please follow the updated Ganesh Chaturthi content calendar.", sentById: admin.id, createdAt: new Date(Date.now() - 3 * 3600_000) },
  });

  // Trending entities: captions harvested this week vs last.
  const ENT: Array<[string, string, number, number]> = [
    ["fx Moviefied Bollywood", "BRAND", 64, 41], ["fx Ganesh Chaturthi", "TOPIC", 58, 6], ["fx Ambani family", "PERSON", 47, 12],
    ["fx Kriti Sanon", "PERSON", 33, 29], ["fx Tamannaah Bhatia", "PERSON", 21, 24], ["fx Salman Khan", "PERSON", 14, 9], ["fx IIFA 2026", "EVENT", 6, 0],
  ];
  let key = 0;
  for (const [name, type, thisWeek, lastWeek] of ENT) {
    const entity = await prisma.entity.create({ data: { canonicalName: name, type, aliases: [] } });
    for (const [count, daysAgo] of [[thisWeek, 2], [lastWeek, 10]] as const) {
      for (let k = 0; k < count; k++) {
        const content = await prisma.linkContent.create({
          data: { canonicalKey: `fx:${key++}`, platform: "instagram", status: "ok", caption: name, createdAt: new Date(Date.now() - (daysAgo + rnd() * 4) * DAY) },
        });
        await prisma.linkContentEntity.create({ data: { linkContentId: content.id, entityId: entity.id } });
      }
    }
  }

  console.log(`fixture ready: ${CHANNELS.length} channels, ${dailyRows} daily rows, ${employees.length} employees, ${ENT.length} entities`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
