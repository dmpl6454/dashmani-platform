"use client";

/**
 * Account Growth — CONNECTED CHANNELS ONLY.
 *
 * ⚠️ This page deliberately shows nothing but the Meta channels the connected
 * account administers. Owner decision 2026-08-24: it is its own entity and every
 * figure on it must be end-to-end API-accurate.
 *
 * What used to be here and was REMOVED on purpose (2026-08-24) — do not restore
 * without the owner asking:
 *   • the four summary cards (Total Followers / Net Change / Accounts Tracked /
 *     Gainers-Decliners)
 *   • the All Accounts table
 *   • Top Movers, and Top Movers by Platform
 *
 * Those were org-wide roll-ups spanning platforms this page no longer speaks for,
 * and they were driven by follower snapshots rather than by Meta's own channel
 * metrics. `useGrowthOverview` still backs the DASHBOARD, so the hook and the
 * /admin/growth endpoint are intentionally left in place — this page just stopped
 * being a second consumer of them.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { MetaPanel } from "./_meta-panel";

export default function AccountGrowthPage() {
  usePageTitle("Account Growth");

  return (
    <div className="space-y-6 pop-in">
      <div className="flex items-center gap-3">
        <Link
          href="/accounts"
          className="flex items-center gap-1 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Accounts
        </Link>
      </div>

      <div>
        <h1 className="font-serif text-2xl font-medium text-[#1A1A1A]">Account Growth</h1>
        <p className="text-sm text-[#7A7A7A] mt-0.5">
          Facebook Pages &amp; Instagram accounts read directly from Meta
        </p>
        <p className="text-xs text-[#B0B0B0] mt-1 max-w-3xl leading-snug">
          Every channel below belongs to the connected Meta account, and every figure
          comes from Meta&apos;s own API — nothing here is scraped or entered by hand.
          Pick a time window to see views, reach and engagement over that period.
        </p>
      </div>

      <MetaPanel />
    </div>
  );
}
