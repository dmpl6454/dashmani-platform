"use client";

/**
 * The Account Growth tab strip and boards, shared by the /accounts/growth page and the
 * Overview's in-place Account Growth panel, so both always render exactly the same boards.
 * The page owns URL/tab syncing; the Overview panel keeps the tab in local state so it
 * never navigates. See page.tsx for the per-tab provenance notes.
 */

import { type ComponentProps } from "react";
import dynamic from "next/dynamic";
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

export const TABS = [
  { key: "meta", label: "Meta", dot: "var(--hx-238BFF)" },
  { key: "youtube", label: "YouTube", dot: "var(--hx-FF5A5F)" },
  { key: "snapchat", label: "Snapchat", dot: "var(--hx-E9D23A)" },
  { key: "all", label: "All", dot: "var(--hx-E9BD62)" },
] as const;

export type GrowthTab = (typeof TABS)[number]["key"];

export function parseTab(v: string | null | undefined): GrowthTab | null {
  return TABS.some((t) => t.key === v) ? (v as GrowthTab) : null;
}

/** The tab strip on its own, so the Suspense fallback can render it without state. */
export function TabStrip({ tab, onSelect }: { tab: GrowthTab; onSelect: (t: GrowthTab) => void }) {
  return (
    <div
      className="flex items-center gap-1 shadow-[inset_0_-1px_0_#182C39] overflow-x-auto [scrollbar-width:none]"
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
            className={`inline-flex items-center gap-2 h-[42px] px-[18px] text-[13px] font-semibold whitespace-nowrap transition-colors ${
              active ? "text-ds-text" : "text-ds-t2 hover:text-ds-text"}`}
            style={{ boxShadow: `inset 0 -2px 0 ${active ? "var(--hx-E9BD62)" : "transparent"}` }}
          >
            <i className="h-[7px] w-[7px] rounded-full" style={{ background: t.dot }} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** The active board under the tab strip. ⚠️ Only the active tab is mounted (see page.tsx). */
export function GrowthView({ tab, onSelect }: { tab: GrowthTab; onSelect: (t: GrowthTab) => void }) {
  return (
    <div>
      <TabStrip tab={tab} onSelect={onSelect} />
      <div className="mt-4 space-y-4">

      {/* The Meta-specific promise lives HERE, not in the page header, because it is only
          true of this board — see the file header of page.tsx. */}
      {tab === "meta" && (
        <>
          <p className="text-[12px] text-ds-t3 max-w-[760px] leading-[1.6] [text-wrap:pretty]">
            Every channel below belongs to the connected Meta account, and every figure comes
            from Meta&apos;s own API — nothing on this tab is scraped or entered by hand. Pick a
            time window to see views, reach and engagement over that period.
          </p>
          <MetaPanel />
        </>
      )}

      {/* ⚠️ Rendered, not hidden. See the mounting note in page.tsx. */}
      {tab === "youtube" && <YouTubePanel />}
      {tab === "snapchat" && <SnapchatPanel />}
      {tab === "all" && <AllPanel onOpenTab={onSelect} />}
      </div>
    </div>
  );
}

const PANEL_CARD = "bg-ds-card rounded-[12px] border border-[color:var(--hx-1D3444)] p-5";

/** While the All tab's code downloads — a moment, the first time it is opened. */
function AllPanelLoading() {
  return (
    <section className={PANEL_CARD} aria-busy="true">
      <h2 className="text-[17px] font-semibold text-ds-text">All platforms</h2>
      <p className="text-[12px] text-ds-t3 mt-1 animate-pulse">Loading…</p>
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
      <h2 className="text-[17px] font-semibold text-ds-text">All platforms</h2>
      <p className="text-[12.5px] text-ds-t2">
        This tab couldn&apos;t be opened just now — the portal may have been updated since this page
        loaded, or the connection dropped. The other tabs still work.
      </p>
      <button
        onClick={() => window.location.reload()}
        className="text-[12px] text-ds-gold underline underline-offset-[3px] hover:text-ds-gold2"
      >
        Reload the page
      </button>
    </section>
  );
}
