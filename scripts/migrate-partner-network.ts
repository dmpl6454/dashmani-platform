/**
 * Move the partner network out of system_settings ("sales.partnerNetwork", written by the
 * 2026-11-18 rate-sheet import before external pages had a table) into sales_external_pages.
 * Pages are matched by (platform, handle); a page already in the table keeps its vendor, notes and
 * on/off switch. With --apply the setting is deleted afterwards, so the old value can never be read
 * again. Nothing stored → nothing to do. Safe to re-run.
 *
 * Run from packages/db (so Prisma loads packages/db/.env), after the vendors PR is deployed:
 *   npx tsx ../../scripts/migrate-partner-network.ts                        # dry run
 *   npx tsx ../../scripts/migrate-partner-network.ts --apply --confirm-prod
 */
import { prisma } from "@dashmani/db";
import { getPartnerNetwork, PARTNER_NETWORK_KEY } from "../apps/api/src/services/sales/partner-network";
import { upsertExternalPages } from "../apps/api/src/services/sales/external-pages.service";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");

async function main() {
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "");
  if (APPLY && !isLocal && !CONFIRM_PROD) throw new Error("Refusing to write to a non-local database without --confirm-prod.");
  const stored = await prisma.systemSetting.findUnique({ where: { key: PARTNER_NETWORK_KEY } });
  if (!stored) {
    console.log(`Nothing stored under "${PARTNER_NETWORK_KEY}" — nothing to move.`);
    return;
  }
  const net = await getPartnerNetwork();
  const pages = net.pages.map((p) => ({
    platform: p.platform,
    handle: p.handle,
    name: p.name,
    profileUrl: p.profileUrl,
    followers: p.followers,
    category: p.category,
    brandPaise: p.brandPaise,
    entertainmentPaise: p.entertainmentPaise,
    eventPaise: p.eventPaise,
    audioPaise: p.audioPaise,
  }));
  const plan = await upsertExternalPages(pages, "migration", { dryRun: true });
  console.log(`${pages.length} partner pages in "${PARTNER_NETWORK_KEY}": ${plan.created} new, ${plan.updated} changed, ${plan.unchanged} already in the table.`);
  for (const p of pages) console.log(`  ${p.name} @${p.handle}`);
  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply${isLocal ? "" : " --confirm-prod"} to move them and delete the setting.`);
    return;
  }
  const done = await upsertExternalPages(pages, "migration");
  await prisma.systemSetting.delete({ where: { key: PARTNER_NETWORK_KEY } });
  console.log(`\nMoved: ${done.created} added, ${done.updated} updated, ${done.unchanged} unchanged. Setting "${PARTNER_NETWORK_KEY}" deleted.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
