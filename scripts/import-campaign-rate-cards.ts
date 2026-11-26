/**
 * Import the campaign rate card from the owner's sheet. Current sheet (2026-11-18):
 * "Digital Sukoon Private Limited Management" → scripts/data/campaign-rate-cards-2026-11.json
 * (the default). The January 2026 sheet ("Instagram and Facebook Bollywood Pages") is kept in
 * scripts/data/campaign-rate-cards.json; pass --file=campaign-rate-cards.json to re-run it.
 *
 * For every page in the sheet that matches a connected, monitored Meta channel, it writes a
 * rate card for each bookable format (reel, post, carousel — no stories, owner decision
 * 2026-10-08):
 *   pricePaise              = "Brand Cost in INR"
 *   entertainmentPricePaise = "Entertainment Cost (INR)" / "Entertainment/Song"
 *   eventPricePaise         = "Event" (2026-11 sheet; absent = not offered for event campaigns)
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
 * left alone, unless --switch-off-others is given (owner decision 2026-11-18: "all campaigns
 * happen on these networks"): then every ACTIVE rate card of a connected Meta channel (Instagram
 * or Facebook, target_type meta_asset) that the sheet did not match is set active = false. Its
 * prices are kept, so a channel can be switched back on from Campaigns → Rate cards. YouTube /
 * Snapchat channels and creator pages are never touched. Dry-run by default.
 *
 * Partner network: the file's "partners" list (external pages we buy posts on — owner decision
 * 2026-11-18: SALES INVENTORY ONLY, never offered to clients) is added to / refreshed in the
 * external pages list (sales_external_pages, services/sales/external-pages.service.ts) by
 * (platform, handle). A page already there keeps its vendor, notes and on/off switch. No rate cards.
 *
 * Run from packages/db (so Prisma loads packages/db/.env):
 *   npx tsx ../../scripts/import-campaign-rate-cards.ts --switch-off-others                        # dry run
 *   npx tsx ../../scripts/import-campaign-rate-cards.ts --switch-off-others --apply --confirm-prod
 */
import fs from "fs";
import path from "path";
import { prisma } from "@dashmani/db";
import { listBookableTargets, invalidateCatalogueCache } from "../apps/api/src/services/campaign/rate-card.service";
import { upsertExternalPages, type ExternalPageInput } from "../apps/api/src/services/sales/external-pages.service";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");
const SWITCH_OFF_OTHERS = process.argv.includes("--switch-off-others");
const FILE = process.argv.find((a) => a.startsWith("--file="))?.slice("--file=".length) ?? "campaign-rate-cards-2026-11.json";
const FORMATS = ["reel", "post", "carousel"] as const;
const DEFAULT_CATEGORY = "Bollywood";

interface SheetPage {
  platform: "instagram" | "facebook";
  name: string;
  url: string;
  sheetFollowers: number | null;
  entertainmentRupees: number | null;
  brandRupees: number | null;
  /** 2026-11 sheet only. */
  eventRupees?: number | null;
  audioRupees: number | null;
}

interface SheetPartner extends SheetPage {
  handle: string;
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
  if (!/^[\w.-]+\.json$/.test(FILE)) throw new Error(`--file must be a file name in scripts/data, got "${FILE}"`);
  const file = path.join(__dirname, "data", FILE);
  const sheet = JSON.parse(fs.readFileSync(file, "utf8")) as { source?: string; pages: SheetPage[]; partners?: SheetPartner[] };
  const pages = sheet.pages;
  console.log(`File: scripts/data/${FILE}${sheet.source ? ` (${sheet.source})` : ""}`);

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
      `  ${m.page.platform.padEnd(9)} ${m.page.name.padEnd(28)} → ${m.target.name} (@${m.target.username ?? "—"}) [${m.how}]  brand ₹${m.page.brandRupees} · ent ₹${m.page.entertainmentRupees ?? "—"} · event ₹${m.page.eventRupees ?? "—"} ${audio}`,
    );
  }
  console.log(`\nNot imported ${unmatched.length}:`);
  for (const u of unmatched) console.log(`  ${u.page.platform.padEnd(9)} ${u.page.name.padEnd(28)} ${u.page.url}  — ${u.why}`);

  // Channels whose active prices --switch-off-others would withdraw: connected Meta channels the
  // sheet did not match. Listed in the dry run either way, so the owner sees what "only these
  // networks" removes before it happens.
  const matchedIds = new Set(matched.map((m) => m.target.targetId));
  const othersActive = await prisma.campaignRateCard.findMany({
    where: { targetType: "meta_asset", active: true, targetId: { notIn: [...matchedIds] } },
    select: { id: true, targetId: true, platform: true, format: true },
  });
  const nameOf = new Map(targets.map((t) => [t.targetId, `${t.name}${t.username ? ` (@${t.username})` : ""}`]));
  const otherChannels = new Map<string, { platform: string; formats: string[] }>();
  for (const c of othersActive) {
    const e = otherChannels.get(c.targetId) ?? { platform: c.platform, formats: [] };
    e.formats.push(c.format);
    otherChannels.set(c.targetId, e);
  }
  const untouched = await prisma.campaignRateCard.groupBy({
    by: ["targetType", "platform"],
    where: { active: true, targetType: { not: "meta_asset" } },
    _count: { _all: true },
  });
  console.log(
    `\n${SWITCH_OFF_OTHERS ? "Switching off" : "Would switch off with --switch-off-others"}: ${otherChannels.size} other priced Meta channels (${othersActive.length} active rate cards; prices kept, set inactive):`,
  );
  for (const [id, e] of [...otherChannels].sort((a, b) => a[1].platform.localeCompare(b[1].platform))) {
    console.log(`  ${e.platform.padEnd(9)} ${nameOf.get(id) ?? `(not connected now) ${id}`} — ${e.formats.sort().join(", ")}`);
  }
  for (const u of untouched) console.log(`  untouched: ${u._count._all} active ${u.platform} rate cards (${u.targetType})`);

  // Partner network (sales inventory only).
  const partners: ExternalPageInput[] = (sheet.partners ?? []).map((p) => ({
    handle: p.handle.toLowerCase(),
    name: p.name,
    platform: "instagram" as const,
    profileUrl: p.url,
    followers: p.sheetFollowers,
    category: DEFAULT_CATEGORY,
    brandPaise: paise(p.brandRupees),
    entertainmentPaise: paise(p.entertainmentRupees),
    eventPaise: paise(p.eventRupees ?? null),
    audioPaise: paise(p.audioRupees),
  }));
  if (sheet.partners) {
    const plan = await upsertExternalPages(partners, "import", { dryRun: true });
    console.log(`\nPartner network → external pages (sales inventory only): ${partners.length} pages — ${plan.created} new, ${plan.updated} changed, ${plan.unchanged} unchanged:`);
    const r = (v: number | null | undefined) => (v == null ? "—" : `₹${v / 100}`);
    for (const p of partners) {
      console.log(`  ${p.name.padEnd(20)} @${String(p.handle).padEnd(18)} brand ${r(p.brandPaise)} · ent ${r(p.entertainmentPaise)} · event ${r(p.eventPaise)} · song ${r(p.audioPaise)}`);
    }
  }

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
          // The January sheet had no Event column: leave a stored event price alone there.
          ...(page.eventRupees !== undefined ? { eventPricePaise: paise(page.eventRupees) } : {}),
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
    if (SWITCH_OFF_OTHERS && othersActive.length) {
      await tx.campaignRateCard.updateMany({ where: { id: { in: othersActive.map((c) => c.id) } }, data: { active: false } });
    }
  });
  invalidateCatalogueCache();
  console.log(`\nWrote ${written} rate cards for ${matched.length} accounts.`);
  if (SWITCH_OFF_OTHERS) console.log(`Switched off ${othersActive.length} rate cards on ${otherChannels.size} other channels.`);
  if (sheet.partners) {
    const done = await upsertExternalPages(partners, "import");
    console.log(`External pages: ${done.created} added, ${done.updated} updated, ${done.unchanged} unchanged.`);
  }
  console.log("The API caches the catalogue and inventory for up to a minute.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
