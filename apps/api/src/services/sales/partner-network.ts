import { z } from "zod";
import { prisma } from "@dashmani/db";

// The external PARTNER NETWORK (owner sheet "Digital Sukoon Private Limited Management",
// 2026-11-18, sheet "Partner Networks"): Instagram pages we do NOT own — Instant Bollywood,
// Pinkvilla, Filmygyan… — that we buy posts on for a client. Owner decision 2026-11-18: they are
// SALES INVENTORY ONLY. The sales team sees them with their prices and can quote them; clients
// never see them on the client portal (they are not rate cards, so the catalogue, checkout and
// the publisher cannot reach them), and nothing is ever posted on them by us.
//
// ⚠️ SUPERSEDED 2026-11-18 (same day): partner pages now live in sales_external_pages with the
// vendors' pages (external-pages.service.ts). This file only READS the old system_settings value, for
// scripts/migrate-partner-network.ts, which copies it into the table and deletes the setting.

export const PARTNER_NETWORK_KEY = "sales.partnerNetwork";

const rupeesPaise = z.number().int().min(100).max(100_000_000).nullable();

export const partnerPageSchema = z.object({
  /** Instagram username, lowercased, no "@" — the page's identity. */
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9._]{1,30}$/),
  name: z.string().trim().min(1).max(120),
  platform: z.literal("instagram").default("instagram"),
  profileUrl: z.string().url().max(300),
  /** The follower count written on the owner's sheet (partners are not synced). */
  followers: z.number().int().min(0).nullable(),
  category: z.string().trim().max(60).nullable().default("Bollywood"),
  /** Price per post, in paise, by campaign type. null = the partner does not take that type. */
  brandPaise: rupeesPaise,
  entertainmentPaise: rupeesPaise,
  eventPaise: rupeesPaise,
  /** Song (audio) integration on a reel, in paise. null = not offered. */
  audioPaise: rupeesPaise,
});
export type PartnerPage = z.infer<typeof partnerPageSchema>;

export const partnerNetworkSchema = z.object({
  /** Where the list came from (the sheet's file name), and when it was written (ISO). */
  source: z.string().max(200).nullable().default(null),
  updatedAt: z.string().max(40).nullable().default(null),
  pages: z.array(partnerPageSchema).max(500),
});
export type PartnerNetwork = z.infer<typeof partnerNetworkSchema>;

/** The stored partner network; an empty list when none is stored or the stored value is unreadable. */
export async function getPartnerNetwork(): Promise<PartnerNetwork> {
  const row = await prisma.systemSetting.findUnique({ where: { key: PARTNER_NETWORK_KEY } });
  if (!row?.value) return { source: null, updatedAt: null, pages: [] };
  try {
    const parsed = partnerNetworkSchema.safeParse(JSON.parse(row.value));
    if (parsed.success) return parsed.data;
    console.warn(`[sales] ${PARTNER_NETWORK_KEY} is not a valid partner list — ignored: ${parsed.error.issues[0]?.message}`);
  } catch {
    console.warn(`[sales] ${PARTNER_NETWORK_KEY} is not JSON — ignored`);
  }
  return { source: null, updatedAt: null, pages: [] };
}
