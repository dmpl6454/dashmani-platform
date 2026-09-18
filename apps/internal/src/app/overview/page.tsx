"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useOverview } from "./_hooks";
import type { OverviewPayload, OverviewPeriod, WidgetPeriod, ChannelDirectoryRow } from "./_types";
import {
  T, CATEGORICAL, SERIES4, TIER_COLOR,
  fmtCompact, fmtUsd, fmtSigned, fmtSignedPct, fmtDay, fmtDayYear, fmtRelative, initials, countryName, greetingFor,
} from "./_theme";
import { Sparkline, AreaLineChart, CumulativeBars, Donut, IndexedLines, IndiaMap } from "./_charts";
import { Card, Chip, ViewAll, CardActions, ExpandBtn, ExpandModal, Menu, MenuItem, Trend, Avatar, Empty, Skeleton, StateMessage, Drawer, type DrawerSpec, type ExpandSpec } from "./_widgets";
import "./overview.css";

// ⚠️ The overview is its OWN plane. This rail used to carry nine cross-links into
// the classic portal (Channels, Content, Accounts, Employees, Clients, Projects,
// Reports, Link Search, Settings), which is exactly what made it read as a second
// sidebar rather than a separate dashboard. One entry now, plus one explicit way
// back. Do not re-add portal sections here.
const NAV: Array<{ label: string; href: string; icon: string }> = [
  { label: "Overview", href: "/overview", icon: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
];

// Rendered below the nav with a divider so it reads as an exit, not a peer section.
const BACK_TO_PORTAL = { label: "Back to portal", href: "/dashboard", icon: "M19 12H5M12 19l-7-7 7-7" };

const ICONS = {
  followers: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0",
  views: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  reach: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6",
  revenue: "M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5S7 4.6 7 6.5 9.2 10 12 10s5 1.6 5 3.5S14.8 17 12 17s-5-1.6-5-3.5",
  engagements: "M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z",
};

// How many channel results the dropdown renders at once ("a" matches 255 of 419).
const SEARCH_LIMIT = 40;
const PERIODS: OverviewPeriod[] = [7, 14, 30, 90];
// ⚠️ PRECEDENCE: 0 = "follow the global period", and it is every card's default. A
// card's own period overrides the global FOR THAT CARD ONLY; the chip shows a gold dot
// while a card is detached, and "Follow global period" re-attaches it.
const WIDGET_PERIODS: WidgetPeriod[] = [0, 7, 14, 30, 90];
const CARD_PERIODS: WidgetPeriod[] = [7, 14, 30, 90];
// How many rows a card shows before you expand it. The payload carries more.
const CARD_ROWS = 5;
/** Mirrors MAX_RANGE_DAYS in overview.service.ts — the page draws one point per day. */
const MAX_RANGE_DAYS = 366;
const RANGE_KEY = "ov-range";
const ACTIVITY_COLOR: Record<string, string> = { post: T.blue, report: T.teal, user: T.purple, leave: T.gold, announcement: T.pink };
const PLATFORM_TILE: Record<string, string> = {
  facebook: "linear-gradient(135deg,#1877F2,#0B45BB)",
  instagram: "linear-gradient(135deg,#F0803C,#EC42B7)",
};

type Pop = "search" | "date" | "notif" | "profile" | "aud" | "rev" | "vbc" | "trac" | null;

function readStored<T>(key: string, allowed: readonly T[], dflt: T): T {
  try {
    const v = Number(localStorage.getItem(key));
    return (allowed as readonly unknown[]).includes(v) ? (v as T) : dflt;
  } catch {
    return dflt;
  }
}

function metaUrl(c: ChannelDirectoryRow): string | null {
  if (c.platform === "instagram") return c.username ? `https://www.instagram.com/${encodeURIComponent(c.username)}/` : null;
  return /^\d+$/.test(c.metaId) ? `https://www.facebook.com/${c.metaId}` : null;
}

/**
 * A card's period control. Renders ONE element so it can sit in `Card`'s `right` slot
 * without becoming a third flex child of `.ov-card-h` (that hard-clips the title).
 * The label comes from `effective`, which the SERVER echoed — never from local state,
 * so a card can never show one period's numbers under another period's label.
 */
function CardPeriod({
  id, pop, setPop, value, effective, globalDays, onPick,
}: {
  id: Pop; pop: Pop; setPop: (p: Pop) => void;
  value: WidgetPeriod; effective: number; globalDays: number; onPick: (d: WidgetPeriod) => void;
}) {
  const detached = value !== 0;
  return (
    <div className="ov-rel" onClick={(e) => e.stopPropagation()}>
      <Chip onClick={() => setPop(pop === id ? null : id)} ariaHasPopup active={pop === id}>
        {detached && <i className="ov-local-dot" aria-hidden="true" />}
        {/* ⚠️ Two spellings, one shown at a time by CSS — the same trick `.ov-viewall-t`
            already uses for "View All". Adding an expand button beside this chip clipped
            "Content Traction" by 17.2px at 1280px (measured): it sits in the narrow
            24fr ops-row track and "Last 14 Days" is the widest chip label on the page.
            The abbreviation buys back ~44px, which covers it with room to spare. */}
        <span className="ov-chip-full">Last {effective} Days</span>
        <span className="ov-chip-abbr" aria-hidden="true">{effective}d</span>
      </Chip>
      {pop === id && (
        <Menu width={200}>
          <div className="ov-menu-group">This card</div>
          <MenuItem active={!detached} onClick={() => { onPick(0); setPop(null); }} meta={`${globalDays}d`}>
            Follow global period
          </MenuItem>
          {CARD_PERIODS.map((d) => (
            <MenuItem key={d} active={value === d} onClick={() => { onPick(d); setPop(null); }}>Last {d} days</MenuItem>
          ))}
          {detached && <div className="ov-menu-note">This card is detached — the date range above no longer moves it.</div>}
        </Menu>
      )}
    </div>
  );
}

export default function OverviewPage() {
  usePageTitle("Overview");
  const router = useRouter();
  const { user, logout } = useAuth();
  const [days, setDays] = useState<OverviewPeriod>(7);
  const [audDays, setAudDays] = useState<WidgetPeriod>(0);
  const [revDays, setRevDays] = useState<WidgetPeriod>(0);
  const [vbcDays, setVbcDays] = useState<WidgetPeriod>(0);
  const [tracDays, setTracDays] = useState<WidgetPeriod>(0);
  const [pop, setPop] = useState<Pop>(null);
  const [drawer, setDrawer] = useState<DrawerSpec | null>(null);
  const [expand, setExpand] = useState<ExpandSpec | null>(null);
  // True when this drawer was opened FROM an expanded table, so it must render above the
  // modal and hand the reader back to that table when it closes.
  const [drawerStacked, setDrawerStacked] = useState(false);
  /** An explicit window that overrides the presets. null = a preset is driving the page. */
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [selCat, setSelCat] = useState<number | null>(null);
  const [demoTab, setDemoTab] = useState<"Age" | "Gender" | "Location">("Age");
  const [q, setQ] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const searchListRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setDays(readStored("ov-days", PERIODS, 7));
    setAudDays(readStored("ov-aud", WIDGET_PERIODS, 0));
    setRevDays(readStored("ov-rev", WIDGET_PERIODS, 0));
    setVbcDays(readStored("ov-vbc", WIDGET_PERIODS, 0));
    setTracDays(readStored("ov-trac", WIDGET_PERIODS, 0));
    // ⚠️ try/catch: localStorage throws outright in private windows and when site data is
    // blocked, and a remembered filter must never be able to break the page.
    try {
      const raw = localStorage.getItem(RANGE_KEY);
      if (raw) {
        const v = JSON.parse(raw) as { start?: unknown; end?: unknown };
        if (typeof v.start === "string" && typeof v.end === "string" && v.start <= v.end) {
          setRange({ start: v.start, end: v.end });
          setDraftStart(v.start);
          setDraftEnd(v.end);
        }
      }
    } catch {
      /* ignore — a preset drives the page */
    }
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // ⚠️ Escape peels ONE layer at a time, innermost first. It used to null everything at
  // once, which was harmless while only one layer could ever be open — but now that a row
  // in an expanded table opens a drawer on top of it, collapsing both would throw the
  // reader out of the table they were working through instead of back into it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Innermost first, one per press. Re-subscribing when a layer changes is cheap and
      // keeps this readable — the alternative (nested state updaters) runs during the
      // render phase and is exactly the kind of thing that breaks quietly later.
      if (pop) return setPop(null);
      if (menuOpen) return setMenuOpen(false);
      if (drawer) return closeDrawer();
      if (expand) return setExpand(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pop, menuOpen, drawer, expand]);
  // Keyboard selection must follow the highlight — the list scrolls, focus stays in
  // the input, and a browser only auto-scrolls for a focused element, so nothing would
  // move the viewport on its own.
  useEffect(() => {
    const row = searchListRef.current?.children[searchIdx] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [searchIdx]);

  const remember = (key: string, v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* per-viewer convenience only */ } };

  // No role gate: every internal user sees this page (owner decision 2026-09-17).
  function rememberRange(r: { start: string; end: string } | null) {
    try {
      if (r) localStorage.setItem(RANGE_KEY, JSON.stringify(r));
      else localStorage.removeItem(RANGE_KEY);
    } catch {
      /* a preference must never break the page */
    }
  }
  const { data, error, isLoading, mutate } = useOverview(days, audDays, revDays, vbcDays, tracDays, range);
  const o: OverviewPayload | undefined = data?.data;
  // The newest day the estate has actually closed — the furthest a picker should reach.
  // Falls back to the clock's yesterday before the first payload arrives.
  const maxPickable =
    o?.period.dataThroughDay ??
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const rangeTooLong =
    !!draftStart && !!draftEnd && draftStart <= draftEnd &&
    Math.round((Date.parse(`${draftEnd}T00:00:00Z`) - Date.parse(`${draftStart}T00:00:00Z`)) / 86_400_000) + 1 > MAX_RANGE_DAYS;

  const firstName = (user?.name ?? "there").split(" ")[0];
  const roleLabel: string = (Array.isArray(user?.roles) && typeof user.roles[0] === "string" && user.roles[0]) || "Admin";
  /**
   * ⚠️ The notification bell links into ADMIN queues (/approvals, /employees/pending,
   * /reports). This page is deliberately open to every internal user, and 71 of the 74
   * active users hold only the Employee role — whose permissions are accounts, attendance,
   * employees(own) and tasks(own). For them every one of those destinations 403s, so the
   * bell was an affordance that could only disappoint. Mirrors the role-name test in
   * `require-admin-role.ts` rather than inventing a second rule.
   * ⚠️ This is a UI affordance only — never a security boundary. The endpoints gate
   * themselves; hiding a link that cannot work is a courtesy, not a control.
   */
  const canActOnQueues = (user?.roles ?? []).some((r) => {
    const n = String(r).toLowerCase();
    return n === "admin" || n === "super admin";
  });

  // ── derived widget data ──
  const kpis = useMemo(() => {
    if (!o) return [];
    const k = o.kpis;
    const periodNote = `vs. previous ${o.period.days} days`;
    return [
      {
        id: "followers", label: "Followers (now)", value: fmtCompact(k.followers.value), accent: T.teal, icon: ICONS.followers, spark: k.followers.spark,
        // ⚠️ Denominator is the follower stock of the channels the delta was MEASURED
        // over, not the whole estate. Dividing a 146-channel delta by the 419-channel
        // stock understated real growth by 45% on prod (0.393% shown vs 0.711% true).
        trend: k.followers.delta != null && k.followers.followersWithHistory != null && k.followers.followersWithHistory - k.followers.delta > 0
          ? (k.followers.delta / (k.followers.followersWithHistory - k.followers.delta)) * 100
          : null,
        reliable: o.channels.total === 0 || k.followers.channelsWithHistory / o.channels.total >= 0.95,
        note: k.followers.delta != null ? `${fmtSigned(k.followers.delta)} · ${k.followers.channelsWithHistory}/${o.channels.total} channels` : `across ${o.channels.total} channels`,
        rows: [
          { label: "Facebook Pages", value: String(o.channels.facebook) },
          { label: "Instagram accounts", value: String(o.channels.instagram) },
          { label: `Change · ${k.followers.deltaDays ?? o.period.days}d`, value: fmtSigned(k.followers.delta) },
          { label: "Channels with full-period history", value: `${k.followers.channelsWithHistory} of ${o.channels.total}` },
          { label: "Followers on those channels", value: fmtCompact(k.followers.followersWithHistory) },
          { label: "Growth % measured over", value: `${k.followers.channelsWithHistory} channels — not all ${o.channels.total}` },
        ],
        href: "/accounts/growth",
      },
      {
        id: "views", label: "Total Views", value: fmtCompact(k.views.value), accent: T.blue, icon: ICONS.views, spark: k.views.spark,
        trend: k.views.trend?.pct ?? null, reliable: k.views.trend?.reliable ?? true, note: periodNote,
        rows: [
          { label: "Previous period", value: fmtCompact(k.views.previous) },
          { label: "Channels reporting", value: `${k.views.contributing} of ${o.channels.total}` },
          { label: "Period", value: `${fmtDay(o.period.start)} – ${fmtDay(o.period.end)}` },
        ],
        href: "/accounts/growth",
      },
      {
        id: "reach", label: "Total Reach", value: fmtCompact(k.reach.value), accent: T.purple, icon: ICONS.reach, spark: [],
        trend: null, reliable: true,
        // ⚠️ Reach counts UNIQUE PEOPLE, so it cannot be summed across days — we can only
        // report Meta's own native windows, which are 7 and 28 days. For 14 and 90 there
        // is genuinely no figure in existence. The dash is correct, but a bare dash reads
        // as missing data, so it has to say whose limitation it is and what to do next.
        // ⚠️⚠️ AND IT IS A SUM ACROSS CHANNELS, so it must NOT claim to be a count of unique
        // accounts. Meta reports unique reach PER CHANNEL; adding 419 of those counts a
        // person once for every channel they saw. On prod that sums to 3,353,317,458 against
        // a 342,086,989 follower base — individual Pages report 240-394M each — so read as
        // "unique accounts" it is arithmetically impossible. Account Growth computes the very
        // same total and deliberately never displays it. The figure is useful as audience
        // touchpoints; it just has to say so.
        note: k.reach.window
          ? `per-channel reach, summed · Meta's ${k.reach.window === "week" ? "7" : "28"}-day window`
          : `Meta publishes no ${o.period.days}-day reach — pick 7 or 30 days`,
        rows: k.reach.window
          ? [
              { label: "What this is", value: `Each channel's unique reach over Meta's ${k.reach.window === "week" ? "7" : "28"}-day window, added together` },
              { label: "⚠️ Not de-duplicated", value: `Someone who saw two of our channels is counted twice, so this is above the true number of distinct people — it cannot be compared against the ${fmtCompact(k.followers.value)} follower base` },
              { label: "Channels reporting", value: `${k.reach.contributing} of ${o.channels.total}` },
              { label: "Why no trend", value: "Unique people cannot be compared across periods honestly" },
            ]
          : [
              { label: "Why the dash", value: `Meta only publishes a unique-people reach figure for its own 7-day and 28-day windows. No ${o.period.days}-day figure exists to show.` },
              { label: "Not a data gap", value: "Every other metric on this page is complete for this period" },
              { label: "Why we don't add it up", value: "Reach counts people, not events — summing days would double-count anyone who came back" },
              { label: "To see reach", value: "Switch the period to 7 or 30 days" },
            ],
        href: "/accounts/growth",
      },
      {
        id: "revenue", label: "Total Revenue", value: fmtUsd(k.revenue.value), accent: T.green, icon: ICONS.revenue, spark: k.revenue.spark,
        trend: k.revenue.trend?.pct ?? null, reliable: k.revenue.trend?.reliable ?? true, note: periodNote,
        // ⚠️ TWO DIFFERENT COUNTS, AND THE DIFFERENCE IS THE WHOLE POINT. `contributing`
        // counts Pages that REPORTED an earnings figure — including a genuine $0.00 — so on
        // prod it is 317 (every Facebook Page) at 7, 14, 30 AND 90 days. A number that never
        // moves with the period tells a reader nothing, yet it was the only one shown, under
        // the label "Pages reporting earnings", which reads as "317 pages earning". Account
        // Growth counts only earnings > 0 and says 57 over the same 14 days — that gap was
        // reported as a data discrepancy when both pages' revenue TOTALS were byte-identical.
        // Lead with the number the reader actually means, and name the zeros explicitly.
        rows: [
          { label: "Previous period", value: fmtUsd(k.revenue.previous) },
          { label: "Pages that earned", value: `${k.revenue.earning} of ${k.revenue.contributing} monetised Pages` },
          { label: "Reported exactly $0.00", value: String(Math.max(0, k.revenue.contributing - k.revenue.earning)) },
          { label: "Why the two differ", value: "A monetised Page that made nothing still reports a real $0.00, so it counts as reporting but not as earning" },
          { label: "Currency", value: "USD, as paid by Meta. Instagram publishes no earnings metric, so revenue is Facebook-only" },
        ],
        href: "/accounts/growth",
      },
      {
        id: "engagements", label: "Engagements", value: fmtCompact(k.engagements.value), accent: T.gold, icon: ICONS.engagements, spark: k.engagements.spark,
        trend: k.engagements.trend?.pct ?? null, reliable: k.engagements.trend?.reliable ?? true, note: periodNote,
        rows: [
          { label: "Previous period", value: fmtCompact(k.engagements.previous) },
          { label: "Channels reporting", value: `${k.engagements.contributing} of ${o.channels.total}` },
        ],
        href: "/accounts/growth",
      },
    ];
  }, [o]);

  const catSlices = useMemo(() => {
    const rows = o?.viewsByChannel ?? [];
    // A Page and an Instagram account often share a name; tag the platform only when they collide.
    const dupes = new Set(rows.map((r) => r.name).filter((n, i, arr) => arr.indexOf(n) !== i));
    return rows.map((v, i) => ({
      label: dupes.has(v.name) && v.platform ? `${v.name} · ${v.platform === "facebook" ? "FB" : "IG"}` : v.name,
      value: v.views, color: CATEGORICAL[i % CATEGORICAL.length], share: v.share, id: v.id,
    }));
  }, [o]);
  const demoSlices = useMemo(() => {
    if (!o) return [];
    // Five rows fit the card: fold the oldest age bands into "45+" and the
    // country tail into "Others" (the API already folded beyond its top six).
    const foldTail = (rows: Array<{ label: string; value: number }>, keep: number, label: string) => {
      if (rows.length <= keep + 1) return rows;
      const head = rows.slice(0, keep);
      const rest = rows.slice(keep).reduce((s, r) => s + r.value, 0);
      return rest > 0 ? [...head, { label, value: rest }] : head;
    };
    const src =
      demoTab === "Age" ? foldTail(o.demographics.age.map((a) => ({ label: a.bucket.replace("-", " – "), value: a.value })), 4, "45+")
      : demoTab === "Gender" ? o.demographics.gender.map((g) => ({ label: g.label, value: g.value }))
      : foldTail(o.demographics.country.filter((c) => c.bucket !== "Others").map((c) => ({ label: countryName(c.bucket), value: c.value })).concat(o.demographics.country.filter((c) => c.bucket === "Others").map((c) => ({ label: "Others", value: c.value }))), 4, "Others");
    const total = src.reduce((s, x) => s + x.value, 0);
    return src.map((x, i) => ({ ...x, color: CATEGORICAL[i % CATEGORICAL.length], pct: total > 0 ? (x.value / total) * 100 : 0 }));
  }, [o, demoTab]);
  const demoTotal = demoSlices.reduce((s, x) => s + x.value, 0);

  const traction = useMemo(() => {
    if (!o) return null;
    const keys = ["views", "engagements", "reactions", "shares"] as const;
    const series = keys.map((k, i) => {
      const raw = o.traction.series.map((p) => p[k]);
      const base = raw.find((v) => v != null && v > 0) ?? null;
      return { label: o.traction.tiles[i]?.label ?? k, color: SERIES4[i], values: raw.map((v) => (v == null || base == null ? null : (v / base) * 100)) };
    });
    return { series, dates: o.traction.series.map((p) => p.date) };
  }, [o]);

  // ⚠️ Searches o.allChannels — EVERY live channel. It used to union topChannels
  // with revenueByChannel, i.e. 8 of 419 on prod, so any channel outside those two
  // ranked lists (including the largest in the estate) answered "No results".
  // Channels only, by owner's instruction — no posts, no trending.
  const search = useMemo(() => {
    if (!o) return [];
    // A pasted "@handle" must match: the UI renders "@name" but usernames are stored bare.
    const term = q.trim().toLowerCase().replace(/^@+/, "");
    const rows = term
      ? o.allChannels.filter((c) => c.name.toLowerCase().includes(term) || (c.username ?? "").toLowerCase().includes(term))
      : o.allChannels;
    return rows.slice(0, SEARCH_LIMIT);
  }, [o, q]);
  const searchTotal = useMemo(() => {
    if (!o) return 0;
    const term = q.trim().toLowerCase().replace(/^@+/, "");
    if (!term) return o.allChannels.length;
    return o.allChannels.filter((c) => c.name.toLowerCase().includes(term) || (c.username ?? "").toLowerCase().includes(term)).length;
  }, [o, q]);

  // ── drawers ──
  /**
   * The single close path for the drawer, so the stacked flag can never outlive the panel
   * it describes. Closing a stacked drawer deliberately leaves `expand` alone — the reader
   * came from that table and goes back to it.
   */
  function closeDrawer() {
    setDrawer(null);
    setDrawerStacked(false);
  }
  /**
   * `fromExpand` is set when the drawer is opened by clicking a row inside an expanded
   * table, which is the only case that needs the raised z-index.
   */
  // Accepts a ranked row or a slim directory row — it reads no avatar either way.
  /**
   * `windowed` overrides the hero when the row came from a card with its OWN period.
   *
   * ⚠️ WHY IT EXISTS. Every figure on a ChannelDirectoryRow is computed over the GLOBAL
   * window, so clicking a row in a Views-by-Channel table detached to 90 days would open a
   * drawer showing that channel's 7-day views. Both figures are correctly labelled, so
   * nothing is false — but a row reading 3.0B opening a panel reading 641M invites exactly
   * one conclusion, that something is broken. Passing the card's own figure keeps the
   * drawer describing the number that was clicked.
   */
  function openChannel(c: ChannelDirectoryRow, fromExpand = false, windowed?: { days: number; views: number }) {
    setDrawerStacked(fromExpand);
    const url = metaUrl(c);
    setDrawer({
      kind: c.platform === "facebook" ? "Facebook Page" : "Instagram account", accent: T.gold, title: c.name,
      sub: c.username ? `@${c.username}` : undefined,
      hero: { label: `Views · last ${windowed?.days ?? o?.period.days ?? 7} days`, value: fmtCompact(windowed ? windowed.views : c.views), trend: c.followerDelta != null && c.followers ? <Trend pct={(c.followerDelta / Math.max(1, c.followers - c.followerDelta)) * 100} /> : undefined, note: c.followerDeltaDays ? `followers · ${c.followerDeltaDays}d` : undefined },
      rows: [
        { label: "Followers", value: fmtCompact(c.followers) },
        { label: `Revenue · last ${o?.period.days ?? 7} days`, value: fmtUsd(c.earningsCents) },
        { label: "Follower change", value: c.followerDeltaDays ? `${fmtSigned(c.followerDelta)} · ${c.followerDeltaDays}d` : "—" },
      ],
      href: url ? { label: "Open on Meta ↗", url, external: true } : { label: "Open in Account Growth", url: "/accounts/growth" },
    });
    setPop(null);
  }
  function openPost(p: OverviewPayload["latestPosts"][number], fromExpand = false) {
    setDrawerStacked(fromExpand);
    setDrawer({
      kind: p.mediaProductType === "REELS" ? "Reel" : "Post", accent: T.pink, title: p.title, sub: `${p.channel.name} · ${fmtRelative(p.postedAt, now)}`,
      hero: { label: "Views", value: fmtCompact(p.views), note: p.views == null ? "not measured yet — per-post insights are collected in rotation" : "cumulative since publish, as last measured" },
      rows: [
        { label: "Likes", value: fmtCompact(p.likes) },
        { label: "Comments", value: fmtCompact(p.comments) },
        { label: "Platform", value: p.channel.platform === "facebook" ? "Facebook" : "Instagram" },
        { label: "Published", value: new Date(p.postedAt).toLocaleString() },
      ],
      href: p.permalink ? { label: "Open post ↗", url: p.permalink, external: true } : undefined,
    });
    setPop(null);
  }
  function openTrending(t: OverviewPayload["trending"][number], fromExpand = false) {
    setDrawerStacked(fromExpand);
    setDrawer({
      kind: `Trending ${t.type.toLowerCase()}`, accent: T.teal, title: t.name, sub: `${t.count} tagged posts · last 7 days`,
      rows: [
        { label: "Previous 7 days", value: String(t.previousCount) },
        { label: "Change", value: t.previousCount > 0 ? fmtSignedPct(((t.count - t.previousCount) / t.previousCount) * 100) : "new this week" },
      ],
      href: { label: "Search these posts", url: "/reports/link-search" },
      // ⚠️ The change is an ABSOLUTE count difference between two harvest weeks, and
      // weekly harvest throughput itself swings (5,794 → 17,312 captions between two
      // measured weeks). So a quiet harvest week can render as a topic "declining" when
      // only our collection volume moved. Normalising to each week's share is the real
      // fix and is a deliberate follow-up; until then the caveat must be on screen rather
      // than implied by an arrow.
      note: "Counts are captions harvested from connected channels and tagged by Link Search — a wider set than the links our team submitted. The week-on-week change also moves with how much we harvested that week, so read it as a signal, not a precise trend.",
    });
  }
  /**
   * id → full channel record.
   *
   * ⚠️ REQUIRED for Views by Channel: `viewsByChannelAll` rows carry only
   * {id,name,platform,views,share} — NO `metaId` and NO `username` — and `metaUrl()`
   * needs a numeric metaId for Facebook or a username for Instagram, so a row cannot
   * build its own Meta link. The lookup cannot miss: `allChannels` and
   * `viewsByChannelAll` are both derived from the same server-side `assets` array keyed
   * on the same `a.id`, the first unfiltered and the second a filter of it — so it is a
   * structural guarantee, not an empirical one (and 419/419 resolve on prod today).
   */
  const channelById = useMemo(() => new Map((o?.allChannels ?? []).map((c) => [c.id, c])), [o]);

  // ── expanded views ──
  // ⚠️ Each spec states the exact window its rows were computed over, because a card
  // may be detached from the global period — an expanded table with no window stated
  // is exactly how a reader mistakes one period's numbers for another's.
  const plat = (p: "facebook" | "instagram" | null) => (p === "facebook" ? "FB" : p === "instagram" ? "IG" : "—");

  function openExpandTopChannels() {
    if (!o) return;
    const rows = [...o.allChannels].filter((c) => c.views != null).sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    setExpand({
      title: "Top Channels",
      subtitle: `Ranked by views · last ${o.period.days} closed days`,
      columns: ["#", "Channel", "Platform", "Followers", "Views", "Revenue"],
      align: ["left", "left", "left", "right", "right", "right"],
      rows: rows.map((c, i) => ({
        key: c.id,
        cells: [i + 1, c.name, plat(c.platform), fmtCompact(c.followers), fmtCompact(c.views), fmtUsd(c.earningsCents)],
        onClick: () => openChannel(c, true),
        label: `Open ${c.name}`,
      })),
      note: `${rows.length} of ${o.channels.total} channels reported views in this window.`,
    });
  }

  function openExpandRevenue() {
    if (!o) return;
    const rows = [...o.allChannels].filter((c) => (c.earningsCents ?? 0) > 0).sort((a, b) => (b.earningsCents ?? 0) - (a.earningsCents ?? 0));
    const total = rows.reduce((t, c) => t + (c.earningsCents ?? 0), 0);
    setExpand({
      title: "Revenue by Channel",
      subtitle: `Last ${o.period.days} closed days · USD, as paid by Meta`,
      columns: ["#", "Channel", "Platform", "Revenue", "Share"],
      align: ["left", "left", "left", "right", "right"],
      rows: rows.map((c, i) => ({
        key: c.id,
        cells: [i + 1, c.name, plat(c.platform), fmtUsd(c.earningsCents), total > 0 ? `${(((c.earningsCents ?? 0) / total) * 100).toFixed(1)}%` : "—"],
        onClick: () => openChannel(c, true),
        label: `Open ${c.name}`,
      })),
      note: `${rows.length} channels earned in this window — revenue is Facebook-only, so Instagram accounts never appear here.`,
    });
  }

  function openExpandCities() {
    if (!o) return;
    setExpand({
      title: "India’s Audience Map",
      subtitle: `Instagram follower audience · ${o.cities.assets} accounts · ${o.cities.indiaShare.toFixed(0)}% of the mapped audience is in India`,
      lead: o.cities.items.length ? <div className="ov-map ov-map-lg"><IndiaMap cities={o.cities.items} /></div> : undefined,
      columns: ["#", "City", "State", "Share", "Followers"],
      align: ["left", "left", "left", "right", "right"],
      // Keyed on name+state, not name: two states can carry the same city name and a
      // duplicate React key silently drops a row.
      rows: o.cities.items.map((c, i) => ({
        key: `${c.name}|${c.state ?? ""}`,
        cells: [i + 1, c.name, c.state ?? "—", `${c.share.toFixed(1)}%`, fmtCompact(c.value)],
      })),
      note: "Cities Meta publishes for the connected Instagram accounts. Facebook publishes no equivalent city breakdown, so Pages are not represented.",
    });
  }

  function openExpandPosts() {
    if (!o) return;
    setExpand({
      title: "Latest Posts",
      subtitle: "Newest first, by the post’s own publish time. Counts are as last measured by Meta, not live.",
      columns: ["Posted", "Post", "Channel", "Platform", "Views", "Likes", "Comments"],
      align: ["left", "left", "left", "left", "right", "right", "right"],
      // ⚠️ Opens the POST, not its channel. `latestPosts[].channel` carries no id, and 63
      // of the 419 live channel names are shared by two or more channels (15 of the 24
      // posts in this list have an ambiguous channel name), so a name-based lookup could
      // confidently open the WRONG Page. The post drawer is the unambiguous target.
      rows: o.latestPosts.map((pp) => ({
        key: pp.id,
        cells: [fmtRelative(pp.postedAt, now), pp.title, pp.channel.name, plat(pp.channel.platform),
                fmtCompact(pp.views), fmtCompact(pp.likes), fmtCompact(pp.comments)],
        onClick: () => openPost(pp, true),
        label: `Open post: ${pp.title}`,
      })),
      note: "A dash means Meta has not published that count for the post yet — it is not a zero.",
    });
  }

  function openExpandTrending() {
    if (!o) return;
    setExpand({
      title: "What’s Trending",
      subtitle: "Entities tagged in captions harvested this week, against the week before",
      columns: ["#", "Entity", "Type", "This week", "Last week", "Change"],
      align: ["left", "left", "left", "right", "right", "right"],
      rows: o.trending.map((t, i) => ({
        key: t.id,
        cells: [i + 1, t.name, t.type.toLowerCase(), t.count.toLocaleString("en-IN"), t.previousCount.toLocaleString("en-IN"),
                t.previousCount > 0 ? fmtSignedPct(((t.count - t.previousCount) / t.previousCount) * 100) : "new"],
        onClick: () => openTrending(t, true),
        label: `Open ${t.name}`,
      })),
      note: "Counts come from Link Search caption tagging, not from Meta.",
    });
  }

  // ── chart-enlarging expands ──
  /**
   * The owner's second ask: see the PICTURE bigger, not just the data (as India's Audience
   * Map already allows). These reuse `ExpandSpec.lead`, which the cities expand already
   * uses, so there is no new modal machinery — and each also carries the underlying table,
   * so one expand serves both "show me it larger" and "show me the numbers".
   *
   * ⚠️ `.ov-chart-lg` IS LOAD-BEARING, NOT COSMETIC. `.ov-chart` takes its height from
   * `flex:1` inside the flex-column card and `.ov-plot>svg` is absolutely positioned, so
   * dropped into the height-less `.ov-modal-lead` block a chart collapses to ZERO height
   * and renders completely invisible. The wrapper supplies the height, capped — the modal
   * is not scrollable and the lead is flex-shrink:0, so an over-tall lead would push the
   * table straight out of the modal.
   *
   * ⚠️ Every subtitle states the window from the period the SERVER echoed, never local
   * state, because any of these cards may be detached from the global period.
   */
  function openExpandAudience() {
    if (!o) return;
    const first = o.audience.series[0]?.followers ?? null;
    setExpand({
      title: "Audience Growth",
      subtitle: `Followers across the ${o.audience.channelsUsed} of ${o.channels.total} channels whose snapshot history covers all ${o.audience.days} days — not an estate total`,
      lead: (
        <div className="ov-chart-lg">
          <AreaLineChart id="ov-aud-fill-lg" color={T.teal} unitLabel="followers"
            points={o.audience.series.map((sp) => ({ date: sp.date, value: sp.followers }))} />
        </div>
      ),
      columns: ["Day", "Followers", "Change vs. day 1"],
      align: ["left", "right", "right"],
      rows: o.audience.series.map((sp) => ({
        key: sp.date,
        cells: [fmtDayYear(sp.date), fmtCompact(sp.followers), first != null ? fmtSigned(sp.followers - first) : "—"],
      })),
      note: `Forward-filled from API follower snapshots. Channels whose history starts mid-window are excluded so a joiner cannot fake a jump; contested channel rows are excluded because their history is shared by two Pages.`,
    });
  }

  function openExpandRevenueOverview() {
    if (!o) return;
    setExpand({
      title: "Revenue Overview",
      subtitle: `Cumulative earnings over the last ${o.revenue.days} closed days · USD, as paid by Meta`,
      lead: (
        <div className="ov-chart-lg">
          <CumulativeBars unitLabel="revenue" formatValue={(v) => fmtUsd(v)}
            points={o.revenue.series.map((sp) => ({ date: sp.date, cumulative: sp.cumulativeCents, daily: sp.cents }))} />
        </div>
      ),
      columns: ["Day", "Earned that day", "Cumulative"],
      align: ["left", "right", "right"],
      rows: o.revenue.series.map((sp) => ({
        key: sp.date,
        cells: [fmtDayYear(sp.date), sp.cents == null ? "—" : fmtUsd(sp.cents), fmtUsd(sp.cumulativeCents)],
      })),
      note: "A dash means no Page has published that day's earnings yet — Meta lags a freshly closed day, and it is not a $0.00. Facebook only: Instagram publishes no earnings metric.",
    });
  }

  function openExpandTraction() {
    if (!o || !traction) return;
    setExpand({
      title: "Content Traction",
      subtitle: `Views, engagements, reactions and shares over the last ${o.traction.days} closed days, each indexed to its first day = 100`,
      lead: (
        <div className="ov-chart-lg">
          <IndexedLines series={traction.series} dates={traction.dates} />
        </div>
      ),
      columns: ["Day", "Views", "Engagements", "Reactions", "Shares · IG"],
      align: ["left", "right", "right", "right", "right"],
      rows: o.traction.series.map((sp) => ({
        key: sp.date,
        cells: [fmtDayYear(sp.date), fmtCompact(sp.views), fmtCompact(sp.engagements), fmtCompact(sp.reactions), fmtCompact(sp.shares)],
      })),
      note: "Indexing to day 1 = 100 is what lets four very different scales share one axis; the table carries the raw figures. Shares are Instagram-only — Facebook publishes no page-level share count, so a dash there is absence, not zero.",
    });
  }

  function openExpandViewsChart() {
    if (!o) return;
    setExpand({
      title: "Views by Channel",
      subtitle: `Share of views across the last ${o.viewsByChannelDays} closed days · ${fmtCompact(o.viewsByChannelTotal)} views total`,
      lead: catSlices.length ? (
        <div className="ov-donut-lg">
          <Donut slices={catSlices} size={210} thickness={28}
            center={fmtCompact(o.viewsByChannelTotal)} centerLabel="Total Views"
            ariaLabel="Donut chart of views by channel" />
          <ul className="ov-legend-list">
            {catSlices.map((c) => (
              <li key={c.label}><span className="ov-legend-static"><i style={{ background: c.color }} /><span>{c.label}</span><b>{c.share.toFixed(1)}%</b></span></li>
            ))}
          </ul>
        </div>
      ) : undefined,
      columns: ["#", "Channel", "Platform", "Views", "Share"],
      align: ["left", "left", "left", "right", "right"],
      rows: o.viewsByChannelAll.map((c, i) => {
        const full = channelById.get(c.id);
        return {
          key: c.id,
          cells: [i + 1, c.name, plat(c.platform), fmtCompact(c.views), `${c.share.toFixed(1)}%`],
          onClick: full ? () => openChannel(full, true, { days: o.viewsByChannelDays, views: c.views }) : undefined,
          label: full ? `Open ${c.name}` : undefined,
        };
      }),
      note: `The donut folds the tail into "Others"; the table below lists every one of the ${o.viewsByChannelAll.length} channels that reported views in this window.`,
    });
  }

  function openExpandDemographicsChart() {
    if (!o) return;
    setExpand({
      title: `Audience Demographics · ${demoTab}`,
      subtitle: `Instagram follower audience across ${o.demographics.assets} accounts · ${fmtCompact(demoTotal)} followers in the mapped set`,
      lead: demoSlices.length ? (
        <div className="ov-donut-lg">
          <Donut slices={demoSlices.map((d) => ({ ...d, share: d.pct }))} size={210} thickness={28}
            center={fmtCompact(demoTotal)} centerLabel="IG audience"
            ariaLabel={`Audience by ${demoTab.toLowerCase()}`} />
          <ul className="ov-legend-list">
            {demoSlices.map((d) => (
              <li key={d.label}><span className="ov-legend-static"><i style={{ background: d.color }} /><span>{d.label}</span><b>{d.pct.toFixed(1)}%</b></span></li>
            ))}
          </ul>
        </div>
      ) : undefined,
      columns: ["#", demoTab === "Location" ? "Country" : demoTab, "Share", "Followers"],
      align: ["left", "left", "right", "right"],
      rows: (demoTab === "Age" ? o.demographics.age.map((a) => ({ label: a.bucket.replace("-", " – "), value: a.value }))
        : demoTab === "Gender" ? o.demographics.gender.map((g) => ({ label: g.label, value: g.value }))
        : o.demographics.country.map((c) => ({ label: countryName(c.bucket), value: c.value }))
      ).map((x, i, arr) => {
        const tot = arr.reduce((t, y) => t + y.value, 0);
        return { key: `${x.label}|${i}`, cells: [i + 1, x.label, tot > 0 ? `${((x.value / tot) * 100).toFixed(1)}%` : "—", fmtCompact(x.value)] };
      }),
      note: "Instagram only — Facebook retired its whole fan-demographic family, so Pages contribute nothing here. The donut folds the tail; the table is every bucket Meta published.",
    });
  }

  function openKpi(k: (typeof kpis)[number]) {
    setDrawerStacked(false);
    setDrawer({
      kind: "KPI detail", accent: k.accent, title: k.label, sub: `Period · last ${o?.period.days ?? days} closed days`,
      hero: { label: k.label, value: k.value, trend: <Trend pct={k.trend} reliable={k.reliable} />, note: k.note },
      rows: [...k.rows, { label: "Data through", value: o?.period.dataThroughDay ? fmtDayYear(o.period.dataThroughDay) : "—" }],
      href: { label: "Open Account Growth", url: k.href },
    });
  }

  const empty = o && o.channels.total === 0;
  const pendingCount = o?.pending ? o.pending.approvals + o.pending.employees : 0;

  return (
    <div className={`ov-root ${menuOpen ? "is-menu" : ""}`} onClick={() => pop && setPop(null)}>
      {/* Sidebar */}
      <aside className="ov-side" aria-label="Primary navigation">
        <div className="ov-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Digital Sukoon" className="ov-logo" />
        </div>
        <nav className="ov-nav" aria-label="Sections">
          {NAV.map((n) => {
            const on = n.href === "/overview";
            return (
              <a key={n.href} href={n.href} className={`ov-nav-item ${on ? "is-current" : ""}`} aria-current={on ? "page" : undefined}>
                <span className="ov-nav-edge" />
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={n.icon} /></svg>
                <span className="ov-nav-label">{n.label}</span>
              </a>
            );
          })}
          <span className="ov-nav-sep" aria-hidden="true" />
          <a href={BACK_TO_PORTAL.href} className="ov-nav-item ov-nav-back" title="Return to the classic portal">
            <span className="ov-nav-edge" />
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={BACK_TO_PORTAL.icon} /></svg>
            <span className="ov-nav-label">{BACK_TO_PORTAL.label}</span>
          </a>
        </nav>
        <div className="ov-landscape" aria-hidden="true">
          <svg viewBox="0 0 195 250" preserveAspectRatio="xMidYMax slice">
            <defs>
              <linearGradient id="ov-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#050A10" /><stop offset=".55" stopColor="#0A1622" /><stop offset="1" stopColor="#0E1C2A" /></linearGradient>
              <linearGradient id="ov-road" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#E9BD62" stopOpacity="0" /><stop offset=".5" stopColor="#E9BD62" stopOpacity=".55" /><stop offset="1" stopColor="#F4D58C" stopOpacity=".9" /></linearGradient>
              <filter id="ov-soft"><feGaussianBlur stdDeviation="2.5" /></filter>
            </defs>
            <rect width="195" height="250" fill="url(#ov-sky)" />
            <path d="M0 150 C 40 130, 70 175, 110 150 S 170 120, 195 140 V250 H0Z" fill="#0B1826" />
            <path d="M0 185 C 50 165, 90 205, 140 185 S 180 170, 195 178 V250 H0Z" fill="#08121D" />
            <path d="M98 250 C 96 215, 120 200, 128 185 S 122 160, 106 150 S 92 130, 96 116" fill="none" stroke="url(#ov-road)" strokeWidth="6" strokeLinecap="round" filter="url(#ov-soft)" />
            <path d="M98 250 C 96 215, 120 200, 128 185 S 122 160, 106 150 S 92 130, 96 116" fill="none" stroke="#F4D58C" strokeWidth="1.2" strokeDasharray="3 5" strokeLinecap="round" opacity=".9" />
            {[[30, 40], [60, 25], [150, 35], [170, 60], [120, 50], [20, 80], [180, 95], [80, 70]].map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1 : 0.6} fill="#E6EAF0" opacity={0.5 + (i % 4) * 0.12} />
            ))}
          </svg>
          <div className="ov-landscape-fade" />
          <div className="ov-landscape-copy">A brighter<br />tomorrow<br />for creators</div>
          <div className="ov-landscape-rule" />
        </div>
      </aside>

      {/* Main */}
      <main className="ov-main">
        <header className="ov-top" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="ov-burger" aria-label="Toggle navigation" onClick={() => setMenuOpen((v) => !v)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <div className="ov-search-wrap">
            <div className="ov-search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.sub} strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setSearchIdx(0); setPop("search"); }}
                onFocus={() => { setSearchIdx(0); setPop("search"); }}
                onKeyDown={(e) => {
                  if (!search.length) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setSearchIdx((i) => (i + 1) % search.length); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSearchIdx((i) => (i - 1 + search.length) % search.length); }
                  else if (e.key === "Enter") { e.preventDefault(); const c = search[Math.min(searchIdx, search.length - 1)]; if (c) { openChannel(c); setQ(""); } }
                }}
                placeholder="Search channels…"
                aria-label="Search channels"
                aria-autocomplete="list"
                aria-expanded={pop === "search"}
                role="combobox"
                aria-controls="ov-search-results"
              />
            </div>
            {pop === "search" && (
              <div id="ov-search-results" role="listbox" aria-label="Channels" className="ov-menu ov-search-menu">
                {!o && <div className="ov-noresults">Loading channels…</div>}
                {o && search.length > 0 && (
                  <>
                    <div className="ov-menu-group">{q.trim() ? `${searchTotal} channel${searchTotal === 1 ? "" : "s"}` : `All ${searchTotal} channels`}</div>
                    <div className="ov-search-list" ref={searchListRef}>
                      {/* key on id, not name — 137 of 419 channels share a name with another */}
                      {search.map((c, i) => (
                        <MenuItem
                          key={c.id}
                          active={i === searchIdx}
                          onClick={() => { openChannel(c); setQ(""); }}
                          meta={`${fmtCompact(c.followers)} followers`}
                        >
                          {c.name}{c.username ? ` · @${c.username}` : ""}
                        </MenuItem>
                      ))}
                    </div>
                    {searchTotal > search.length && (
                      <div className="ov-menu-note">Showing the first {search.length} of {searchTotal} — keep typing to narrow.</div>
                    )}
                  </>
                )}
                {o && search.length === 0 && (
                  <div className="ov-noresults">No channel matches “{q}”.<br /><span>Search by channel name or @handle.</span></div>
                )}
              </div>
            )}
          </div>

          <div className="ov-top-right">
            <div className="ov-rel">
              <Chip onClick={() => setPop(pop === "date" ? null : "date")} ariaHasPopup active={pop === "date"}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.sub} strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
                {/* Always the window the SERVER echoed — never local state, so the label
                    can never move before the numbers under it do. */}
                <span className="ov-date-label">{o ? `${fmtDayYear(o.period.start)} – ${fmtDayYear(o.period.end)}` : `Last ${days} days`}</span>
                {o?.period.custom && <i className="ov-local-dot" aria-hidden="true" title="Custom range" />}
              </Chip>
              {pop === "date" && (
                <Menu width={278}>
                  <div className="ov-menu-group">Global period · KPI strip &amp; tables</div>
                  {PERIODS.map((d) => (
                    <MenuItem key={d} active={!range && d === days} onClick={() => { setRange(null); rememberRange(null); setDays(d); remember("ov-days", d); setPop(null); }} meta={`${d} closed days`}>Last {d} days</MenuItem>
                  ))}
                  <div className="ov-menu-group">Custom range</div>
                  {/* ⚠️ `max` is the last day the estate has CLOSED, not today. Picking a day
                      Meta has not published does not give fresher data, it silently averages
                      in a partial day — the defect measured on Account Growth's own range
                      picker. The server clamps regardless; this just stops the mistake. */}
                  <div className="ov-daterange">
                    <label>
                      <span>From</span>
                      <input type="date" value={draftStart} max={maxPickable} onChange={(e) => setDraftStart(e.target.value)} />
                    </label>
                    <label>
                      <span>To</span>
                      <input type="date" value={draftEnd} max={maxPickable} onChange={(e) => setDraftEnd(e.target.value)} />
                    </label>
                    <button
                      type="button"
                      className="ov-cta ov-cta-block"
                      disabled={!draftStart || !draftEnd || draftStart > draftEnd || rangeTooLong}
                      onClick={() => { const r = { start: draftStart, end: draftEnd }; setRange(r); rememberRange(r); setPop(null); }}
                    >
                      Apply range
                    </button>
                    {rangeTooLong && <div className="ov-menu-note">Ranges are capped at {MAX_RANGE_DAYS} days — the page draws one point per day.</div>}
                    {range && (
                      <button type="button" className="ov-reset" onClick={() => { setRange(null); rememberRange(null); setPop(null); }}>
                        Clear range · back to presets
                      </button>
                    )}
                  </div>
                  <div className="ov-menu-note">Cards with their own period keep it unless reset.</div>
                </Menu>
              )}
            </div>
            <div className="ov-rel" hidden={!canActOnQueues}>
              <button type="button" className="ov-icon-btn" aria-label={`Notifications, ${pendingCount} pending`} onClick={() => setPop(pop === "notif" ? null : "notif")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3zM10 20a2 2 0 0 0 4 0" /></svg>
                {pendingCount > 0 && <span className="ov-badge" />}
              </button>
              {pop === "notif" && (
                <Menu width={280}>
                  <div className="ov-menu-row"><b>Needs attention</b><span>{o?.pending ? "live" : "unavailable"}</span></div>
                  {o?.pending ? (
                    <>
                      {/* ⚠️ "Pending approvals" is the SUM of documents + profile pictures +
                          leave (analytics.service.ts:109), and two of those three are listed
                          beneath it — so a single leave request used to be printed twice and
                          read as two separate things to do. The roll-up is deliberate (it
                          matches the /approvals page total), so the fix is to present it AS a
                          roll-up with its components indented under it, not to change the
                          arithmetic. Profile-picture requests are the third component and had
                          no row at all; it is derived here so the three visibly sum to the total. */}
                      <MenuItem onClick={() => router.push("/approvals")} meta={String(o.pending.approvals)}>Approvals queue · total</MenuItem>
                      <div className="ov-menu-sub">
                        <MenuItem onClick={() => router.push("/approvals")} meta={String(o.pending.leave)}>↳ Leave requests</MenuItem>
                        <MenuItem onClick={() => router.push("/approvals")} meta={String(o.pending.documents)}>↳ Documents to verify</MenuItem>
                        <MenuItem onClick={() => router.push("/approvals")} meta={String(Math.max(0, o.pending.approvals - o.pending.leave - o.pending.documents))}>↳ Profile pictures</MenuItem>
                      </div>
                      <MenuItem onClick={() => router.push("/employees/pending")} meta={String(o.pending.employees)}>New joiners to review</MenuItem>
                      <MenuItem onClick={() => router.push("/reports")} meta={`${fmtCompact(o.pending.linksToday)} links`}>Submitted today · {o.pending.submittedToday} employees</MenuItem>
                    </>
                  ) : (
                    <div className="ov-menu-note">Approval counts could not be loaded.</div>
                  )}
                </Menu>
              )}
            </div>
            <div className="ov-rel">
              <button type="button" className="ov-profile" aria-haspopup="menu" onClick={() => setPop(pop === "profile" ? null : "profile")}>
                <span className="ov-profile-av">{initials(user?.name)}</span>
                <span className="ov-profile-t"><span>{user?.name ?? "Admin"}</span><span>{roleLabel}</span></span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.sub} strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {pop === "profile" && (
                <Menu width={200}>
                  <MenuItem onClick={() => router.push("/settings")}>Profile &amp; settings</MenuItem>
                  <MenuItem onClick={() => router.push("/dashboard")}>Classic dashboard</MenuItem>
                  <MenuItem onClick={() => mutate()}>Refresh data</MenuItem>
                  <MenuItem onClick={logout} danger>Sign out</MenuItem>
                </Menu>
              )}
            </div>
          </div>
        </header>

        <div className="ov-greet">
          <div>
            <h1>{greetingFor(new Date(now).getHours())}, {firstName}!</h1>
            <p>Here’s what’s happening across Digital Sukoon today.</p>
          </div>
          <div className="ov-script">Real Creators.<br />Real Impact.</div>
        </div>

        {!o && isLoading && <Skeleton />}
        {!o && error && (
          <StateMessage tone="error" title="Couldn’t load the overview" body={String((error as Error).message ?? "The analytics service returned an error.")} cta="Retry" onCta={() => mutate()} />
        )}
        {o && empty && (
          <StateMessage tone="empty" title="No connected channels yet" body="Connect a Meta account in Account Growth and the overview fills itself from real channel data." cta="Open Account Growth" onCta={() => router.push("/accounts/growth")} />
        )}

        {o && !empty && (
          <div className="ov-grid" style={{ opacity: isLoading ? 0.75 : 1 }}>
            {/* KPI strip */}
            <section className="ov-row ov-row-kpi" aria-label="Key metrics">
              {kpis.map((k) => (
                <button key={k.id} type="button" className="ov-kpi" onClick={() => openKpi(k)}>
                  <span className="ov-kpi-tile" style={{ background: `${k.accent}22`, color: k.accent, boxShadow: `0 0 16px ${k.accent}33` }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={k.icon} /></svg>
                  </span>
                  <span className="ov-kpi-body">
                    <span className="ov-kpi-l">{k.label}</span>
                    <span className="ov-kpi-v">{k.value}</span>
                    <span className="ov-kpi-t"><Trend pct={k.trend} reliable={k.reliable} /></span>
                    <span className="ov-kpi-n">{k.note}</span>
                  </span>
                  {k.spark.length > 1 && <Sparkline values={k.spark} color={k.accent} id={`spark-${k.id}`} />}
                </button>
              ))}
            </section>

            {/* Analytics row */}
            <section className="ov-row ov-row-analytics" aria-label="Analytics">
              <Card
                title="Audience Growth"
                right={
                  /* ⚠️ CardActions, not a bare pair: `.ov-card-h` is a space-between flex
                     whose h2 is the only shrinkable item, so two loose children would be
                     paid for out of the title's width. */
                  <CardActions>
                    <ExpandBtn label="Expand Audience Growth" onClick={openExpandAudience} />
                    <CardPeriod id="aud" pop={pop} setPop={setPop} value={audDays} effective={o.audience.days} globalDays={o.period.days}
                      onPick={(d) => { setAudDays(d); remember("ov-aud", d); }} />
                  </CardActions>
                }
              >
                <div className="ov-headline">
                  {/* ⚠️ This is the follower sum of the channels with history reaching
                      back across the SELECTED window, so it legitimately falls as the
                      window widens (148 channels at 7d, 43 at 90d on prod). It is not an
                      estate total — the tooltip and the coverage sentence both say so. */}
                  <span
                    className="ov-big"
                    title={`Followers of the ${o.audience.channelsUsed} channels whose history covers all ${o.audience.days} days — not the whole estate of ${o.channels.total}. Widening the period narrows this set, so the figure can fall.`}
                  >
                    {fmtCompact(o.audience.series[o.audience.series.length - 1]?.followers ?? null)}
                    {o.channels.total > 0 && o.audience.channelsUsed / o.channels.total < 0.9 && <sup className="ov-partial">*</sup>}
                  </span>
                  <span className="ov-headline-side">
                    <Trend pct={o.audience.delta != null && o.audience.series[0]?.followers ? (o.audience.delta / o.audience.series[0].followers) * 100 : null} />
                    {/* ⚠️ This headline is the follower sum of ONLY the channels with history
                        reaching back across the selected window — 148 channels at 7d but 43 at
                        30d on prod, so the number legitimately drops 61% when you widen the
                        period. It must never read as an estate-wide total, hence the coverage
                        sits in the same sentence rather than in small grey type beside it. */}
                    <span>
                      {o.audience.delta != null ? `${fmtSigned(o.audience.delta)} followers · ` : ""}
                      across {o.audience.channelsUsed} of {o.channels.total} channels with {o.audience.days}-day history
                    </span>
                  </span>
                  {audDays !== 0 && <button type="button" className="ov-reset" onClick={() => { setAudDays(0); remember("ov-aud", 0); }}>Local period · Reset</button>}
                </div>
                <AreaLineChart id="ov-aud-fill" color={T.teal} unitLabel="followers" points={o.audience.series.map((s) => ({ date: s.date, value: s.followers }))} />
              </Card>

              <Card
                title="Revenue Overview"
                right={
                  <CardActions>
                    <ExpandBtn label="Expand Revenue Overview" onClick={openExpandRevenueOverview} />
                    <CardPeriod id="rev" pop={pop} setPop={setPop} value={revDays} effective={o.revenue.days} globalDays={o.period.days}
                      onPick={(d) => { setRevDays(d); remember("ov-rev", d); }} />
                  </CardActions>
                }
              >
                <div className="ov-headline">
                  <span className="ov-big">{fmtUsd(o.revenue.totalCents)}</span>
                  <span className="ov-headline-side">
                    <Trend pct={o.revenue.trend?.pct ?? null} reliable={o.revenue.trend?.reliable ?? true} />
                    <span>vs. previous {o.revenue.days} days · USD</span>
                  </span>
                  {revDays !== 0 && <button type="button" className="ov-reset" onClick={() => { setRevDays(0); remember("ov-rev", 0); }}>Local period · Reset</button>}
                </div>
                <CumulativeBars unitLabel="revenue" formatValue={(v) => fmtUsd(v)} points={o.revenue.series.map((s) => ({ date: s.date, cumulative: s.cumulativeCents, daily: s.cents }))} />
              </Card>

              <Card title="Views by Channel" right={
                <CardActions>
                  <ExpandBtn label="Expand Views by Channel" onClick={openExpandViewsChart} />
                  <CardPeriod id="vbc" pop={pop} setPop={setPop} value={vbcDays} effective={o.viewsByChannelDays} globalDays={o.period.days}
                    onPick={(d) => { setVbcDays(d); remember("ov-vbc", d); setSelCat(null); }} />
                </CardActions>
              }>
                {catSlices.length ? (
                  <div className="ov-donut-row">
                    <Donut
                      slices={catSlices}
                      size={118}
                      thickness={16}
                      selected={selCat}
                      onSelect={setSelCat}
                      center={selCat != null && catSlices[selCat] ? `${catSlices[selCat].share.toFixed(0)}%` : fmtCompact(o.viewsByChannelTotal)}
                      centerLabel={selCat != null && catSlices[selCat] ? catSlices[selCat].label : "Total Views"}
                      ariaLabel="Donut chart of views by channel"
                    />
                    <ul className="ov-legend-list">
                      {catSlices.map((c, i) => (
                        <li key={c.label}>
                          <button type="button" className={selCat === i ? "is-active" : ""} onClick={() => setSelCat(selCat === i ? null : i)}>
                            <i style={{ background: c.color }} /><span>{c.label}</span><b>{c.share.toFixed(0)}%</b>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : <Empty>No channel views reported for this period.</Empty>}
              </Card>
            </section>

            {/* Operations row */}
            <section className="ov-row ov-row-ops" aria-label="Operations">
              <Card title="Top Channels" right={
                <CardActions><ExpandBtn label="Expand Top Channels" onClick={openExpandTopChannels} /><ViewAll href="/accounts/growth" /></CardActions>
              }>
                <div className="ov-table">
                  <div className="ov-th ov-cols-ch"><span>#</span><span>Channel</span><span className="ov-col-fol">Followers</span><span>Views</span><span>Revenue</span><span /></div>
                  {o.topChannels.length === 0 && <Empty>No channel has reported views for this period.</Empty>}
                  {o.topChannels.map((c, i) => (
                    <button key={c.id} type="button" className="ov-tr ov-cols-ch" onClick={() => openChannel(c)}>
                      <span className="ov-rank">{i + 1}</span>
                      <span className="ov-cell-name"><Avatar url={c.pictureUrl} name={c.name} size={18} tile={PLATFORM_TILE[c.platform]} /><span title={`${c.name}${c.username ? ` · @${c.username}` : ""}`}>{c.name}</span></span>
                      <span className="ov-col-fol">{fmtCompact(c.followers)}</span>
                      <span>{fmtCompact(c.views)}</span>
                      <span>{fmtUsd(c.earningsCents)}</span>
                      <span><Trend pct={c.followerDelta != null && c.followers ? (c.followerDelta / Math.max(1, c.followers - c.followerDelta)) * 100 : null} muted /></span>
                    </button>
                  ))}
                </div>
              </Card>

              <Card title="India’s Audience Map" right={
                <CardActions><ExpandBtn label="Expand India’s Audience Map" onClick={openExpandCities} /></CardActions>
              }>
                <div className="ov-map-row">
                  {o.cities.items.length ? <IndiaMap cities={o.cities.items} /> : <Empty>No city-level audience data yet.</Empty>}
                  <div className="ov-cities">
                    <div className="ov-cities-h">Top Cities</div>
                    {o.cities.items.slice(0, 5).map((c) => (
                      <div key={c.name} className="ov-city"><span>{c.name}</span><span>{c.share.toFixed(0)}%</span></div>
                    ))}
                    <div className="ov-map-legend">
                      {(["high", "growing", "emerging"] as const).map((t) => (
                        <span key={t}><i style={{ background: TIER_COLOR[t], boxShadow: `0 0 6px ${TIER_COLOR[t]}` }} />{t === "high" ? "High Activity" : t === "growing" ? "Growing" : "Emerging"}</span>
                      ))}
                    </div>
                    <div className="ov-map-note">IG followers · {o.cities.assets} accounts · {o.cities.indiaShare.toFixed(0)}% in India</div>
                  </div>
                </div>
              </Card>

              {/* ⚠️ Not "LIVE": these arrive on the ~3-hourly Meta sync, so the newest post
                  is routinely an hour or more old (103 min when measured on prod). "SYNCED"
                  is the honest word for a feed that is as fresh as its last fetch rather
                  than streaming. */}
              <Card
                title={<>Latest Posts <span className="ov-live-pill"><span />SYNCED</span></>}
                right={<CardActions><ExpandBtn label="Expand Latest Posts" onClick={openExpandPosts} /><ViewAll href="/accounts/growth" /></CardActions>}
              >
                <div className="ov-feed">
                  {o.latestPosts.length === 0 && <Empty>No posts synced yet.</Empty>}
                  {o.latestPosts.slice(0, CARD_ROWS).map((p) => {
                    const fresh = now - Date.parse(p.postedAt) < 60 * 60_000;
                    return (
                      <button key={p.id} type="button" className="ov-feed-row" onClick={() => openPost(p)}>
                        <span className="ov-thumb" style={{ background: PLATFORM_TILE[p.channel.platform] }}><span /></span>
                        <span className="ov-feed-body">
                          <span className="ov-feed-t">{p.title}</span>
                          <span className="ov-feed-m">
                            <span className="ov-plat" title={p.channel.platform === "facebook" ? "Facebook" : "Instagram"}>{p.channel.platform === "facebook" ? "FB" : "IG"}</span>
                            <span className="ov-feed-h">{p.channel.username ? `@${p.channel.username}` : p.channel.name}</span>
                            {fresh && <span className="ov-new">NEW</span>}
                            <span className="ov-metric"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={T.blue} strokeWidth="2.2" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>{fmtCompact(p.views)}</span>
                            <span className="ov-metric"><svg width="10" height="10" viewBox="0 0 24 24" fill={T.pink} aria-hidden="true"><path d="M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z" /></svg>{fmtCompact(p.likes)}</span>
                          </span>
                        </span>
                        <span className="ov-feed-when">{fmtRelative(p.postedAt, now)}</span>
                      </button>
                    );
                  })}
                </div>
              </Card>

              <Card title="Revenue by Channel" right={
                <CardActions><ExpandBtn label="Expand Revenue by Channel" onClick={openExpandRevenue} /><ViewAll href="/accounts/growth" /></CardActions>
              }>
                <div className="ov-table">
                  {/* The period lives on the column, not in the card header: a third
                      child there is the only shrinkable item's undoing (see .ov-card-h). */}
                  <div className="ov-th ov-cols-rev"><span /><span>Channel</span><span /><span style={{ textAlign: "right" }}>Revenue · {o.period.days}d</span></div>
                  {o.revenueByChannel.length === 0 && <Empty>No Page reported earnings for this period.</Empty>}
                  {o.revenueByChannel.map((c) => (
                    <button key={c.id} type="button" className="ov-tr ov-cols-rev ov-tr-grow" onClick={() => openChannel(c)}>
                      <Avatar url={c.pictureUrl} name={c.name} size={22} tile={PLATFORM_TILE[c.platform]} />
                      <span className="ov-strong ov-ellipsis" title={`${c.name}${c.username ? ` · @${c.username}` : ""}`}>{c.name}</span>
                      <span className="ov-plat" title={c.platform === "facebook" ? "Facebook Page" : "Instagram account"}>{c.platform === "facebook" ? "FB" : "IG"}</span>
                      <span className="ov-strong" style={{ textAlign: "right" }}>{fmtUsd(c.earningsCents)}</span>
                    </button>
                  ))}
                </div>
              </Card>
            </section>

            {/* Bottom row */}
            <section className="ov-row ov-row-bottom" aria-label="Activity and trends">
              <Card title={<>Real-time Activity <span className="ov-live"><span />Live</span></>}>
                <div className="ov-activity">
                  {o.activity.length === 0 && <Empty>Quiet for now.</Empty>}
                  {/* ⚠️ These rows now GO somewhere. The click used to only toggle the
                      text between one line and two, which is why the feed read as a dead
                      end — the payload carried no id or link at all, so there was nothing
                      to navigate to. `postId` opens the same post drawer Latest Posts
                      opens; `href` is an in-portal route. Dropping the toggle is not a
                      loss: the text now clamps to two lines by default (it was forced to
                      one) and the full string is on the title attribute.
                      ⚠️ An href is a navigation hint, NOT an authorisation claim — most of
                      this page's audience holds only the Employee role, so the destination
                      gates itself. */}
                  {o.activity.map((a, i) => {
                    const post = a.postId ? o.latestPosts.find((lp) => lp.id === a.postId) : undefined;
                    const go = post ? () => openPost(post) : a.href ? () => router.push(a.href!) : undefined;
                    return (
                      <button
                        key={`${a.kind}-${a.at}-${i}`}
                        type="button"
                        className="ov-act"
                        onClick={go}
                        disabled={!go}
                        aria-label={go ? `${a.text} — open` : undefined}
                      >
                        <span className="ov-act-dot" style={{ background: ACTIVITY_COLOR[a.kind], boxShadow: `0 0 6px ${ACTIVITY_COLOR[a.kind]}` }} />
                        <span className="ov-act-t" title={a.text}>{a.text}</span>
                        <span className="ov-act-when">{fmtRelative(a.at, now)}</span>
                      </button>
                    );
                  })}
                </div>
              </Card>

              <Card title="Content Traction" right={
                <CardActions>
                  <ExpandBtn label="Expand Content Traction" onClick={openExpandTraction} />
                  <CardPeriod id="trac" pop={pop} setPop={setPop} value={tracDays} effective={o.traction.days} globalDays={o.period.days}
                    onPick={(d) => { setTracDays(d); remember("ov-trac", d); }} />
                </CardActions>
              }>
                <div className="ov-trac-tiles">
                  {o.traction.tiles.map((t, i) => (
                    <div key={t.key} className={i ? "has-divider" : ""} title={t.key === "shares" ? "Instagram only — Facebook publishes no page-level share count" : undefined}>
                      <div className="ov-trac-v">{fmtCompact(t.value)}</div>
                      <div className="ov-trac-l" style={{ color: SERIES4[i] }}>{t.label}{t.key === "shares" ? " · IG" : ""}</div>
                      <div className="ov-trac-t"><Trend pct={t.pct} /></div>
                    </div>
                  ))}
                </div>
                {traction && <IndexedLines series={traction.series} dates={traction.dates} />}
              </Card>

              <Card title="Audience Demographics" right={
                <CardActions><ExpandBtn label="Expand Audience Demographics" onClick={openExpandDemographicsChart} /></CardActions>
              }>
                <div role="tablist" className="ov-tabs">
                  {(["Age", "Gender", "Location"] as const).map((t) => (
                    <button key={t} role="tab" type="button" aria-selected={demoTab === t} className={demoTab === t ? "is-sel" : ""} onClick={() => setDemoTab(t)}>{t}</button>
                  ))}
                </div>
                {demoSlices.length ? (
                  <div className="ov-donut-row ov-donut-row-sm">
                    <Donut slices={demoSlices} size={92} thickness={11} center={fmtCompact(demoTotal)} centerLabel="IG audience" ariaLabel={`Audience by ${demoTab.toLowerCase()}: ${demoSlices.map((s) => `${s.label} ${s.pct.toFixed(0)}%`).join(", ")}`} />
                    <ul className="ov-legend-list ov-legend-list-sm">
                      {demoSlices.map((s) => (
                        <li key={s.label}><span className="ov-legend-static"><i style={{ background: s.color }} /><span>{s.label}</span><b>{s.pct.toFixed(0)}%</b></span></li>
                      ))}
                    </ul>
                  </div>
                ) : <Empty>Instagram has not published demographics for these accounts.</Empty>}
              </Card>

              <Card title="What’s Trending" right={
                <CardActions><ExpandBtn label="Expand What’s Trending" onClick={openExpandTrending} /><ViewAll href="/reports/link-search" /></CardActions>
              }>
                {/* ⚠️ THE CARD FACE MUST SAY WHAT THIS ACTUALLY COUNTS. It reads
                    link_content — captions HARVESTED from the connected channel feeds —
                    which is a superset of what our employees submitted: of 400 sampled
                    captions harvested in the last 7 days, only 243 (61%) matched any
                    submitted link. The drawer and the expanded view both said "harvested"
                    already; a bare "N posts" on the card invited exactly the reading the
                    owner had, that this is our team's posting activity. It is the wider
                    market signal, which is useful — it just has to be labelled. */}
                <div className="ov-card-note">Harvested channel captions · 7d — wider than our team&rsquo;s own links.</div>
                <div className="ov-trending">
                  {o.trending.length === 0 && <Empty>No captions tagged this week yet.</Empty>}
                  {o.trending.slice(0, CARD_ROWS).map((t, i) => {
                    const up = t.count >= t.previousCount;
                    return (
                      <button key={t.id} type="button" className="ov-trend-row" onClick={() => openTrending(t)}>
                        <span className="ov-rank-sm">{i + 1}</span>
                        <span className="ov-trend-tile" style={{ background: `linear-gradient(135deg,${CATEGORICAL[i % CATEGORICAL.length]},${CATEGORICAL[(i + 3) % CATEGORICAL.length]})` }} />
                        <span className="ov-trend-name">{t.name}</span>
                        {/* NOT fmtCompact: with digits=0 every count in 1,000–1,999 collapsed
                            to "1K", flattening the very ranking this widget exists to show. */}
                        <span className="ov-trend-count">{t.count.toLocaleString("en-IN")} posts</span>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={up ? T.teal : T.red} strokeWidth="2.4" aria-hidden="true"><path d={up ? "M12 19V5M5 12l7-7 7 7" : "M12 5v14M5 12l7 7 7-7"} /></svg>
                      </button>
                    );
                  })}
                </div>
              </Card>
            </section>
          </div>
        )}

        {o && (
          <div className="ov-foot">
            Meta channel data complete through {o.period.dataThroughDay ? fmtDayYear(o.period.dataThroughDay) : "—"} · {o.channels.total} connected channels · page refreshed {fmtRelative(o.generatedAt, now)}
            {/* Disclose a clamp rather than silently showing a shorter window than asked for. */}
            {o.period.clampedTo && (
              <> · range shortened to {fmtDayYear(o.period.clampedTo)} — Meta has not published a complete day after that</>
            )}
          </div>
        )}

        {expand && <ExpandModal spec={expand} onClose={() => setExpand(null)} />}
        {drawer && <Drawer spec={drawer} stacked={drawerStacked} onClose={closeDrawer} />}
      </main>
    </div>
  );
}
