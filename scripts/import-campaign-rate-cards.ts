/**
 * Import the campaign rate card from the owner's sheet
 * ("Instagram and Facebook Bollywood Pages — Updated Jan 2026", extracted to
 * scripts/data/campaign-rate-cards.json).
 *
 * For every page in the sheet that matches a connected, monitored Meta channel, it writes a
 * rate card for each bookable format (reel, post, carousel — no stories, owner decision
 * 2026-10-08):
 *   pricePaise              = "Brand Cost in INR"
 *   entertainmentPricePaise = "Entertainment Cost (INR)"
 *   audioAddonPaise         = "Paparazzi Audio Integration" — Instagram REELS only
 *                             ("don't do" / empty → not offered)
 *   category                = "Bollywood" when the account has none yet
 *
 * The sheet's follower counts are NOT imported: the catalogue shows live Meta counts.
 *
 * Matching (never fuzzy):
 *   Instagram — the URL's username equals the account's username (case-insensitive). Never by
 *               name: two different accounts can share a display name.
 *   Facebook  — a numeric id in the URL equals the Page id; else the URL's vanity name equals
 *               the Page username; else the sheet name equals the Page name when exactly ONE
 *               live Page has that name (reported as a name match, so staff can check it).
 * Unmatched pages are listed and skipped (connect the channel, then re-run).
 *
 * Idempotent: re-running updates the same cards. Existing cards for pages NOT in the sheet are
 * left alone. Dry-run by default.
 *
 * Run from packages/db (so Prisma loads packages/db/.env):
 *   npx tsx ../../scripts/import-campaign-rate-cards.ts                 # dry run
 *   npx tsx ../../scripts/import-campaign-rate-cards.ts --apply --confirm-prod
 */
import fs from "fs";
import path from "path";
import { prisma } from "@dashmani/db";
import { listBookableTargets, invalidateCatalogueCache } from "../apps/api/src/services/campaign/rate-card.service";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");
const FORMATS = ["reel", "post", "carousel"] as const;
const DEFAULT_CATEGORY = "Bollywood";

interface SheetPage {
  platform: "instagram" | "facebook";
  name: string;
  url: string;
  sheetFollowers: number | null;
  entertainmentRupees: number | null;
  brandRupees: number | null;
  audioRupees: number | null;
}

const RESERVED_FB = new Set(["profile.php", "pages", "people", "pg", "groups", "share", "reel", "watch", "p"]);

/** Parse a page URL into its identity: a numeric id and/or a vanity username. */
export function parsePageUrl(raw: string): { id: string | null; username: string | null } {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { id: null, username: null };
  }
  const qid = u.searchParams.get("id");
  const segs = u.pathname.split("/").filter(Boolean);
  if (qid && /^\d+$/.test(qid)) return { id: qid, username: null };
  // facebook.com/people/<Name>/<id>/ and facebook.com/pages/<Name>/<id>/
  const numeric = segs.find((s) => /^\d{6,}$/.test(s));
  if (numeric) return { id: numeric, username: null };
  const first = segs[0];
  if (!first || RESERVED_FB.has(first.toLowerCase())) return { id: null, username: null };
  return { id: null, username: first.replace(/^@/, "").toLowerCase() };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const paise = (rupees: number | null) => (rupees == null ? null : Math.round(rupees * 100));

async function main() {
  const file = path.join(__dirname, "data", "campaign-rate-cards.json");
  const { pages } = JSON.parse(fs.readFileSync(file, "utf8")) as { pages: SheetPage[] };

  const dbUrl = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);
  if (APPLY && !isLocal && !CONFIRM_PROD) {
    console.error("Refusing to write to a non-local database without --confirm-prod.");
    process.exit(1);
  }

  const targets = (await listBookableTargets()).filter((t) => t.targetType === "meta_asset");
  const metaIds = new Map(
    (await prisma.metaAsset.findMany({ where: { id: { in: targets.map((t) => t.targetId) } }, select: { id: true, metaId: true } })).map((a) => [a.id, a.metaId]),
  );

  const byIgUser = new Map<string, (typeof targets)[number]>();
  const byFbUser = new Map<string, (typeof targets)[number]>();
  const byFbId = new Map<string, (typeof targets)[number]>();
  const byFbName = new Map<string, Array<(typeof targets)[number]>>();
  for (const t of targets) {
    if (t.platform === "instagram") {
      if (t.username) byIgUser.set(t.username.toLowerCase(), t);
    } else if (t.platform === "facebook") {
      if (t.username) byFbUser.set(t.username.toLowerCase(), t);
      const mid = metaIds.get(t.targetId);
      if (mid) byFbId.set(mid, t);
      const k = norm(t.name);
      byFbName.set(k, [...(byFbName.get(k) ?? []), t]);
    }
  }

  const matched: Array<{ page: SheetPage; target: (typeof targets)[number]; how: string }> = [];
  const unmatched: Array<{ page: SheetPage; why: string }> = [];
  const seen = new Map<string, SheetPage>();

  for (const page of pages) {
    if (page.brandRupees == null) {
      unmatched.push({ page, why: "no brand price in the sheet" });
      continue;
    }
    const { id, username } = parsePageUrl(page.url);
    let target: (typeof targets)[number] | undefined;
    let how = "";
    if (page.platform === "instagram") {
      if (username) target = byIgUser.get(username);
      how = "username";
    } else {
      if (id) {
        target = byFbId.get(id);
        how = "page id";
      }
      if (!target && username) {
        target = byFbUser.get(username);
        how = "username";
      }
      if (!target) {
        const same = byFbName.get(norm(page.name)) ?? [];
        if (same.length === 1) {
          target = same[0];
          how = "NAME (check)";
        } else if (same.length > 1) {
          unmatched.push({ page, why: `${same.length} connected Pages are called "${page.name}" — ambiguous` });
          continue;
        }
      }
    }
    if (!target) {
      unmatched.push({ page, why: "not a connected, monitored channel" });
      continue;
    }
    const prev = seen.get(target.targetId);
    if (prev) {
      unmatched.push({ page, why: `same account as sheet row "${prev.name}" — first row kept` });
      continue;
    }
    seen.set(target.targetId, page);
    matched.push({ page, target, how });
  }

  console.log(`Sheet: ${pages.length} pages (${pages.filter((p) => p.platform === "instagram").length} Instagram, ${pages.filter((p) => p.platform === "facebook").length} Facebook)`);
  console.log(`Bookable Meta channels: ${targets.length}`);
  console.log(`\nMatched ${matched.length}:`);
  for (const m of matched) {
    const audio = m.page.platform === "instagram" ? (m.page.audioRupees != null ? `audio ₹${m.page.audioRupees}` : "no audio") : "";
    console.log(
      `  ${m.page.platform.padEnd(9)} ${m.page.name.padEnd(28)} → ${m.target.name} (@${m.target.username ?? "—"}) [${m.how}]  brand ₹${m.page.brandRupees} · ent ₹${m.page.entertainmentRupees ?? "—"} ${audio}`,
    );
  }
  console.log(`\nNot imported ${unmatched.length}:`);
  for (const u of unmatched) console.log(`  ${u.page.platform.padEnd(9)} ${u.page.name.padEnd(28)} ${u.page.url}  — ${u.why}`);

  if (!APPLY) {
    console.log(`\nDry run. ${matched.length * FORMATS.length} rate cards would be written. Re-run with --apply${isLocal ? "" : " --confirm-prod"} to write.`);
    return;
  }

  let written = 0;
  await prisma.$transaction(async (tx) => {
    for (const { page, target } of matched) {
      const existingCategory = (
        await tx.campaignRateCard.findFirst({ where: { targetType: "meta_asset", targetId: target.targetId, category: { not: null } }, select: { category: true } })
      )?.category;
      const category = existingCategory ?? DEFAULT_CATEGORY;
      for (const format of FORMATS) {
        const values = {
          platform: target.platform,
          pricePaise: paise(page.brandRupees)!,
          entertainmentPricePaise: paise(page.entertainmentRupees),
          audioAddonPaise: page.platform === "instagram" && format === "reel" ? paise(page.audioRupees) : null,
          active: true,
          category,
        };
        await tx.campaignRateCard.upsert({
          where: { targetType_targetId_format: { targetType: "meta_asset", targetId: target.targetId, format } },
          create: { targetType: "meta_asset", targetId: target.targetId, format, ...values },
          update: values,
        });
        written++;
      }
    }
  });
  invalidateCatalogueCache();
  console.log(`\nWrote ${written} rate cards for ${matched.length} accounts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
