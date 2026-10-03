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

import { Suspense, useEffect, useRef, useState, type ComponentProps } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { MetaPanel } from "./_meta-panel";
import { YouTubePanel } from "./_youtube-panel";
import { SnapchatPanel } from "./_snapchat-panel";
import type { AllPanel as AllPanelComponent } from "./_all-panel";

type AllPanelProps = ComponentProps<typeof AllPanelComponent>;

// ⚠️ LOADED ONLY WHEN THE ALL TAB IS OPENED. Its code — the panel and the pure combine
// module — stays off the first load of the Meta tab everyone lands on (as a static import
// it added ~13 kB of First Load JS to every tab). Same pattern as the Submission gaps tab
// on /reports/links; the tab mounts only while active, so this costs one chunk request the
// first time All is opened, and none for anyone who never opens it.
// ⚠️ The catch is load-bearing. After a deploy an open page's old chunk is gone, and an
// unhandled ChunkLoadError would replace the WHOLE page with Next's "Application error"
// screen (there is no error.tsx in this app). A failed load renders a calm reload card.
const AllPanel = dynamic<AllPanelProps>(
  () => import("./_all-panel").then((m) => m.AllPanel).catch(() => AllPanelUnavailable),
  { ssr: false, loading: () => <AllPanelLoading /> },
);

const TABS = [
  { key: "meta", label: "Meta" },
  { key: "youtube", label: "YouTube" },
  { key: "snapchat", label: "Snapchat" },
  { key: "all", label: "All" },
] as const;

type GrowthTab = (typeof TABS)[number]["key"];

const TAB_STORAGE_KEY = "account-growth:tab";

function parseTab(v: string | null | undefined): GrowthTab | null {
  return TABS.some((t) => t.key === v) ? (v as GrowthTab) : null;
}

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
          Followers, views and engagement across every channel we track
        </p>
        <p className="text-xs text-[#B0B0B0] mt-1 max-w-3xl leading-snug">
          Three boards, and they do not share a source. Each tab says where its own numbers
          come from and what its platform refuses to publish. A dash is never a zero: the
          platform published nothing, our history is too short so far, or a movement is finer
          than the platform&apos;s rounding — each tab says which. Pick a period
          inside a tab; each one keeps its own. The All tab adds the boards up wherever a figure
          means the same thing on every platform.
        </p>
      </div>

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

/** The tab strip on its own, so the Suspense fallback can render it without state. */
function TabStrip({ tab, onSelect }: { tab: GrowthTab; onSelect: (t: GrowthTab) => void }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b border-[#E8E0D0] -mb-px"
      role="tablist"
      aria-label="Channel source"
    >
      {TABS.map((t) => {
        const active = t.key === tab;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(t.key)}
            className={`text-sm font-medium px-3.5 py-2 border-b-2 -mb-px transition-colors ${
              active
                ? "border-[#5B4BF5] text-[#1A1A1A]"
                : "border-transparent text-[#7A7A7A] hover:text-[#1A1A1A]"}`}
          >
            {t.label}
          </button>
        );
      })}
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

  return (
    <div className="space-y-6">
      <TabStrip tab={tab} onSelect={selectTab} />

      {/* The Meta-specific promise lives HERE, not in the page header, because it is only
          true of this board — see the file header. */}
      {tab === "meta" && (
        <>
          <p className="text-xs text-[#B0B0B0] max-w-3xl leading-snug -mt-2">
            Every channel below belongs to the connected Meta account, and every figure comes
            from Meta&apos;s own API — nothing on this tab is scraped or entered by hand. Pick a
            time window to see views, reach and engagement over that period.
          </p>
          <MetaPanel />
        </>
      )}

      {/* ⚠️ Rendered, not hidden. See the mounting note in the file header. */}
      {tab === "youtube" && <YouTubePanel />}
      {tab === "snapchat" && <SnapchatPanel />}
      {tab === "all" && <AllPanel onOpenTab={selectTab} />}
    </div>
  );
}

const PANEL_CARD = "bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5";

/** While the All tab's code downloads — a moment, the first time it is opened. */
function AllPanelLoading() {
  return (
    <section className={PANEL_CARD} aria-busy="true">
      <h2 className="font-serif text-lg text-[#1A1A1A]">All platforms</h2>
      <p className="text-xs text-[#B0B0B0] mt-1 animate-pulse">Loading…</p>
    </section>
  );
}

/**
 * The All tab's code could not be fetched — usually a page left open across a deploy (its
 * old chunk is gone) or a dropped connection. Nothing about the figures is wrong, and a
 * reload fetches the current code.
 */
function AllPanelUnavailable(_props: AllPanelProps) {
  return (
    <section className={`${PANEL_CARD} space-y-2`}>
      <h2 className="font-serif text-lg text-[#1A1A1A]">All platforms</h2>
      <p className="text-sm text-[#7A7A7A]">
        This tab couldn&apos;t be opened just now — the portal may have been updated since this page
        loaded, or the connection dropped. The other tabs still work.
      </p>
      <button
        onClick={() => window.location.reload()}
        className="text-xs text-[#5B4BF5] underline hover:text-[#1A1A1A]"
      >
        Reload the page
      </button>
    </section>
  );
}
