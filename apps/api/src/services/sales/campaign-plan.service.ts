import { z } from "zod";
import { Prisma, prisma } from "@dashmani/db";
import { AppError } from "../../middleware/error-handler";
import { listInventory, type InventoryChannel } from "./inventory.service";

// A Pipeline campaign's plan, on the sales portal's project page (owner, 2026-11-18):
//  - "Attachment of list (inventory) category wise": the pages planned for the campaign, picked
//    from the sales inventory (our network + external pages) by category, stored as a snapshot so a
//    later price change never rewrites a list the team already agreed on; downloadable as CSV.
//  - "Revenue per campaign" + "Payment in cash / without GST": what the campaign is worth and how it
//    is paid. Cash is an INTERNAL record only (owner decision): it is not an invoice, so it never
//    reaches GST returns, Tally, e-invoicing or the client portal.
//
// Sales-only: /v1/sales/pipeline/:projectId/… behind sales:view / sales:manage, on the main pool
// (never the Pipeline routes — those are open to every HR user and stay price-free).

const MAX_PAGES = 500;

export const addPagesSchema = z.object({
  /** "meta_asset:<id>" | "social_account:<id>" | "external:<id>" — as the inventory lists them. */
  pageKeys: z.array(z.string().trim().min(3).max(80)).min(1).max(MAX_PAGES),
});

export const revenueSchema = z
  .object({
    amountPaise: z.number().int().min(0).max(2_000_000_000),
    paymentMode: z.enum(["gst", "cash"]),
    receivedPaise: z.number().int().min(0).max(2_000_000_000).optional().default(0),
    receivedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-18")
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "Not a real date")
      .nullable()
      .optional(),
    note: z.string().trim().max(2000).optional().default(""),
  })
  .refine((v) => v.receivedPaise <= v.amountPaise, { message: "Received can't be more than the campaign's value", path: ["receivedPaise"] });

export type CampaignPage = Awaited<ReturnType<typeof listPages>>[number];

async function assertProject(projectId: string) {
  if (!z.string().uuid().safeParse(projectId).success) throw new AppError(404, "NOT_FOUND", "Project not found");
  const p = await prisma.pipelineProject.findUnique({ where: { id: projectId }, select: { kind: true, deletedAt: true } });
  if (!p || p.kind !== "project" || p.deletedAt) throw new AppError(404, "NOT_FOUND", "Project not found");
}

function listPages(projectId: string) {
  return prisma.pipelineProjectPage.findMany({
    where: { projectId },
    orderBy: [{ category: { sort: "asc", nulls: "last" } }, { followers: { sort: "desc", nulls: "last" } }, { name: "asc" }],
  });
}

function revenueView(r: Awaited<ReturnType<typeof prisma.pipelineProjectRevenue.findUnique>>) {
  if (!r) return null;
  return {
    amountPaise: r.amountPaise,
    paymentMode: r.paymentMode as "gst" | "cash",
    receivedPaise: r.receivedPaise,
    receivedOn: r.receivedOn ? r.receivedOn.toISOString().slice(0, 10) : null,
    note: r.note,
    updatedById: r.updatedById,
    updatedAt: r.updatedAt,
  };
}

export async function getCampaignPlan(projectId: string) {
  await assertProject(projectId);
  const [pages, revenue] = await Promise.all([listPages(projectId), prisma.pipelineProjectRevenue.findUnique({ where: { projectId } })]);
  return { pages, revenue: revenueView(revenue) };
}

/** The lowest active per-post price by campaign type, across a channel's formats. */
function lowest(c: InventoryChannel, k: "pricePaise" | "entertainmentPricePaise" | "eventPricePaise"): number | null {
  const v = c.offers.filter((o) => o.active).map((o) => o[k]).filter((p): p is number => p != null);
  return v.length ? Math.min(...v) : null;
}

/**
 * Add pages to the campaign, by inventory key. Pages already on the list are skipped (no error),
 * so a double click or two people adding the same page is harmless. A key the inventory no longer
 * lists (a page switched off meanwhile) is refused with its key named.
 */
export async function addPages(projectId: string, pageKeys: string[], actorId: string) {
  await assertProject(projectId);
  const inv = await listInventory();
  const byKey = new Map(inv.map((c) => [`${c.targetType}:${c.targetId}`, c]));
  const keys = Array.from(new Set(pageKeys));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length) throw new AppError(400, "PAGE_NOT_IN_INVENTORY", `${missing.length} page(s) are no longer in the inventory — reload and pick again`);
  const existing = await prisma.pipelineProjectPage.count({ where: { projectId } });
  if (existing + keys.length > MAX_PAGES) throw new AppError(400, "TOO_MANY_PAGES", `A campaign can list up to ${MAX_PAGES} pages`);
  const res = await prisma.pipelineProjectPage.createMany({
    skipDuplicates: true,
    data: keys.map((k) => {
      const c = byKey.get(k)!;
      return {
        projectId,
        pageKey: k,
        source: c.source,
        platform: c.platform.slice(0, 16),
        name: c.name.slice(0, 120),
        handle: c.handle?.slice(0, 60) ?? null,
        category: c.category?.slice(0, 60) ?? null,
        vendorName: c.vendorName?.slice(0, 120) ?? null,
        followers: c.followers,
        profileUrl: c.profileUrl && c.profileUrl.length <= 300 ? c.profileUrl : null,
        brandPaise: lowest(c, "pricePaise"),
        entertainmentPaise: lowest(c, "entertainmentPricePaise"),
        eventPaise: lowest(c, "eventPricePaise"),
        addedById: actorId,
      };
    }),
  });
  return { added: res.count, pages: await listPages(projectId) };
}

export async function removePage(projectId: string, pageId: string) {
  await assertProject(projectId);
  await prisma.pipelineProjectPage.deleteMany({ where: { id: pageId, projectId } });
  return { pages: await listPages(projectId) };
}

export async function setRevenue(projectId: string, input: z.input<typeof revenueSchema>, actorId: string) {
  await assertProject(projectId);
  const v = revenueSchema.parse(input);
  const data = {
    amountPaise: v.amountPaise,
    paymentMode: v.paymentMode,
    receivedPaise: v.receivedPaise,
    receivedOn: v.receivedOn ? new Date(`${v.receivedOn}T00:00:00Z`) : null,
    note: v.note,
    updatedById: actorId,
  };
  const r = await prisma.pipelineProjectRevenue
    .upsert({ where: { projectId }, create: { projectId, ...data }, update: data })
    .catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") throw new AppError(404, "NOT_FOUND", "Project not found");
      throw e;
    });
  return revenueView(r);
}

export async function clearRevenue(projectId: string) {
  await assertProject(projectId);
  await prisma.pipelineProjectRevenue.deleteMany({ where: { projectId } });
  return null;
}
