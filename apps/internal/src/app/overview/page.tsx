"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/landing";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useOverview } from "./_hooks";
import type { OverviewPayload, OverviewPeriod, WidgetPeriod, ChannelRow } from "./_types";
import {
  T, CATEGORICAL, SERIES4, TIER_COLOR,
  fmtCompact, fmtUsd, fmtSigned, fmtSignedPct, fmtDay, fmtDayYear, fmtRelative, initials, countryName, greetingFor,
} from "./_theme";
import { Sparkline, AreaLineChart, CumulativeBars, Donut, IndexedLines, IndiaMap } from "./_charts";
import { Card, Chip, ViewAll, Menu, MenuItem, Trend, Avatar, Empty, Skeleton, StateMessage, Drawer, type DrawerSpec } from "./_widgets";
import "./overview.css";

// ── navigation: the design's ten sections, each routed to the portal page that
// really owns that data (labels adjusted where the design's word would lie).
const NAV: Array<{ label: string; href: string; icon: string }> = [
  { label: "Overview", href: "/overview", icon: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { label: "Channels", href: "/accounts/growth", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21a7 7 0 0 1 14 0" },
  { label: "Content", href: "/content", icon: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 9h8M8 13h8M8 17h5" },
  { label: "Accounts", href: "/accounts", icon: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6" },
  { label: "Employees", href: "/employees", icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 15a4 4 0 0 1 8 0M12 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5" },
  { label: "Clients", href: "/clients", icon: "M8 5h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 5V3h6v2M9 12h6M9 16h4" },
  { label: "Projects", href: "/projects", icon: "M4 11v2a1 1 0 0 0 1 1h2l6 4V6L7 10H5a1 1 0 0 0-1 1zM17 9a4 4 0 0 1 0 6" },
  { label: "Reports", href: "/reports", icon: "M6 3h9l5 5v13H6zM15 3v5h5M9 17v-4M12 17v-7M15 17v-2" },
  { label: "Link Search", href: "/reports/link-search", icon: "M4 20V10M10 20V4M16 20v-8M22 20H2" },
  { label: "Settings", href: "/settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
];

const ICONS = {
  followers: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0",
  views: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  reach: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6",
  revenue: "M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5S7 4.6 7 6.5 9.2 10 12 10s5 1.6 5 3.5S14.8 17 12 17s-5-1.6-5-3.5",
  engagements: "M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z",
};

const PERIODS: OverviewPeriod[] = [7, 14, 30, 90];
const WIDGET_PERIODS: WidgetPeriod[] = [7, 30, 90];
const ACTIVITY_COLOR: Record<string, string> = { post: T.blue, report: T.teal, user: T.purple, leave: T.gold, announcement: T.pink };
const PLATFORM_TILE: Record<string, string> = {
  facebook: "linear-gradient(135deg,#1877F2,#0B45BB)",
  instagram: "linear-gradient(135deg,#F0803C,#EC42B7)",
};

type Pop = "search" | "date" | "notif" | "profile" | "aud" | "rev" | null;

function readStored<T>(key: string, allowed: readonly T[], dflt: T): T {
  try {
    const v = Number(localStorage.getItem(key));
    return (allowed as readonly unknown[]).includes(v) ? (v as T) : dflt;
  } catch {
    return dflt;
  }
}

function metaUrl(c: ChannelRow): string | null {
  if (c.platform === "instagram") return c.username ? `https://www.instagram.com/${encodeURIComponent(c.username)}/` : null;
  return /^\d+$/.test(c.metaId) ? `https://www.facebook.com/${c.metaId}` : null;
}

export default function OverviewPage() {
  usePageTitle("Overview");
  const router = useRouter();
  const { user, logout } = useAuth();
  const [days, setDays] = useState<OverviewPeriod>(7);
  const [audDays, setAudDays] = useState<WidgetPeriod>(30);
  const [revDays, setRevDays] = useState<WidgetPeriod>(30);
  const [pop, setPop] = useState<Pop>(null);
  const [drawer, setDrawer] = useState<DrawerSpec | null>(null);
  const [selCat, setSelCat] = useState<number | null>(null);
  const [demoTab, setDemoTab] = useState<"Age" | "Gender" | "Location">("Age");
  const [actOpen, setActOpen] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setDays(readStored("ov-days", PERIODS, 7));
    setAudDays(readStored("ov-aud", WIDGET_PERIODS, 30));
    setRevDays(readStored("ov-rev", WIDGET_PERIODS, 30));
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDrawer(null); setPop(null); setMenuOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const remember = (key: string, v: number) => { try { localStorage.setItem(key, String(v)); } catch { /* per-viewer convenience only */ } };

  // The API gates this payload on an Admin role; skip the request for anyone else
  // and show them where to go instead of a 403.
  const isAdmin = isAdminUser(user);
  const { data, error, isLoading, mutate } = useOverview(days, audDays, revDays, isAdmin);
  const o: OverviewPayload | undefined = data?.data;

  const firstName = (user?.name ?? "there").split(" ")[0];
  const roleLabel: string = (Array.isArray(user?.roles) && typeof user.roles[0] === "string" && user.roles[0]) || "Admin";

  // ── derived widget data ──
  const kpis = useMemo(() => {
    if (!o) return [];
    const k = o.kpis;
    const periodNote = `vs. previous ${o.period.days} days`;
    return [
      {
        id: "followers", label: "Followers (now)", value: fmtCompact(k.followers.value), accent: T.teal, icon: ICONS.followers, spark: k.followers.spark,
        trend: k.followers.delta != null && k.followers.value - k.followers.delta > 0 ? (k.followers.delta / (k.followers.value - k.followers.delta)) * 100 : null,
        reliable: true,
        note: k.followers.delta != null ? `${fmtSigned(k.followers.delta)} · ${k.followers.channelsWithHistory}/${o.channels.total} channels` : `across ${o.channels.total} channels`,
        rows: [
          { label: "Facebook Pages", value: String(o.channels.facebook) },
          { label: "Instagram accounts", value: String(o.channels.instagram) },
          { label: `Change · ${k.followers.deltaDays ?? o.period.days}d`, value: fmtSigned(k.followers.delta) },
          { label: "Channels with full-period history", value: `${k.followers.channelsWithHistory} of ${o.channels.total}` },
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
        note: k.reach.window ? `unique accounts · ${k.reach.window === "week" ? "7" : "28"}-day window` : "only published for 7 & 28-day windows",
        rows: [
          { label: "Channels reporting", value: `${k.reach.contributing} of ${o.channels.total}` },
          { label: "Why no trend", value: "Unique people cannot be compared across periods honestly" },
        ],
        href: "/accounts/growth",
      },
      {
        id: "revenue", label: "Total Revenue", value: fmtUsd(k.revenue.value), accent: T.green, icon: ICONS.revenue, spark: k.revenue.spark,
        trend: k.revenue.trend?.pct ?? null, reliable: k.revenue.trend?.reliable ?? true, note: periodNote,
        rows: [
          { label: "Previous period", value: fmtUsd(k.revenue.previous) },
          { label: "Pages reporting earnings", value: String(k.revenue.contributing) },
          { label: "Currency", value: "USD, as paid by Meta" },
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

  const search = useMemo(() => {
    if (!o) return [];
    const term = q.trim().toLowerCase();
    const channels = [...o.topChannels, ...o.revenueByChannel].filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);
    const groups = [
      { label: "Channels", items: channels.filter((c) => !term || c.name.toLowerCase().includes(term) || (c.username ?? "").toLowerCase().includes(term)).map((c) => ({ title: c.name, meta: `${fmtCompact(c.followers)} followers`, open: () => openChannel(c) })) },
      { label: "Latest posts", items: o.latestPosts.filter((p) => !term || p.title.toLowerCase().includes(term) || p.channel.name.toLowerCase().includes(term)).map((p) => ({ title: p.title, meta: p.channel.name, open: () => openPost(p) })) },
      { label: "Trending", items: o.trending.filter((t) => !term || t.name.toLowerCase().includes(term)).map((t) => ({ title: t.name, meta: `${t.count} posts`, open: () => openTrending(t) })) },
    ];
    return groups.map((g) => ({ ...g, items: g.items.slice(0, term ? 5 : 2) })).filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o, q]);

  // ── drawers ──
  function openChannel(c: ChannelRow) {
    const url = metaUrl(c);
    setDrawer({
      kind: c.platform === "facebook" ? "Facebook Page" : "Instagram account", accent: T.gold, title: c.name,
      sub: c.username ? `@${c.username}` : undefined,
      hero: { label: `Views · last ${o?.period.days ?? 7} days`, value: fmtCompact(c.views), trend: c.followerDelta != null && c.followers ? <Trend pct={(c.followerDelta / Math.max(1, c.followers - c.followerDelta)) * 100} /> : undefined, note: c.followerDeltaDays ? `followers · ${c.followerDeltaDays}d` : undefined },
      rows: [
        { label: "Followers", value: fmtCompact(c.followers) },
        { label: `Revenue · last ${o?.period.days ?? 7} days`, value: fmtUsd(c.earningsCents) },
        { label: "Follower change", value: c.followerDeltaDays ? `${fmtSigned(c.followerDelta)} · ${c.followerDeltaDays}d` : "—" },
      ],
      href: url ? { label: "Open on Meta ↗", url, external: true } : { label: "Open in Account Growth", url: "/accounts/growth" },
    });
    setPop(null);
  }
  function openPost(p: OverviewPayload["latestPosts"][number]) {
    setDrawer({
      kind: p.mediaProductType === "REELS" ? "Reel" : "Post", accent: T.pink, title: p.title, sub: `${p.channel.name} · ${fmtRelative(p.postedAt, now)}`,
      hero: { label: "Views", value: fmtCompact(p.views), note: p.views == null ? "Meta has not published a view count for this post yet" : "since publish" },
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
  function openTrending(t: OverviewPayload["trending"][number]) {
    setDrawer({
      kind: `Trending ${t.type.toLowerCase()}`, accent: T.teal, title: t.name, sub: `${t.count} tagged posts · last 7 days`,
      rows: [
        { label: "Previous 7 days", value: String(t.previousCount) },
        { label: "Change", value: t.previousCount > 0 ? fmtSignedPct(((t.count - t.previousCount) / t.previousCount) * 100) : "new this week" },
      ],
      href: { label: "Search these posts", url: "/reports/link-search" },
      note: "Counts come from captions harvested this week and tagged by Link Search.",
    });
  }
  function openKpi(k: (typeof kpis)[number]) {
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
                onChange={(e) => { setQ(e.target.value); setPop("search"); }}
                onFocus={() => setPop("search")}
                placeholder="Search channels, posts, trending…"
                aria-label="Search"
              />
            </div>
            {pop === "search" && o && (
              <div role="listbox" className="ov-menu ov-search-menu">
                {search.map((g) => (
                  <div key={g.label}>
                    <div className="ov-menu-group">{g.label}</div>
                    {g.items.map((r) => (
                      <MenuItem key={r.title} onClick={() => { r.open(); setQ(""); }} meta={r.meta}>{r.title}</MenuItem>
                    ))}
                  </div>
                ))}
                {search.length === 0 && (
                  <div className="ov-noresults">No results for “{q}”.<br /><span>Try a channel name, caption or topic.</span></div>
                )}
                <a className="ov-menu-foot" href="/reports/link-search">Search every submitted post in Link Search →</a>
              </div>
            )}
          </div>

          <div className="ov-top-right">
            <div className="ov-rel">
              <Chip onClick={() => setPop(pop === "date" ? null : "date")} ariaHasPopup active={pop === "date"}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.sub} strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
                <span className="ov-date-label">{o ? `${fmtDayYear(o.period.start)} – ${fmtDayYear(o.period.end)}` : `Last ${days} days`}</span>
              </Chip>
              {pop === "date" && (
                <Menu width={240}>
                  <div className="ov-menu-group">Global period · KPI strip &amp; tables</div>
                  {PERIODS.map((d) => (
                    <MenuItem key={d} active={d === days} onClick={() => { setDays(d); remember("ov-days", d); setPop(null); }} meta={`${d} closed days`}>Last {d} days</MenuItem>
                  ))}
                  <div className="ov-menu-note">Audience Growth and Revenue keep their own period unless reset.</div>
                </Menu>
              )}
            </div>
            <div className="ov-rel">
              <button type="button" className="ov-icon-btn" aria-label={`Notifications, ${pendingCount} pending`} onClick={() => setPop(pop === "notif" ? null : "notif")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3zM10 20a2 2 0 0 0 4 0" /></svg>
                {pendingCount > 0 && <span className="ov-badge" />}
              </button>
              {pop === "notif" && (
                <Menu width={280}>
                  <div className="ov-menu-row"><b>Needs attention</b><span>{o?.pending ? "live" : "unavailable"}</span></div>
                  {o?.pending ? (
                    <>
                      <MenuItem onClick={() => router.push("/approvals")} meta={String(o.pending.approvals)}>Pending approvals</MenuItem>
                      <MenuItem onClick={() => router.push("/employees/pending")} meta={String(o.pending.employees)}>New joiners to review</MenuItem>
                      <MenuItem onClick={() => router.push("/approvals")} meta={String(o.pending.leave)}>Leave requests</MenuItem>
                      <MenuItem onClick={() => router.push("/approvals")} meta={String(o.pending.documents)}>Documents to verify</MenuItem>
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

        {!isAdmin && (
          <StateMessage tone="empty" title="The Overview is for administrators" body="This command centre needs an Admin role. Your dashboard has everything your role can see." cta="Open dashboard" onCta={() => router.push("/dashboard")} />
        )}
        {isAdmin && !o && isLoading && <Skeleton />}
        {isAdmin && !o && error && (
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
                  <div className="ov-rel" onClick={(e) => e.stopPropagation()}>
                    <Chip onClick={() => setPop(pop === "aud" ? null : "aud")} ariaHasPopup active={pop === "aud"}>Last {audDays} Days</Chip>
                    {pop === "aud" && <Menu>{WIDGET_PERIODS.map((d) => <MenuItem key={d} active={d === audDays} onClick={() => { setAudDays(d); remember("ov-aud", d); setPop(null); }}>Last {d} days</MenuItem>)}</Menu>}
                  </div>
                }
              >
                <div className="ov-headline">
                  <span className="ov-big">{fmtCompact(o.audience.series[o.audience.series.length - 1]?.followers ?? null)}</span>
                  <span className="ov-headline-side">
                    <Trend pct={o.audience.delta != null && o.audience.series[0]?.followers ? (o.audience.delta / o.audience.series[0].followers) * 100 : null} />
                    <span>{o.audience.delta != null ? `${fmtSigned(o.audience.delta)} followers · ${o.audience.channelsUsed} of ${o.channels.total} channels` : `${o.audience.channelsUsed} of ${o.channels.total} channels with history`}</span>
                  </span>
                  {audDays !== 30 && <button type="button" className="ov-reset" onClick={() => { setAudDays(30); remember("ov-aud", 30); }}>Local period · Reset</button>}
                </div>
                <AreaLineChart id="ov-aud-fill" color={T.teal} unitLabel="followers" points={o.audience.series.map((s) => ({ date: s.date, value: s.followers }))} />
              </Card>

              <Card
                title="Revenue Overview"
                right={
                  <div className="ov-rel" onClick={(e) => e.stopPropagation()}>
                    <Chip onClick={() => setPop(pop === "rev" ? null : "rev")} ariaHasPopup active={pop === "rev"}>Last {revDays} Days</Chip>
                    {pop === "rev" && <Menu>{WIDGET_PERIODS.map((d) => <MenuItem key={d} active={d === revDays} onClick={() => { setRevDays(d); remember("ov-rev", d); setPop(null); }}>Last {d} days</MenuItem>)}</Menu>}
                  </div>
                }
              >
                <div className="ov-headline">
                  <span className="ov-big">{fmtUsd(o.revenue.totalCents)}</span>
                  <span className="ov-headline-side">
                    <Trend pct={o.revenue.trend?.pct ?? null} reliable={o.revenue.trend?.reliable ?? true} />
                    <span>vs. previous {revDays} days · USD</span>
                  </span>
                  {revDays !== 30 && <button type="button" className="ov-reset" onClick={() => { setRevDays(30); remember("ov-rev", 30); }}>Local period · Reset</button>}
                </div>
                <CumulativeBars unitLabel="revenue" formatValue={(v) => fmtUsd(v)} points={o.revenue.series.map((s) => ({ date: s.date, cumulative: s.cumulativeCents, daily: s.cents }))} />
              </Card>

              <Card title="Views by Channel" right={<Chip>Last {o.period.days} Days</Chip>}>
                {catSlices.length ? (
                  <div className="ov-donut-row">
                    <Donut
                      slices={catSlices}
                      size={118}
                      thickness={16}
                      selected={selCat}
                      onSelect={setSelCat}
                      center={selCat != null && catSlices[selCat] ? `${catSlices[selCat].share.toFixed(0)}%` : fmtCompact(o.kpis.views.value)}
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
              <Card title="Top Channels" right={<ViewAll href="/accounts/growth" />}>
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

              <Card title="India’s Audience Map">
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

              <Card
                title={<>Latest Posts <span className="ov-live-pill"><span />LIVE</span></>}
                right={<ViewAll href="/accounts/growth" />}
              >
                <div className="ov-feed">
                  {o.latestPosts.length === 0 && <Empty>No posts synced yet.</Empty>}
                  {o.latestPosts.map((p) => {
                    const fresh = now - Date.parse(p.postedAt) < 60 * 60_000;
                    return (
                      <button key={p.id} type="button" className="ov-feed-row" onClick={() => openPost(p)}>
                        <span className="ov-thumb" style={{ background: PLATFORM_TILE[p.channel.platform] }}><span /></span>
                        <span className="ov-feed-body">
                          <span className="ov-feed-t">{p.title}</span>
                          <span className="ov-feed-m">
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

              <Card title="Revenue by Channel" right={<ViewAll href="/accounts/growth" />}>
                <div className="ov-table">
                  <div className="ov-th ov-cols-rev"><span /><span>Channel</span><span /><span style={{ textAlign: "right" }}>Revenue</span></div>
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
                  {o.activity.map((a, i) => (
                    <button key={`${a.kind}-${a.at}-${i}`} type="button" className="ov-act" aria-expanded={actOpen === i} onClick={() => setActOpen(actOpen === i ? null : i)}>
                      <span className="ov-act-dot" style={{ background: ACTIVITY_COLOR[a.kind], boxShadow: `0 0 6px ${ACTIVITY_COLOR[a.kind]}` }} />
                      <span className="ov-act-t" style={{ whiteSpace: actOpen === i ? "normal" : "nowrap" }}>{a.text}</span>
                      <span className="ov-act-when">{fmtRelative(a.at, now)}</span>
                    </button>
                  ))}
                </div>
              </Card>

              <Card title="Content Traction" right={<Chip>Last 7 Days</Chip>}>
                <div className="ov-trac-tiles">
                  {o.traction.tiles.map((t, i) => (
                    <div key={t.key} className={i ? "has-divider" : ""}>
                      <div className="ov-trac-v">{fmtCompact(t.value)}</div>
                      <div className="ov-trac-l" style={{ color: SERIES4[i] }}>{t.label}</div>
                      <div className="ov-trac-t"><Trend pct={t.pct} /></div>
                    </div>
                  ))}
                </div>
                {traction && <IndexedLines series={traction.series} dates={traction.dates} />}
              </Card>

              <Card title="Audience Demographics">
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

              <Card title="What’s Trending" right={<ViewAll href="/reports/link-search" />}>
                <div className="ov-trending">
                  {o.trending.length === 0 && <Empty>No captions tagged this week yet.</Empty>}
                  {o.trending.map((t, i) => {
                    const up = t.count >= t.previousCount;
                    return (
                      <button key={t.id} type="button" className="ov-trend-row" onClick={() => openTrending(t)}>
                        <span className="ov-rank-sm">{i + 1}</span>
                        <span className="ov-trend-tile" style={{ background: `linear-gradient(135deg,${CATEGORICAL[i % CATEGORICAL.length]},${CATEGORICAL[(i + 3) % CATEGORICAL.length]})` }} />
                        <span className="ov-trend-name">{t.name}</span>
                        <span className="ov-trend-count">{fmtCompact(t.count, 0)} posts</span>
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
            Live platform data · {o.channels.total} connected channels · data through {o.period.dataThroughDay ? fmtDay(o.period.dataThroughDay) : "—"} · refreshed {fmtRelative(o.generatedAt, now)}
          </div>
        )}

        {drawer && <Drawer spec={drawer} onClose={() => setDrawer(null)} />}
      </main>
    </div>
  );
}
