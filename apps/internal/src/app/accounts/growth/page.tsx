"use client";

/**
 * Account Growth — three boards, three different sources, one tab each, plus an All tab
 * that adds them up.
 *
 * ⚠️ EACH TAB SPEAKS FOR A DIFFERENT ESTATE WITH DIFFERENT PROVENANCE, AND THE PAGE
 * HEADER MUST NOT SPEAK FOR ALL OF THEM. It used to say "every figure comes from Meta's
 * own API — nothing here is scraped or entered by hand", which was true when Meta was the
 * only board and became FALSE the moment a Snapchat tab appeared beside it: Snapchat has
 * no API for profiles we do not own, so that board is read from public profile pages. The
 * claim now lives inside the Meta tab, where it is still true, and the page header only
 * promises that each tab says where its own numbers come from.
 *
 *   Meta      — Facebook Pages and Instagram accounts the connected Meta account
 *               administers, read from Meta's own API. Owner decision 2026-08-24: this
 *               board is its own entity and every figure on it must be end-to-end
 *               API-accurate, which is why scraper-derived data was removed from it.
 *   YouTube   — the official YouTube Data API.
 *   Snapchat  — each channel's public profile page (unofficial; a profile can withhold
 *               a figure, and then we show a dash).
 *   All       — not a fourth source: the three boards' OWN figures added up where a figure
 *               means the same thing on every platform, each labelled with its source and
 *               exact dates. 7d and 28d only — the periods every platform measures alike.
 *               See _all-panel.tsx and packages/shared/src/growth/combine.ts.
 *
 * ⚠️ ONLY THE ACTIVE TAB IS MOUNTED — `{tab === "youtube" && <YouTubePanel />}`, never
 * mount-and-hide with CSS. Every mounted panel fires its own endpoint on every page load,
 * so hiding two of them with `display:none` would spend a user's rate-limit budget on
 * data nobody is looking at, three times over, on every visit.
 *
 * What was REMOVED from this page on purpose (2026-08-24) and must not come back without
 * the owner asking: the four org-wide summary cards (Total Followers / Net Change /
 * Accounts Tracked / Gainers-Decliners), the All Accounts table, and Top Movers. They
 * were roll-ups spanning platforms no single board speaks for, driven by follower
 * snapshots rather than each platform's own metrics. `useGrowthOverview` still backs the
 * DASHBOARD, so that hook and the /admin/growth endpoint stay — this page just stopped
 * being a second consumer of them.
 *
 * ⚠️ 2026-10-01: THE OWNER EXPLICITLY ASKED FOR A COMBINED VIEW ("a fourth tab that
 * depicts 'All' the data in a combined format … with accurate date depicted e2e"), which
 * supersedes the "must not come back" note above IN ONE SPECIFIC FORM: the All tab sums
 * each board's OWN figures (Meta's API board, YouTube's Data API board, Snapchat's
 * public-profile board), labels every figure with its source and the dates it covers, and
 * never reads /admin/growth or snapshot roll-ups for Meta. The snapshot-driven cards, the
 * All Accounts table and Top Movers stay removed.
 */

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { GrowthView, TabStrip, parseTab, type GrowthTab } from "./_growth-view";

const TAB_STORAGE_KEY = "account-growth:tab";

export default function AccountGrowthPage() {
  usePageTitle("Account Growth");

  return (
    <div className="pb-6">
      <section className="pt-[22px] pb-[18px]">
        <Link
          href="/accounts"
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ds-t2 hover:text-ds-gold transition-colors"
        >
          <ArrowLeft className="h-[13px] w-[13px]" strokeWidth={2} /> Accounts
        </Link>
        <div className="mt-4 max-w-[760px]">
        <p className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Social Media</p>
        <h1 className="mt-2 text-[28px] font-semibold tracking-[-.02em] text-ds-text">Account Growth</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t5">
          Followers, views and engagement across every channel we track
        </p>
        <p className="mt-2 text-[12px] leading-[1.6] text-ds-t3 [text-wrap:pretty]">
          Three boards, and they do not share a source. Each tab says where its own numbers
          come from and what its platform refuses to publish. A dash is never a zero: the
          platform published nothing, our history is too short so far, or a movement is finer
          than the platform&apos;s rounding — each tab says which. Pick a period
          inside a tab; each one keeps its own. The All tab adds the boards up wherever a figure
          means the same thing on every platform.
        </p>
        </div>
      </section>

      {/* ⚠️ useSearchParams() must sit under a Suspense boundary or the build complains
          that the route deopted into client-side rendering. Same pattern as the sibling
          /accounts page, which wraps its inner component for exactly this reason. The
          static header above stays outside it, so nothing above the fold can flash. */}
      <Suspense fallback={<TabStrip tab="meta" onSelect={() => {}} />}>
        <GrowthTabs />
      </Suspense>
    </div>
  );
}

function GrowthTabs() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = parseTab(searchParams.get("tab"));

  // Initialised from the URL only. ⚠️ localStorage is deliberately NOT read here:
  // the first render also happens during prerender, where it does not exist, and a
  // value that differs between server and client is a hydration mismatch.
  const [tab, setTab] = useState<GrowthTab>(urlTab ?? "meta");
  const bootstrapped = useRef(false);

  function selectTab(next: GrowthTab) {
    setTab(next);
    // ⚠️ Every localStorage access is wrapped: it throws outright in a private window
    // and wherever site data is blocked, and remembering a tab must never be able to
    // take the page down.
    try { window.localStorage.setItem(TAB_STORAGE_KEY, next); } catch { /* not remembered, still works */ }
    // replace, not push — flipping tabs should not fill the back button with them.
    router.replace(next === "meta" ? "/accounts/growth" : `/accounts/growth?tab=${next}`, { scroll: false });
  }

  // Remembered tab, consulted exactly once and only when the URL does not name one.
  // A shared link must open what it names, so the URL always wins over the preference.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    if (urlTab) return;
    let stored: GrowthTab | null = null;
    try { stored = parseTab(window.localStorage.getItem(TAB_STORAGE_KEY)); } catch { /* none */ }
    if (stored && stored !== "meta") selectTab(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the visible tab following the URL so browser back/forward works. Only when the
  // URL actually names one — an absent ?tab= after a replace to "meta" is handled by the
  // replace itself, and treating absence as "go to meta" here would fight the bootstrap.
  useEffect(() => {
    if (urlTab && urlTab !== tab) setTab(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  return <GrowthView tab={tab} onSelect={selectTab} />;
}
