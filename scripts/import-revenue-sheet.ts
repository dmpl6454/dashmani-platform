/**
 * scripts/import-revenue-sheet.ts — load the owner's "Revenue & Pipeline Sheet" (one tab per
 * month, one row per deal: Sept 2023 → Oct 2025) into the sales portal as CLIENTS and ORDERS.
 *
 *   cd apps/api && npx tsx ../../scripts/import-revenue-sheet.ts "<path to .xlsx>"            # dry run
 *   cd apps/api && npx tsx ../../scripts/import-revenue-sheet.ts "<path>" --apply              # local
 *   cd apps/api && npx tsx ../../scripts/import-revenue-sheet.ts "<path>" --apply --confirm-prod
 *
 * Mapping (deliberate, documented so it can be revisited):
 *   - "Client / Campaign Name" → the CLIENT (deduped case-insensitively, also against existing
 *     clients) and the order TITLE. The "Agency" column (who brought the deal; "Direct" = none)
 *     is kept on the order's printed notes ("Agency: …"), never used as the client.
 *   - "RO Value" (rupees) → one custom line of qty 1 at that price, taxMode "none", GST 0: the
 *     sheet records RO values without GST, so the imported totals equal the sheet's totals.
 *   - Status: campaign executed/done + payment done/paid/received → closed; executed/done →
 *     delivered; live/going live/on going/execution → in_progress; RO confirmed → confirmed;
 *     RO pending/blank → draft. The raw status texts, cost outflow, commission, margin and
 *     remarks are kept verbatim in the order's internal notes.
 *   - Dates: the row's Date when present (Date cell or dd.mm.yyyy), else the tab's month
 *     (first of the month, rows kept in sheet order). Order numbers follow the financial year
 *     of that date (SO/23-24/0001 …) and createdAt is set to it so lists read chronologically.
 *   - NO tax invoices and NO payments are created: the invoices issued at the time carried
 *     their own GST serials, and inventing new ones would corrupt the register.
 * Idempotent: every order carries `import:revenue-sheet:<tab>:<row>` in its internal notes and
 * is skipped when already present. Clients get an unusable random password and a placeholder
 * email on the reserved .invalid domain (the column is NOT NULL UNIQUE).
 */
import crypto from "crypto";
import { hash } from "bcrypt";
import * as XLSX from "xlsx";
import { prisma } from "@dashmani/db";
import { dayToDate, nextDocumentNumber, logSalesEvent } from "../apps/api/src/services/sales/common";
import { getSellerOrDefaults } from "../apps/api/src/services/sales/settings.service";

const file = process.argv[2];
const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");
if (!file) { console.error("usage: import-revenue-sheet.ts <xlsx> [--apply] [--confirm-prod]"); process.exit(2); }
const dbUrl = process.env.DATABASE_URL ?? "";
const isLocal = /localhost|127\.0\.0\.1/.test(dbUrl);
if (APPLY && !isLocal && !CONFIRM_PROD) { console.error("DATABASE_URL is not local — pass --confirm-prod to write to it"); process.exit(2); }

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const low = (v: unknown) => norm(v).toLowerCase();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "client";

/** "Sept 25" → 2025-09; "Dec24" → 2024-12; "October" / "Aug" (no year) → resolved from the neighbouring tabs. */
function tabMonth(name: string, prevResolved: { y: number; m: number } | null): { y: number; m: number } | null {
  const m = name.toLowerCase().match(/^([a-z]+)\s*'?(\d{2,4})?$/);
  if (!m || !(m[1] in MONTHS)) return null;
  const month = MONTHS[m[1]];
  let year = m[2] ? Number(m[2]) : NaN;
  if (!Number.isNaN(year) && year < 100) year += 2000;
  if (Number.isNaN(year)) {
    // Tabs run newest → oldest: an undated tab is the month just before the previous tab's
    // month (October before "Sept 25" → 2025-10 is one AFTER; so take prev + 1 month).
    if (!prevResolved) year = new Date().getUTCFullYear();
    else { const next = prevResolved.m === 12 ? { y: prevResolved.y + 1, m: 1 } : { y: prevResolved.y, m: prevResolved.m + 1 }; year = next.m === month ? next.y : prevResolved.y; }
  }
  return { y: year, m: month };
}

function rowDay(cell: unknown, fallback: { y: number; m: number }): { day: string; exact: boolean } {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    // Excel serials come back as local-midnight Dates shifted by the TZ; take the IST calendar day.
    const ist = new Date(cell.getTime() + 330 * 60_000);
    return { day: ist.toISOString().slice(0, 10), exact: true };
  }
  const s = norm(cell);
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) { let y = Number(m[3]); if (y < 100) y += 2000; return { day: `${y}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`, exact: true }; }
  return { day: `${fallback.y}-${String(fallback.m).padStart(2, "0")}-01`, exact: false };
}

function statusFor(camp: string, pay: string, ro: string): string {
  const executed = /execut|done|complete|posted|delivered/.test(camp);
  const paid = /done|paid|rec|rcvd|yes|received|settled/.test(pay) && !/not|pending|half|no\b/.test(pay);
  const live = /live|going|on going|ongoing|execution|post/.test(camp);
  if (executed && paid) return "closed";
  if (executed) return "delivered";
  if (live) return "in_progress";
  if (/confirm|cofirm|confrm|yes|cash/.test(ro)) return "confirmed";
  return "draft";
}

interface Deal { tab: string; row: number; day: string; exactDate: boolean; client: string; agency: string | null; roPaise: number; status: string; notes: string; internal: string }

function readDeals(path: string): { deals: Deal[]; skipped: Array<{ tab: string; row: number; why: string }> } {
  const wb = XLSX.readFile(path, { cellDates: true });
  const deals: Deal[] = []; const skipped: Array<{ tab: string; row: number; why: string }> = [];
  let prev: { y: number; m: number } | null = null;
  for (const tab of wb.SheetNames) {
    const month = tabMonth(tab, prev);
    if (!month) { skipped.push({ tab, row: 0, why: "tab is not a month" }); continue; }
    prev = month;
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1, defval: null, raw: true });
    const hi = rows.findIndex((r) => r?.some((c) => low(c).includes("client")));
    if (hi < 0) { skipped.push({ tab, row: 0, why: "no header row" }); continue; }
    const header = rows[hi].map(low);
    const col = (needle: string) => header.findIndex((c) => c.includes(needle));
    const ci = { date: col("date"), client: col("client"), agency: col("agency"), ro: col("ro value"), rost: col("ro status"), inv: col("invoic"), camp: col("campaign status"), pay: col("payment"), cost: col("cost"), comm: col("commission"), margin: col("margin"), remarks: col("remark") };
    rows.slice(hi + 1).forEach((r, i) => {
      const rowNo = hi + 2 + i;
      const client = norm(ci.client >= 0 ? r[ci.client] : null);
      const roRaw = ci.ro >= 0 ? r[ci.ro] : null;
      const ro = typeof roRaw === "number" ? roRaw : Number(String(roRaw ?? "").replace(/[^\d.]/g, ""));
      if (!client) { if (roRaw != null && roRaw !== "") skipped.push({ tab, row: rowNo, why: `no client name (RO ${roRaw})` }); return; }
      if (/^total/i.test(client)) return;
      if (!Number.isFinite(ro) || ro <= 0) { skipped.push({ tab, row: rowNo, why: `no RO value (${JSON.stringify(roRaw)})` }); return; }
      const agencyRaw = norm(ci.agency >= 0 ? r[ci.agency] : null);
      const agency = agencyRaw && !/^(direct|na|n\/a|-|none)$/i.test(agencyRaw) ? agencyRaw : null;
      const { day, exact } = rowDay(ci.date >= 0 ? r[ci.date] : null, month);
      const camp = low(ci.camp >= 0 ? r[ci.camp] : null), pay = low(ci.pay >= 0 ? r[ci.pay] : null), rost = low(ci.rost >= 0 ? r[ci.rost] : null), inv = norm(ci.inv >= 0 ? r[ci.inv] : null);
      const money = (v: unknown) => (typeof v === "number" ? `₹${v.toLocaleString("en-IN")}` : norm(v) || "—");
      const internal = [
        `import:revenue-sheet:${tab}:${rowNo}`,
        `RO status: ${norm(r[ci.rost]) || "—"}`, `Invoicing: ${inv || "—"}`, `Campaign: ${norm(r[ci.camp]) || "—"}`, `Payment: ${norm(r[ci.pay]) || "—"}`,
        `Cost outflow: ${money(ci.cost >= 0 ? r[ci.cost] : null)}`, `Commission: ${norm(ci.comm >= 0 ? r[ci.comm] : null) || "—"}`, `Margin: ${money(ci.margin >= 0 ? r[ci.margin] : null)}`,
        ci.remarks >= 0 && norm(r[ci.remarks]) ? `Remarks: ${norm(r[ci.remarks])}` : null,
        exact ? null : `Date: not in the sheet — tab month used`,
      ].filter(Boolean).join(" · ");
      deals.push({ tab, row: rowNo, day, exactDate: exact, client, agency, roPaise: Math.round(ro * 100), status: statusFor(camp, pay, rost), notes: [agency ? `Agency: ${agency}` : "Direct client", `Imported from the Revenue & Pipeline sheet (${tab})`].join(" · "), internal });
    });
  }
  deals.sort((a, b) => a.day.localeCompare(b.day) || a.tab.localeCompare(b.tab) || a.row - b.row);
  return { deals, skipped };
}

async function main() {
  const { deals, skipped } = readDeals(file);
  const byFy = new Map<string, { n: number; paise: number }>();
  for (const d of deals) { const [y, m] = d.day.split("-").map(Number); const fy = m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`; const e = byFy.get(fy) ?? { n: 0, paise: 0 }; e.n++; e.paise += d.roPaise; byFy.set(fy, e); }
  const clientNames = new Map<string, string>();
  for (const d of deals) clientNames.set(low(d.client), d.client);
  const existing = await prisma.client.findMany({ select: { id: true, companyName: true } });
  const existingByName = new Map(existing.map((c) => [low(c.companyName), c.id]));
  const already = new Set((await prisma.salesOrder.findMany({ where: { internalNotes: { startsWith: "import:revenue-sheet:" } }, select: { internalNotes: true } })).map((o) => o.internalNotes!.split(" · ")[0]));
  const toCreate = deals.filter((d) => !already.has(`import:revenue-sheet:${d.tab}:${d.row}`));
  const newClients = [...clientNames.entries()].filter(([k]) => !existingByName.has(k));
  const statusCount = new Map<string, number>(); for (const d of toCreate) statusCount.set(d.status, (statusCount.get(d.status) ?? 0) + 1);

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${file}`);
  console.log(`deals parsed: ${deals.length} (${deals.filter((d) => d.exactDate).length} with a real date) · skipped rows: ${skipped.length} · already imported: ${deals.length - toCreate.length}`);
  console.log(`clients: ${clientNames.size} distinct names, ${newClients.length} new, ${clientNames.size - newClients.length} match existing clients`);
  console.log(`orders to create: ${toCreate.length} — by status: ${[...statusCount.entries()].map(([s, n]) => `${s} ${n}`).join(", ")}`);
  console.log("RO value by financial year:"); for (const [fy, e] of [...byFy.entries()].sort()) console.log(`  ${fy}: ${e.n} deals · ₹${(e.paise / 100).toLocaleString("en-IN")}`);
  console.log(`total: ₹${(deals.reduce((s, d) => s + d.roPaise, 0) / 100).toLocaleString("en-IN")}`);
  if (skipped.length) { console.log("skipped:"); for (const s of skipped.slice(0, 40)) console.log(`  ${s.tab} row ${s.row}: ${s.why}`); if (skipped.length > 40) console.log(`  … ${skipped.length - 40} more`); }
  if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write."); return; }

  const seller = await getSellerOrDefaults();
  let createdClients = 0, createdOrders = 0;
  for (const [key, name] of newClients) {
    const passwordHash = await hash(crypto.randomBytes(32).toString("hex"), 12);
    const email = `${slug(name)}-${crypto.randomBytes(2).toString("hex")}@imported.invalid`;
    const c = await prisma.client.create({ data: { companyName: name, contactName: name, email, passwordHash, status: "ACTIVE" }, select: { id: true } });
    existingByName.set(key, c.id); createdClients++;
  }
  for (const d of toCreate) {
    const clientId = existingByName.get(low(d.client))!;
    const when = new Date(`${d.day}T06:30:00.000Z`); // noon IST, so createdAt sorts by the deal day
    await prisma.$transaction(async (tx) => {
      const number = await nextDocumentNumber(tx, "order", seller.orderPrefix, d.day);
      const o = await tx.salesOrder.create({
        data: {
          number, clientId, title: d.client, status: d.status, campaignType: "brand",
          startDate: dayToDate(d.day), placeOfSupplyCode: null, taxMode: "none", gstRateBp: 0,
          subtotalPaise: d.roPaise, discountPaise: 0, taxablePaise: d.roPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: d.roPaise,
          notes: d.notes, internalNotes: d.internal, createdById: "import", createdAt: when,
          confirmedAt: d.status === "draft" ? null : when, deliveredAt: d.status === "delivered" || d.status === "closed" ? when : null, closedAt: d.status === "closed" ? when : null,
          items: { create: [{ position: 0, kind: "custom", description: d.client, quantity: 1, unitPricePaise: d.roPaise, discountPaise: 0, amountPaise: d.roPaise, sac: seller.defaultSac, status: d.status === "delivered" || d.status === "closed" ? "delivered" : "pending", deliveredOn: d.status === "delivered" || d.status === "closed" ? dayToDate(d.day) : null }] },
        },
        select: { id: true },
      });
      await logSalesEvent(tx, { entityType: "order", entityId: o.id, action: "imported", toStatus: d.status, note: `${number} · Revenue & Pipeline sheet ${d.tab} row ${d.row}` });
    });
    createdOrders++;
  }
  console.log(`\ncreated ${createdClients} clients and ${createdOrders} orders`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
