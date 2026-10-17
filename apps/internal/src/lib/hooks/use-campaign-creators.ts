import useSWR from "swr";
import { apiFetch } from "@/lib/api";

// Campaign rate card: the creator pages staff can price (GET /v1/admin/campaigns/rate-cards/creator-targets).
// Admin/Super Admin only on the API. STAFF ONLY: the shares, payouts and bank state it carries must never be
// shown to a client or a creator.

export type CreatorNotBookable = "no_payout_account" | "payout_not_activated" | "bookable_later" | "bank_change";

export interface CreatorCard {
  id: string;
  format: string;
  pricePaise: number;
  entertainmentPricePaise: number | null;
  audioAddonPaise: number | null;
  /** false = switched off (for example the page changed hands): not offered until a share is saved again. */
  active: boolean;
  /** Basis points (7500 = 75%) of the price the creator gets, before tax. null = none set, so it can't be offered. */
  shareBps: number | null;
}

export interface CreatorTarget {
  targetType: "creator_asset";
  targetId: string;
  platform: "instagram" | "facebook";
  name: string;
  username: string | null;
  pictureUrl: string | null;
  followers: number | null;
  views28d: number | null;
  engagements28d: number | null;
  engagementRatePct: number | null;
  profileUrl: string | null;
  /** Who owns the page. null only if the owner couldn't be read. */
  creator: {
    id: string;
    name: string;
    /** Tax withheld from the creator's share, in basis points (0 = none set). */
    tdsBps: number;
    /** A client could book it today, the marketplace switches aside. */
    bookable: boolean;
    notBookable: CreatorNotBookable | null;
  } | null;
  category: string | null;
  formats: string[];
  cards: CreatorCard[];
}

export const CREATOR_TARGETS_KEY = "/admin/campaigns/rate-cards/creator-targets";

export function useCreatorRateTargets() {
  return useSWR<CreatorTarget[]>(CREATOR_TARGETS_KEY, (u: string) => apiFetch<{ data: CreatorTarget[] }>(u).then((r) => r.data), {
    revalidateOnFocus: false,
  });
}
