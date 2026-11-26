import { z } from "zod";
import { Prisma, prisma } from "@dashmani/db";
import { AppError } from "../../middleware/error-handler";
import { invalidateInventoryCache } from "./inventory.service";

// External pages and the vendors who sell them (owner, 2026-11-18): "Vendor adding — meme vendors
// Archit, Amit, Arif for Facebook pages; cricket vendor Mahesh", "Individual meme pages", "Inventory
// adding options category wise". One list of every page we do NOT own and buy posts on — the
// partner network (Pinkvilla, Filmygyan… moved here from system_settings) and each vendor's pages.
//
// Sales inventory only: never a rate card, so the client catalogue, checkout and the publisher can
// never reach one. Every write drops the inventory memo so the Inventory page shows it at once.

export const EXTERNAL_PLATFORMS = ["instagram", "facebook", "youtube", "x", "snapchat", "other"] as const;

const paise = z.number().int().min(100).max(100_000_000).nullable().optional();
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const vendorInputSchema = z.object({
  name: text(120).min(1, "Name the vendor"),
  phone: optText(30),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email")
    .max(200)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  notes: text(2000).optional().default(""),
  active: z.boolean().optional().default(true),
});
export type VendorInput = z.input<typeof vendorInputSchema>;

/** "@Some.Page" or a profile link → "some.page"; anything unusable → null (a page may have no handle). */
export function normaliseHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = raw.trim();
  const url = h.match(/^https?:\/\/[^/]+\/(?:@)?([^/?#]+)/i);
  if (url) h = url[1];
  h = h.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._-]{1,60}$/.test(h) ? h : null;
}

export const externalPageInputSchema = z
  .object({
    vendorId: z.string().uuid().nullable().optional(),
    platform: z.enum(EXTERNAL_PLATFORMS),
    handle: z.string().trim().max(300).nullable().optional(),
    name: text(120).min(1, "Name the page"),
    profileUrl: z
      .string()
      .trim()
      .url("Enter the page's link (https://…)")
      .max(300)
      .refine((u) => /^https?:\/\//i.test(u), "Only http(s) links")
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    followers: z.number().int().min(0).max(5_000_000_000).nullable().optional(),
    category: optText(60),
    brandPaise: paise,
    entertainmentPaise: paise,
    eventPaise: paise,
    audioPaise: paise,
    notes: text(2000).optional().default(""),
    active: z.boolean().optional().default(true),
  })
  .transform((v) => ({ ...v, handle: normaliseHandle(v.handle ?? null) ?? normaliseHandle(v.profileUrl ?? null) }));
export type ExternalPageInput = z.input<typeof externalPageInputSchema>;

const pageSelect = {
  id: true,
  vendorId: true,
  platform: true,
  handle: true,
  name: true,
  profileUrl: true,
  followers: true,
  category: true,
  brandPaise: true,
  entertainmentPaise: true,
  eventPaise: true,
  audioPaise: true,
  notes: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  vendor: { select: { id: true, name: true, active: true } },
} satisfies Prisma.SalesExternalPageSelect;

export type ExternalPageRow = Prisma.SalesExternalPageGetPayload<{ select: typeof pageSelect }>;

export async function listVendors() {
  const rows = await prisma.salesVendor.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { pages: true } } },
  });
  return rows.map(({ _count, ...v }) => ({ ...v, pageCount: _count.pages }));
}

export async function createVendor(input: VendorInput, actorId: string) {
  const v = vendorInputSchema.parse(input);
  const row = await prisma.salesVendor.create({ data: { ...v, createdById: actorId } });
  invalidateInventoryCache();
  return { ...row, pageCount: 0 };
}

export async function updateVendor(id: string, input: VendorInput) {
  const v = vendorInputSchema.parse(input);
  const row = await prisma.salesVendor.update({ where: { id }, data: v, include: { _count: { select: { pages: true } } } }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw new AppError(404, "NOT_FOUND", "Vendor not found");
    throw e;
  });
  invalidateInventoryCache();
  const { _count, ...rest } = row;
  return { ...rest, pageCount: _count.pages };
}

/** Every external page, active ones first (by followers), then switched-off ones. */
export async function listExternalPages(): Promise<ExternalPageRow[]> {
  return prisma.salesExternalPage.findMany({
    select: pageSelect,
    orderBy: [{ active: "desc" }, { followers: { sort: "desc", nulls: "last" } }, { name: "asc" }],
  });
}

function handleTaken(e: unknown, platform: string, handle: string | null): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
    throw new AppError(409, "HANDLE_TAKEN", `@${handle} is already on the ${platform} list — edit that page instead`);
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") throw new AppError(400, "VENDOR_NOT_FOUND", "That vendor no longer exists");
  throw e;
}

export async function createExternalPage(input: ExternalPageInput, actorId: string): Promise<ExternalPageRow> {
  const p = externalPageInputSchema.parse(input);
  const row = await prisma.salesExternalPage
    .create({ data: { ...p, vendorId: p.vendorId ?? null, createdById: actorId }, select: pageSelect })
    .catch((e) => handleTaken(e, p.platform, p.handle));
  invalidateInventoryCache();
  return row;
}

export async function updateExternalPage(id: string, input: ExternalPageInput): Promise<ExternalPageRow> {
  const p = externalPageInputSchema.parse(input);
  const row = await prisma.salesExternalPage
    .update({ where: { id }, data: { ...p, vendorId: p.vendorId ?? null }, select: pageSelect })
    .catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw new AppError(404, "NOT_FOUND", "Page not found");
      return handleTaken(e, p.platform, p.handle);
    });
  invalidateInventoryCache();
  return row;
}

/**
 * Add or refresh pages by (platform, handle) — the owner's rate sheet and the old partner-network
 * setting are loaded through this. A page already on the list keeps its vendor, notes and on/off
 * switch; only the sheet's name, link, followers, category and prices are written. Returns counts.
 */
export async function upsertExternalPages(
  pages: ReadonlyArray<ExternalPageInput>,
  actorId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ created: number; updated: number; unchanged: number }> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const input of pages) {
    const p = externalPageInputSchema.parse(input);
    if (!p.handle) throw new Error(`${p.name}: a page loaded from a sheet needs a handle`);
    const cur = await prisma.salesExternalPage.findUnique({ where: { platform_handle: { platform: p.platform, handle: p.handle } } });
    const sheet = {
      name: p.name,
      profileUrl: p.profileUrl ?? null,
      followers: p.followers ?? null,
      category: p.category ?? null,
      brandPaise: p.brandPaise ?? null,
      entertainmentPaise: p.entertainmentPaise ?? null,
      eventPaise: p.eventPaise ?? null,
      audioPaise: p.audioPaise ?? null,
    };
    if (!cur) {
      created++;
      if (!opts.dryRun)
        await prisma.salesExternalPage.create({ data: { ...sheet, platform: p.platform, handle: p.handle, vendorId: p.vendorId ?? null, createdById: actorId } });
      continue;
    }
    const same = (Object.keys(sheet) as Array<keyof typeof sheet>).every((k) => cur[k] === sheet[k]);
    if (same) {
      unchanged++;
      continue;
    }
    updated++;
    if (!opts.dryRun) await prisma.salesExternalPage.update({ where: { id: cur.id }, data: sheet });
  }
  if (!opts.dryRun) invalidateInventoryCache();
  return { created, updated, unchanged };
}
