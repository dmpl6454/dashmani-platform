/**
 * Local-only fixture so the client portal's "Start a campaign" journey can be driven end to end
 * on a dev database: one Meta connection owned by the seeded admin, five live assets (3 IG +
 * 2 FB) and rate cards for reel / post / carousel on each. Pair it with scripts/e2e/client-journey.mjs.
 *
 * Run from the repo root with the db env loaded:
 *   set -a && . packages/db/.env && set +a && npx tsx scripts/dev-seed-campaigns.ts
 * Refuses to run unless DATABASE_URL points at localhost — this is dev data. Re-runnable:
 * everything is keyed on fixed metaIds / the unique (targetType, targetId, format).
 */
import { prisma } from "@dashmani/db";

async function main() {

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")) throw new Error("refusing: DATABASE_URL is not localhost");

const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@digitalsukoon.com" } });
const conn = await prisma.metaConnection.upsert({
  where: { metaUserId: "e2e-meta-user" },
  create: { metaUserId: "e2e-meta-user", metaUserName: "E2E Admin", connectedById: admin.id, status: "ACTIVE", discoveryState: "done", grantedScopes: "pages_show_list,instagram_basic" },
  update: { revokedAt: null, status: "ACTIVE" },
});

const ASSETS = [
  { kind: "INSTAGRAM_ACCOUNT", metaId: "17841400009001", name: "Bollywood Society", username: "bollywoodsocietyy", followers: 4_621_323, views: 410_000_000n, eng: 21_000_000n, cat: "Bollywood news" },
  { kind: "INSTAGRAM_ACCOUNT", metaId: "17841400009002", name: "Paparazzi", username: "paparazzziii", followers: 7_164_810, views: 620_000_000n, eng: 25_000_000n, cat: "Celebrity paparazzi" },
  { kind: "INSTAGRAM_ACCOUNT", metaId: "17841400009003", name: "Dashmani", username: "dashmani", followers: 612_340, views: 38_000_000n, eng: 2_100_000n, cat: "Entertainment" },
  { kind: "FACEBOOK_PAGE", metaId: "100064123409001", name: "Bollywood Society", username: "BollywoodSociety", followers: 14_781_280, views: 1_350_000_000n, eng: 39_000_000n, cat: "Bollywood news" },
  { kind: "FACEBOOK_PAGE", metaId: "100064123409002", name: "Filme Flicks", username: null, followers: 2_129_582, views: 180_000_000n, eng: 6_200_000n, cat: "Film reviews" },
] as const;

for (const a of ASSETS) {
  const asset = await prisma.metaAsset.upsert({
    where: { connectionId_kind_metaId: { connectionId: conn.id, kind: a.kind, metaId: a.metaId } },
    create: { connectionId: conn.id, kind: a.kind, metaId: a.metaId, name: a.name, username: a.username, followerCount: a.followers, views28d: a.views, engagements28d: a.eng, selected: true, pictureUrl: null },
    update: { name: a.name, username: a.username, followerCount: a.followers, views28d: a.views, engagements28d: a.eng, selected: true, disconnectedAt: null },
  });
  const platform = a.kind === "INSTAGRAM_ACCOUNT" ? "instagram" : "facebook";
  const prices = { reel: 150_000, post: 90_000, carousel: 120_000 } as const; // paise → ₹1,500 / ₹900 / ₹1,200
  for (const [format, pricePaise] of Object.entries(prices)) {
    await prisma.campaignRateCard.upsert({
      where: { targetType_targetId_format: { targetType: "meta_asset", targetId: asset.id, format } },
      create: { targetType: "meta_asset", targetId: asset.id, platform, format, pricePaise, entertainmentPricePaise: Math.round(pricePaise * 0.8), audioAddonPaise: format === "reel" && platform === "instagram" ? 50_000 : null, active: true, category: a.cat, updatedById: admin.id },
      update: { pricePaise, entertainmentPricePaise: Math.round(pricePaise * 0.8), audioAddonPaise: format === "reel" && platform === "instagram" ? 50_000 : null, active: true, category: a.cat },
    });
  }
}
const cards = await prisma.campaignRateCard.count({ where: { active: true } });
const assets = await prisma.metaAsset.count({ where: { connectionId: conn.id, disconnectedAt: null, selected: true } });
console.log(`e2e fixture ready: connection ${conn.id}, assets ${assets}, rate cards ${cards}`);
await prisma.$disconnect();

}
main().catch((e) => { console.error(e); process.exit(1); });
