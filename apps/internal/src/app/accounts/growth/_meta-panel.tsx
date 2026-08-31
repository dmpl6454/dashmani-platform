"use client";

/**
 * Connected Meta channels — the primary Account Growth surface.
 *
 * ⚠️ THIS IS A CHANNEL MONITOR, NOT A POST FEED. An earlier version led with a
 * flat list of individual posts across 120 channels, which answered a question
 * nobody asked ("what was posted?") instead of the one they did ("how is each
 * channel doing?"). Posts are now a per-channel drill-down only.
 *
 * ⚠️ A metric Meta does not publish renders as an em-dash, never 0 — and the
 * footnote names which ones those are per platform, so a dash is never mistaken
 * for missing data or a real zero.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  RefreshCw, Link2, Unlink, AlertTriangle, ExternalLink, Loader2, ChevronDown, ChevronRight,
  Eye, EyeOff, Download,
} from "lucide-react";
import {
  useMetaConnections, useMetaChannels, useMetaPosts,
  startMetaConnect, triggerMetaDiscovery, triggerMetaSync, disconnectMeta, setAssetsSelectedBulk,
  fmtMetric, fmtMoney, fmtWatchTime, useMetaDemographics, CHANNEL_WINDOWS, windowSuffix, type MetaChannel, type MetaConnection, type ChannelWindowKey,
} from "@/lib/hooks/use-meta";

/** Per-browser preference for masking revenue while presenting. */
const REVENUE_HIDDEN_KEY = "meta-growth:hide-revenue";

/** A plain signed integer or decimal — the only shape a spreadsheet must read as a number. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * One CSV field, RFC-4180 quoted and guarded against formula injection.
 *
 * ⚠️ The leading-apostrophe guard is not cosmetic: a channel literally named
 * "=WEBSERVICE(...)" would EXECUTE when the file is opened in Excel or Sheets, and
 * we do not control channel names — Meta does.
 *
 * ⚠️ BUT IT MUST NOT TOUCH NUMBERS, and the first version did. `-` is a formula
 * trigger, so every NEGATIVE follower change came out as `'-3273`: text, not a
 * number. It could not be summed, sorted or charted, and the apostrophe was
 * visible in the sheet. A number can never be a formula, so numerics are written
 * bare and only genuine text is guarded.
 */
function csvCell(v: unknown): string {
  let str = v == null ? "" : String(v);
  if (!NUMERIC.test(str) && /^[=+\-@\t\r]/.test(str)) str = "'" + str;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Money as a plain decimal for spreadsheets — never "$1.2k", which cannot be summed. */
function csvMoney(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

function StatusChip({ status, daysLeft }: { status: string; daysLeft: number | null }) {
  const map: Record<string, { cls: string; label: string; title: string }> = {
    ACTIVE: { cls: "text-[#3E9B4F] border-[#C6E8CB] bg-[#F2FAF3]", label: "Connected",
      title: "Reading live data through your Meta authorisation." },
    PARTIAL_SCOPE: { cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]", label: "Partial permissions",
      title: "A required permission was declined. Reconnect to grant it." },
    NEEDS_REAUTH_SOON: { cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]",
      label: daysLeft != null ? `Expires in ${daysLeft}d` : "Expiring soon",
      title: "Meta data access lapses ~90 days after authorising. Reconnect to extend." },
    NEEDS_REAUTH: { cls: "text-[#C0504D] border-[#F3C7C6] bg-[#FDF1F1]", label: "Reconnect needed",
      title: "The grant is no longer valid — reconnect to resume." },
    RATE_LIMITED: { cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]", label: "Rate limited",
      title: "Meta is throttling us; this clears itself on the next run." },
    REVOKED: { cls: "text-[#7A7A7A] border-[#DCDCDC] bg-[#F7F7F7]", label: "Disconnected", title: "Revoked." },
  };
  const m = map[status] ?? map.REVOKED;
  return (
    <span title={m.title}
      className={`inline-flex items-center text-[11px] font-medium border rounded-full px-2 py-0.5 leading-none whitespace-nowrap ${m.cls}`}>
      {m.label}
    </span>
  );
}

const DIMENSION_LABEL: Record<string, string> = {
  country: "Top countries", city: "Top cities", age: "Age", gender: "Gender",
};
const AUDIENCE_LABEL: Record<string, string> = {
  follower: "Followers", engaged: "Engaged", reached: "Reached",
};

/**
 * WHO this channel's audience is. Instagram only — Facebook retired its
 * fan-demographic metrics, and the API says so rather than 404ing, so the panel
 * can explain instead of looking broken.
 */
function ChannelAudience({ assetId }: { assetId: string }) {
  const { data, isLoading } = useMetaDemographics(assetId);
  const [audience, setAudience] = useState<string>("follower");
  if (isLoading) return <p className="px-6 py-3 text-[11px] text-[#B0B0B0]">Loading audience…</p>;
  if (!data) return null;

  if (!data.supported) {
    return <p className="px-6 py-3 text-[11px] text-[#B0B0B0]">{data.reason}</p>;
  }
  if (data.pending) {
    return (
      <p className="px-6 py-3 text-[11px] text-[#B0B0B0]">
        Audience breakdown refreshes once a day and hasn&apos;t been collected for this channel
        yet. Meta also withholds it entirely for accounts below its privacy threshold.
      </p>
    );
  }

  const dims = data.audiences[audience] ?? {};
  const available = Object.keys(data.audiences);

  return (
    <div className="px-6 py-3 bg-[#FCFBF8] border-t border-[#F0EAE0]">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="text-[10px] text-[#B0B0B0] mr-0.5">Audience</span>
        {available.map((a) => (
          <button
            key={a}
            onClick={() => setAudience(a)}
            aria-pressed={audience === a}
            className={`text-[10px] rounded-full px-2 py-0.5 border ${
              audience === a
                ? "bg-[#5B4BF5] text-white border-[#5B4BF5]"
                : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-white"}`}
          >
            {AUDIENCE_LABEL[a] ?? a}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
        {(["country", "city", "age", "gender"] as const).map((dim) => {
          const rows = dims[dim] ?? [];
          if (rows.length === 0) return null;
          // Percentages are of the buckets Meta returned, which is a top-N set and
          // not the whole audience — so the label says "of shown", never "of all".
          const shown = rows.slice(0, dim === "age" || dim === "gender" ? 8 : 6);
          const total = rows.reduce((sum, r) => sum + r.value, 0) || 1;
          return (
            <div key={dim} className="min-w-0">
              <p className="text-[10px] text-[#7A7A7A] font-medium mb-1">{DIMENSION_LABEL[dim]}</p>
              {shown.map((r) => (
                <div key={r.bucket} className="mb-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] text-[#1A1A1A] truncate">{r.bucket}</span>
                    <span className="text-[10px] text-[#7A7A7A] shrink-0 tabular-nums">
                      {Math.round((r.value / total) * 100)}%
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-[#EFEAE0] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#5B4BF5]"
                      style={{ width: `${Math.max(2, Math.round((r.value / total) * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-[#B0B0B0] leading-snug">
        Share of the buckets Meta returns for this channel, which is a top set rather than the
        whole audience — so these read as relative weight, not an exact census. Refreshed daily.
      </p>
    </div>
  );
}

/** Account-level figures that would bloat the table but matter on one channel. */
function ChannelExtras({ c, sfx }: { c: MetaChannel; sfx: string }) {
  const stats: Array<{ label: string; value: string }> = [
    { label: `New follows · ${sfx}`, value: fmtMetric(c.follows) },
    { label: `Unfollows · ${sfx}`, value: fmtMetric(c.unfollows) },
    ...(c.platform === "instagram"
      ? [
          { label: `Saves · ${sfx}`, value: fmtMetric(c.saves) },
          { label: `Shares · ${sfx}`, value: fmtMetric(c.shares) },
          { label: `Accounts engaged · ${sfx}`, value: fmtMetric(c.accountsEngaged) },
        ]
      : [{ label: `Watch time · ${sfx}`, value: fmtWatchTime(c.videoViewTimeMs) }]),
  ];
  return (
    <div className="px-6 py-3 bg-[#FCFBF8]">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0">
            <p className="font-num text-sm font-semibold text-[#1A1A1A] truncate">{s.value}</p>
            <p className="text-[10px] text-[#7A7A7A] leading-tight">{s.label}</p>
          </div>
        ))}
      </div>
      {/* ⚠️ Pre-empt the obvious arithmetic: new follows minus unfollows does NOT
          equal the follower change shown in the table, and someone will check.
          Measured on one Page: 783,736 - 107,088 = +676,648 against a measured
          +617,430. They are two different Meta measurements — gross churn counters
          versus the true daily follower total — not two views of one number. */}
      {c.follows !== null && c.unfollows !== null && (
        <p className="mt-2 text-[10px] text-[#B0B0B0] leading-snug">
          New follows and unfollows are Meta&apos;s gross counters. They will not subtract
          exactly to the follower change above — that is measured from the follower count
          itself, which is the more reliable of the two. Treat these as the churn behind the
          net, not as its arithmetic.
        </p>
      )}
    </div>
  );
}

/** One connected Meta account. Rendered for the primary, and for backups on demand. */
function ConnectionRow({
  c, busy, run,
}: {
  c: MetaConnection;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="px-5 py-2.5 border-b border-[#F6F2EA] flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="min-w-0 flex items-center gap-2">
              <span className="text-sm font-medium text-[#1A1A1A] truncate">
                {c.metaUserName ?? `Meta user ${c.metaUserId}`}
              </span>
              <StatusChip status={c.status} daysLeft={c.dataAccessDaysLeft} />
            </div>
            <div className="text-[11px] text-[#7A7A7A] flex items-center gap-2 sm:ml-auto">
              {c.discoveryState !== "done" && <span className="italic">finding channels…</span>}
              <span>{c.assetCount ?? 0} channels</span>
              <button onClick={() => run(`disc-${c.id}`, () => triggerMetaDiscovery(c.id))}
                disabled={busy !== null} className="underline hover:text-[#1A1A1A] disabled:opacity-50">
                {busy === `disc-${c.id}` ? "refreshing…" : "refresh channels"}
              </button>
              <button
                onClick={() => {
                  if (window.confirm("Disconnect this Meta account? Stored data is kept, but nothing new will be fetched."))
                    void run(`del-${c.id}`, () => disconnectMeta(c.id));
                }}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 text-[#C0504D] underline hover:opacity-80 disabled:opacity-50">
                <Unlink className="h-3 w-3" />disconnect
              </button>
            </div>
            {c.missingScopes.length > 0 && (
              <p className="basis-full text-[11px] text-[#C2861D]">
                Declined permissions: {c.missingScopes.join(", ")} — reconnect to grant them.
              </p>
            )}
            {c.lastError && <p className="basis-full text-[11px] text-[#C0504D] break-words">{c.lastError}</p>}
          </div>
  );
}

/** Recent posts for ONE channel — a drill-down, never the headline. */
function ChannelPosts({ assetId }: { assetId: string }) {
  const { data, isLoading } = useMetaPosts({ assetId });
  if (isLoading) return <p className="px-6 py-3 text-[11px] text-[#B0B0B0]">Loading posts…</p>;
  const items = data?.items ?? [];
  if (items.length === 0)
    return <p className="px-6 py-3 text-[11px] text-[#B0B0B0]">No posts stored for this channel yet.</p>;
  return (
    <div className="px-6 py-2 bg-[#FCFBF8]">
      <table className="w-full">
        <thead>
          <tr className="text-[10px] text-[#B0B0B0]">
            <th className="text-left font-medium py-1">Most recent posts</th>
            <th className="text-right font-medium py-1 w-16">Views</th>
            <th className="text-right font-medium py-1 w-16">Likes</th>
            <th className="text-right font-medium py-1 w-20">Comments</th>
            <th className="text-right font-medium py-1 w-20">Posted</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 8).map((p) => (
            <tr key={p.id} className="border-t border-[#F0EAE0]">
              <td className="py-1 pr-2 max-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-[11px] text-[#1A1A1A] truncate">
                    {p.caption?.trim() || <span className="text-[#B0B0B0]">(no caption)</span>}
                  </span>
                  {p.permalink && (
                    <a href={p.permalink} target="_blank" rel="noopener noreferrer"
                      className="shrink-0 text-[#B0B0B0] hover:text-[#1A1A1A]">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </td>
              <td className="py-1 text-right text-[11px]">
                {p.metricsStatus === "pending" && p.views === null
                  ? <span className="italic text-[#B0B0B0]">measuring</span>
                  : fmtMetric(p.views)}
              </td>
              <td className="py-1 text-right text-[11px]">{fmtMetric(p.likes)}</td>
              <td className="py-1 text-right text-[11px]">{fmtMetric(p.comments)}</td>
              <td className="py-1 text-right text-[10px] text-[#7A7A7A] whitespace-nowrap">
                {p.postedAt ? new Date(p.postedAt).toLocaleDateString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="py-2 text-[10px] text-[#B0B0B0] leading-snug">
        The most recent posts we have measured — not every post from the last 28 days. A
        per-post figure costs one Meta request and the busiest channels publish over a
        thousand posts a month, so measurement is spent newest-first. The channel totals
        above already count every post, measured or not.
      </p>
    </div>
  );
}

/** Columns the table can sort by. */
type ColKey =
  | "name" | "followers" | "delta" | "views" | "engagements"
  | "reach" | "revenue" | "profileViews" | "posts";

function colValue(c: MetaChannel, k: ColKey): number | string | null {
  switch (k) {
    case "name": return c.name;
    case "followers": return c.followers;
    case "delta": return c.followerDelta ?? null;
    case "views": return c.views28d;
    case "engagements": return c.engagements28d;
    case "reach": return c.reach28d;
    case "revenue": return c.earningsCents;
    case "profileViews": return c.profileViews28d;
    case "posts": return c.posts;
  }
}

/**
 * Clickable, direction-toggling column header.
 *
 * ⚠️ Nulls sort LAST in BOTH directions — a channel Meta has not measured must
 * never outrank one it has (the repo-wide null-ordering convention), and an
 * ascending sort that leads with a wall of dashes reads as broken.
 */
function SortTh({ label, colKey, sort, onSort, align = "right", pad = "px-2", title }: {
  label: React.ReactNode;
  colKey: ColKey;
  sort: { key: ColKey; dir: "asc" | "desc" };
  onSort: (k: ColKey) => void;
  align?: "left" | "right";
  pad?: string;
  title?: string;
}) {
  const active = sort.key === colKey;
  return (
    <th className={`${align === "left" ? "text-left" : "text-right"} font-medium ${pad} py-2`} title={title}>
      <button
        onClick={() => onSort(colKey)}
        aria-pressed={active}
        className={`inline-flex items-center gap-0.5 hover:text-[#1A1A1A] ${active ? "text-[#1A1A1A]" : ""}`}
      >
        {label}
        {/* fixed-width slot so headers don't shift as the arrow moves between columns */}
        <span className="inline-block w-2.5 text-[9px] leading-none text-[#5B4BF5]">
          {active ? (sort.dir === "desc" ? "\u25BC" : "\u25B2") : ""}
        </span>
      </button>
    </th>
  );
}

const isoDayUTC = (d: Date) => d.toISOString().slice(0, 10);
const yesterdayIso = () => isoDayUTC(new Date(Date.now() - 86_400_000));

/**
 * A calendar month as an inclusive [start, end] range, capped at yesterday —
 * daily history only exists for COMPLETED days, and a range that includes today
 * would count a day that is still accumulating. Returns null for a month with
 * no completed days yet (i.e. "this month" on the 1st).
 */
function monthRange(ym: string): { start: string; end: string; label: string } | null {
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`;
  const lastDay = isoDayUTC(new Date(Date.UTC(y, m, 0)));
  const yday = yesterdayIso();
  if (start > yday) return null;
  const end = lastDay < yday ? lastDay : yday;
  const label = new Date(`${start}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" })
    + (end < lastDay ? " (to date)" : "");
  return { start, end, label };
}

function customLabel(start: string, end: string): string {
  const f = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(start)} – ${f(end)}`;
}

export function MetaPanel() {
  const { data: conns, isLoading: connLoading, mutate: mutateConns } = useMetaConnections();
  const [platform, setPlatform] = useState<"all" | "facebook" | "instagram">("all");
  // Header-click sorting (client-side over the loaded rows — all ~500 are
  // already here, and the CSV inherits whatever order is on screen).
  const [tableSort, setTableSort] = useState<{ key: ColKey; dir: "asc" | "desc" }>({ key: "followers", dir: "desc" });
  const [q, setQ] = useState("");
  // Custom range / calendar month. null = the native window pills drive the view.
  const [range, setRange] = useState<{ start: string; end: string; label: string } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [monthPick, setMonthPick] = useState("");
  // Manage mode: checkboxes for removing channels from monitoring.
  const [manageMode, setManageMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [showRemoved, setShowRemoved] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showBackups, setShowBackups] = useState(false);
  const [win, setWin] = useState<ChannelWindowKey>("days_28");
  const [earningOnly, setEarningOnly] = useState(false);
  // Revenue is the one figure someone may not want on screen while presenting or
  // screen-sharing. Remembered per browser so it does not reset on every visit —
  // ⚠️ wrapped in try/catch because localStorage throws outright in some contexts
  // (private windows, blocked site data), and a preference must never break the page.
  const [hideRevenue, setHideRevenue] = useState(false);
  useEffect(() => {
    try {
      setHideRevenue(window.localStorage.getItem(REVENUE_HIDDEN_KEY) === "1");
    } catch { /* no stored preference is a perfectly good default */ }
  }, []);
  /**
   * Download the table as CSV.
   *
   * ⚠️ Built from `channels` — the SAME array the table renders — so it inherently
   * matches whatever the viewer is looking at: period, platform, search, sort and
   * the earning-only filter, with no second code path that could drift out of step
   * with the display. The alternative (a server export re-deriving the query) is
   * exactly how an export starts disagreeing with the screen.
   *
   * Revenue is always included even when hidden on screen: hiding is a
   * presentation choice for the room, not a redaction of the file the user asked
   * for. The filename records the period and the active filters so a downloaded
   * file is still self-describing a month later.
   */
  const downloadCsv = () => {
    const header: string[] = [
      "Channel", "Handle", "Platform", "Followers",
      // ⚠️ Spell out the convention. A bare signed number is right for a
      // spreadsheet (it sums and sorts), but "-3273" next to a blank next to
      // "328717" is not self-explanatory, and the reader should not have to guess.
      `Follower change (${sfx}) [+ gained / - lost / blank = no history yet]`,
      `Views (${sfx})`, `Engagements (${sfx})`, `Reach (${sfx})`, `Revenue USD (${sfx})`,
      "Profile views", "Posts", `New follows (${sfx})`, `Unfollows (${sfx})`,
      `Saves (${sfx})`, `Shares (${sfx})`, `Accounts engaged (${sfx})`,
      "Data through",
    ];
    const coverageCols = isRangeMode ? ["Days covered", "Range days"] : [];
    header.push(...coverageCols);
    const rows = sortedChannels.map((c) => [
      // ⚠️ No leading "@". It is a formula trigger, so every handle came out as
      // `'@name` with a visible apostrophe. Dropping it removes the trigger
      // entirely rather than neutralising it, and a column headed "Handle" does
      // not need the sigil to be unambiguous.
      c.name, c.username ?? "", c.platform,
      c.followers ?? "", c.followerDelta ?? "",
      c.views28d ?? "", c.engagements28d ?? "", c.reach28d ?? "", csvMoney(c.earningsCents),
      c.profileViews28d ?? "", c.posts ?? "",
      c.follows ?? "", c.unfollows ?? "",
      c.saves ?? "", c.shares ?? "", c.accountsEngaged ?? "",
      ch?.dataThrough ? new Date(ch.dataThrough).toISOString().slice(0, 10) : "",
      ...(isRangeMode ? [c.coveredDays ?? "", c.rangeDays ?? ""] : []),
    ]);

    // \uFEFF so Excel opens UTF-8 correctly — without it channel names with
    // non-Latin characters render as mojibake.
    const csv = "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const parts = [
      "meta-channels", isRangeMode && ch?.range ? `${ch.range.start}_${ch.range.end}` : sfx,
      platform !== "all" ? platform : null,
      earningOnly ? "earning-only" : null,
      q.trim() ? "search" : null,
      new Date().toISOString().slice(0, 10),
    ].filter(Boolean);

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${parts.join("-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleRevenue = () => {
    setHideRevenue((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(REVENUE_HIDDEN_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const { data: ch, mutate: mutateCh } = useMetaChannels({
    platform: platform === "all" ? undefined : platform,
    q: q.trim() || undefined,
    window: win,
    ...(range ? { start: range.start, end: range.end } : {}),
  });
  // The removed-channels list is fetched only while its section is open — null
  // key skips the request entirely.
  const { data: hiddenCh, mutate: mutateHidden } = useMetaChannels(showRemoved ? { hidden: true } : null);

  // Label every windowed figure from the window the SERVER says it returned, not
  // from local state — mid-fetch those disagree, and a "Yesterday" heading over
  // 28-day numbers is exactly the kind of confident-but-wrong labelling this
  // page exists to avoid. In range mode the label is the range itself.
  const isRangeMode = ch?.window === "custom";
  const sfx = isRangeMode
    ? (range?.label ?? (ch?.range ? customLabel(ch.range.start, ch.range.end) : "range"))
    : windowSuffix((ch?.window as ChannelWindowKey | undefined) ?? win);
  const periodDays = isRangeMode
    ? (ch?.range?.days ?? null)
    : ch?.window === "day" || ch?.window === "today" ? 1 : ch?.window === "week" ? 7 : 28;

  const connections = conns?.connections ?? [];
  const live = connections.filter((c) => c.status !== "REVOKED");
  // The API marks the primary (the grant supplying the most channels). Falling back
  // to the first keeps this correct against an older API response that predates the
  // flag, rather than rendering no account at all.
  const primaryConn = live.find((c) => c.primary) ?? live[0] ?? null;
  const backupConns = live.filter((c) => c.id !== primaryConn?.id);
  const configured = conns?.configured ?? false;
  const allChannels = ch?.items ?? [];
  // ⚠️ `> 0`, not `!= null`. A channel Meta reports as earning exactly $0 is NOT
  // "making revenue", and null means Instagram (no earnings metric at all) — both
  // must fall out of this filter or it answers a different question than its label.
  const channels = earningOnly
    ? allChannels.filter((c) => (c.earningsCents ?? 0) > 0)
    : allChannels;

  const sortedChannels = useMemo(() => {
    const { key, dir } = tableSort;
    const arr = [...channels];
    arr.sort((a, b) => {
      const av = colValue(a, key);
      const bv = colValue(b, key);
      if (key === "name") {
        return dir === "asc"
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      }
      // Nulls last in BOTH directions — see SortTh.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return arr;
  }, [channels, tableSort]);

  const onSort = (k: ColKey) =>
    setTableSort((cur) =>
      cur.key === k
        ? { key: k, dir: cur.dir === "desc" ? "asc" : "desc" }
        : { key: k, dir: k === "name" ? "asc" : "desc" });

  /**
   * The Followers tile's period change: the sum of per-channel deltas whose
   * history spans (>=90% of) the selected period.
   *
   * ⚠️ THE GUARDS ARE WHAT MAKE THIS SUM HONEST — an unguarded version was
   * measured against prod and rejected: contested channel rows contributed
   * +5,100,699 of a +5,113,403 24h "gain" (the server now excludes them from
   * deltas entirely), and short-history channels contributed 5-day changes
   * labelled as 28-day ones (the server now reports each delta's true span,
   * which is what the full-span filter here checks). What survives is a sum of
   * same-period, same-kind measurements, with the count disclosed so a partial
   * estate never reads as the whole.
   */
  const fullSpanMin = periodDays ? Math.max(1, Math.ceil(periodDays * 0.9)) : null;
  const spanRows = fullSpanMin === null
    ? []
    : allChannels.filter((c) => c.followerDelta != null && c.followerDeltaDays != null && c.followerDeltaDays >= fullSpanMin);
  const followerChange = spanRows.reduce((a, c) => a + (c.followerDelta as number), 0);

  // Trend chips (views / engagements / revenue vs the equal-length prior span).
  // ⚠️ Gated on baseline coverage: a percentage computed against a half-covered
  // baseline fabricates growth, so below 95% the chips simply do not render.
  const prevTotals = ch?.previousTotals ?? null;
  // Two independent honesty gates: the baseline's own days must be ~complete,
  // AND it must cover ~the same channel set as the current range — mid-backfill,
  // a fully-self-consistent 2-channel baseline is still no basis for an estate
  // trend against a 400-channel present.
  const trendOk =
    !!prevTotals &&
    prevTotals.coverageShare >= 0.95 &&
    (prevTotals.assets ?? 0) >= Math.max(1, Math.floor((ch?.contributing?.views ?? 0) * 0.9));
  const trendPct = (cur: number, prevVal: number): number | null =>
    trendOk && prevVal > 0 ? ((cur - prevVal) / prevVal) * 100 : null;


  async function connect(mode: "connect" | "reconnect", connectionId?: string) {
    setErr(null); setBusy("connect");
    try {
      const { authorizeUrl } = await startMetaConnect({ mode, connectionId, rerequest: mode === "reconnect" });
      window.location.href = authorizeUrl; // Meta refuses to render consent in an iframe
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the Meta connection.");
      setBusy(null);
    }
  }

  /** Remove the checked channels from monitoring, or restore a removed set. */
  async function setSelectedBulk(ids: string[], selected: boolean, confirmText?: string) {
    if (ids.length === 0) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setErr(null); setBusy(selected ? "restore" : "remove");
    try {
      await setAssetsSelectedBulk(ids, selected);
      setCheckedIds(new Set());
      await Promise.all([mutateCh(), mutateHidden(), mutateConns()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Updating channels failed.");
    } finally { setBusy(null); }
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setErr(null); setBusy(label);
    try {
      await fn();
      await new Promise((r) => setTimeout(r, 3000)); // fire-and-forget job needs a beat
      await Promise.all([mutateConns(), mutateCh()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That action failed.");
    } finally { setBusy(null); }
  }

  if (!connLoading && !configured) {
    return (
      <section className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-2">
        <h2 className="font-serif text-lg text-[#1A1A1A]">Facebook &amp; Instagram</h2>
        <p className="text-sm text-[#7A7A7A]">
          Meta connection isn&apos;t configured on the server, so no Facebook or Instagram data can be shown.
        </p>
        {(conns?.missingEnv?.length ?? 0) > 0 && (
          <p className="text-[11px] text-[#B0B0B0]">Missing: {conns!.missingEnv.join(", ")}</p>
        )}
      </section>
    );
  }

  const t = ch?.totals;
  const contrib = ch?.contributing;

  return (
    <section className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#F0EAE0] flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="font-serif text-lg text-[#1A1A1A]">Connected channels</h2>
          <p className="text-xs text-[#7A7A7A] mt-0.5">
            Facebook Pages &amp; Instagram accounts, read directly from Meta — no scraping.
          </p>
        </div>
        <div className="flex items-center gap-1.5 sm:ml-auto">
          {live.length > 0 && (
            <button onClick={() => run("sync", () => triggerMetaSync())} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-xs font-medium border border-[#DCDCDC] rounded-full px-3 py-1.5 hover:bg-[#FAFAFA] disabled:opacity-50">
              {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          )}
          <button onClick={() => connect(live.length > 0 ? "reconnect" : "connect", live[0]?.id)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1.5 bg-[#1877F2] text-white hover:bg-[#166FE5] disabled:opacity-50">
            <Link2 className="h-3.5 w-3.5" />
            {live.length > 0 ? "Reconnect" : "Connect with Facebook"}
          </button>
        </div>
      </div>

      {err && (
        <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-[#C0504D] bg-[#FDF1F1] border border-[#F3C7C6] rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="min-w-0">{err}</span>
        </div>
      )}

      {!connLoading && live.length === 0 && (
        <div className="px-5 py-8 text-center space-y-2">
          <p className="text-sm text-[#1A1A1A] font-medium">No Meta account connected yet</p>
          <p className="text-xs text-[#7A7A7A] max-w-md mx-auto leading-relaxed">
            Connect the Facebook account that manages your Pages. We&apos;ll list every Page and
            Instagram account it administers, with each channel&apos;s followers, views and
            engagement. Read-only — we never post anything.
          </p>
        </div>
      )}

      {/* ⚠️ ONE ACCOUNT, NOT A LIST. Extra connections are token redundancy — a
          Facebook token expires (~90 days) and dies on a password change, so a
          single grant makes one person's password a single point of failure for
          this whole page. They are kept, but folded away: an admin should see the
          account, not a fleet to administer. Underneath, duplicate channels are
          already suppressed so a second grant costs no extra API calls. */}
      {primaryConn && <ConnectionRow c={primaryConn} busy={busy} run={run} />}

      {backupConns.length > 0 && (
        <div className="px-5 py-2 border-b border-[#F6F2EA]">
          <button
            onClick={() => setShowBackups((v) => !v)}
            aria-expanded={showBackups}
            className="text-[11px] text-[#7A7A7A] hover:text-[#1A1A1A] underline"
          >
            {showBackups ? "Hide" : "Show"} {backupConns.length} backup connection
            {backupConns.length > 1 ? "s" : ""}
          </button>
          <span className="ml-2 text-[10px] text-[#B0B0B0]">
            kept so access survives a password change or someone leaving — they add no
            duplicate channels and no extra API calls
          </span>
        </div>
      )}
      {showBackups && backupConns.map((c) => <ConnectionRow key={c.id} c={c} busy={busy} run={run} />)}

      {live.length > 0 && t && (
        // ⚠️ 5 tiles, so the column counts must divide cleanly or one orphans onto
        // a row of its own — which is what `sm:grid-cols-4` was doing to Revenue.
        // 2 / 3 / 5 gives 2+2+1, 3+2 and a single row of 5.
        // ⚠️ Five across only at `xl`, not `lg`. The sidebar eats ~340px, so at
        // 1024px the content strip is ~684px and five columns leave ~120px each —
        // measured, the value ellipsised at that width. Three columns there keep
        // the tiles wide enough; five only once there is genuinely room.
        <div className="px-5 py-5 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-x-4 gap-y-5 border-b border-[#F0EAE0]">
          {[
            { label: "Channels", value: ch!.channelCount, raw: true, note: null as string | null },
            // ⚠️ THE HEADLINE OF THIS TILE DOES NOT MOVE WITH THE PERIOD, AND THAT
            // IS CORRECT. Followers is a STOCK ("how many right now"), not a flow —
            // the total is SUM(follower_count), a column with no window dimension.
            // Reported as "faulty data" three times, so the label, tooltip and note
            // all say so explicitly.
            //
            // The NOTE is what moves with the period: the summed change across
            // channels with FULL-PERIOD history. An unguarded sum was measured on
            // prod and rejected (contested rows fabricated +5.1m of a +5.11m
            // "gain"; 5-day spans were labelled 28d) — the server now excludes
            // contested rows from deltas and reports each delta's true span, and
            // the full-span filter plus the disclosed count are what make this sum
            // honest. Do NOT remove either guard.
            { label: "Followers (now)", value: t.followers, raw: false,
              title: "A live total, not a period figure — how many followers these channels have right now, so the headline reads the same on every period by design. The change line beneath it follows the selected period, summed over channels whose API follower history spans that whole period.",
              note: spanRows.length > 0
                ? `${followerChange >= 0 ? "+" : ""}${fmtMetric(followerChange)} · ${sfx} · ${spanRows.length} of ${ch!.channelCount} channels with full-period history`
                : "headline is a live total — per-channel change is in the table",
              noteTone: spanRows.length > 0 ? (followerChange > 0 ? "up" : followerChange < 0 ? "down" : null) : null },
            { label: `Views · ${sfx}`, value: t.views, raw: false,
              trend: trendPct(t.views, prevTotals?.views ?? 0),
              note: contrib && contrib.views < ch!.channelCount ? `${contrib.views}/${ch!.channelCount} channels reporting` : null },
            { label: `Engagements · ${sfx}`, value: t.engagements, raw: false,
              trend: trendPct(t.engagements, prevTotals?.engagements ?? 0),
              note: contrib && contrib.engagements < ch!.channelCount ? `${contrib.engagements}/${ch!.channelCount} reporting` : null },
            { label: `Revenue · ${sfx}`, value: t.earningsCents, raw: false, money: true,
              // ⚠️ No trend while revenue is masked — "▲ 12%" leaks the very
              // motion someone hid the amounts to avoid showing on a call.
              trend: hideRevenue ? null : trendPct(t.earningsCents, prevTotals?.earningsCents ?? 0),
              note: contrib ? `${contrib.earnings} channel(s) earning · Facebook only` : null },
          ].map((s) => (
            <div
              key={s.label}
              // ⚠️ Read s.title DIRECTLY — do NOT wrap it in `"title" in s`.
              // TypeScript normalises an array literal of object literals by
              // adding each missing key to the other members as optional, so
              // s.title is already safe to read. An `in` guard instead narrows the
              // key to `unknown`, which makes a MISSPELLING compile silently —
              // trading the one piece of compile-time protection this
              // heterogeneous literal has for nothing.
              title={s.title}
              // A hairline between tiles reads as deliberate structure rather than
              // items that happen to sit near each other. Only at `lg`, where all
              // five are guaranteed to share one row — at narrower widths the grid
              // wraps and a leading border would land mid-row and look like a bug.
              className="min-w-0 xl:border-l xl:border-[#F0EAE0] xl:pl-4 xl:first:border-l-0 xl:first:pl-0"
            >
              <p
                // ⚠️ clamp, not a fixed size — a fixed `text-2xl`-and-up overflowed
                // its tile at 375px in the documented dashboard incident.
                //
                // ⚠️ The coefficient is 2.2vw, not 3.4vw, because `vw` is the WINDOW
                // and the sidebar takes ~340px of it. At 3.4vw the value hit 34px at
                // 1024px and ellipsised in a ~120px tile — measured, not guessed.
                // 24px phone -> 28px at 1280 -> 32px on a wide desktop, and it still
                // truncates rather than painting over its neighbour.
                className="font-num text-[clamp(1.5rem,2.2vw,2rem)] font-semibold tracking-tight leading-none text-[#1A1A1A] truncate"
              >
                {s.raw
                  ? s.value.toLocaleString()
                  : "money" in s && s.money
                    ? (hideRevenue ? "•••••" : fmtMoney(s.value))
                    : fmtMetric(s.value)}
              </p>
              <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8A8A8A] truncate">
                {s.label}
              </p>
              {/* Trend vs the equal-length prior span — rendered only when the
                  baseline is >=95% covered (see trendOk) so a chip can never be
                  computed against half a baseline. */}
              {typeof s.trend === "number" && (
                <p className={`mt-1 text-[10px] font-medium ${s.trend >= 0 ? "text-[#3E9B4F]" : "text-[#C0504D]"}`}>
                  {s.trend >= 0 ? "\u25B2" : "\u25BC"} {Math.abs(s.trend).toFixed(1)}% vs prior {isRangeMode && periodDays ? `${periodDays}d` : sfx}
                </p>
              )}
              {/* Say what a total does NOT cover, rather than implying completeness. */}
              {s.note && (
                <p className={`mt-0.5 text-[10px] leading-tight ${
                  s.noteTone === "up" ? "text-[#3E9B4F]"
                  : s.noteTone === "down" ? "text-[#C0504D]"
                  : "text-[#B0B0B0]"}`}>
                  {s.note}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {live.length > 0 && (
        <div className="px-5 py-2.5 border-b border-[#F0EAE0] flex flex-wrap items-center gap-2">
          <div
            className="flex flex-wrap items-center gap-1 mr-1"
            role="group"
            aria-label="Reporting period"
          >
            <span className="text-[11px] text-[#B0B0B0] mr-0.5">Period</span>
            {CHANNEL_WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => { setRange(null); setCustomOpen(false); setWin(w.key); }}
                aria-pressed={!range && win === w.key}
                className={`text-[11px] rounded-full px-2.5 py-1 border ${
                  !range && win === w.key
                    ? "bg-[#5B4BF5] text-white border-[#5B4BF5]"
                    : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
              >
                {w.label}
              </button>
            ))}
            {/* Calendar months and custom spans are exact SUMS of stored daily
                history (reach excepted — see the footer). Native pills stay live
                Meta windows; these two families deliberately coexist. */}
            {(["this", "last"] as const).map((which) => {
              const now = new Date();
              const ym = which === "this"
                ? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
                : isoDayUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))).slice(0, 7);
              const r = monthRange(ym);
              if (!r) return null; // "This month" on the 1st: no completed days yet
              const active = range?.start === r.start && range?.end === r.end;
              return (
                <button
                  key={which}
                  onClick={() => { setCustomOpen(false); setRange(r); }}
                  aria-pressed={active}
                  className={`text-[11px] rounded-full px-2.5 py-1 border ${
                    active
                      ? "bg-[#5B4BF5] text-white border-[#5B4BF5]"
                      : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
                >
                  {which === "this" ? "This month" : "Last month"}
                </button>
              );
            })}
            <input
              type="month"
              value={monthPick}
              max={yesterdayIso().slice(0, 7)}
              onChange={(e) => {
                setMonthPick(e.target.value);
                const r = monthRange(e.target.value);
                if (r) { setCustomOpen(false); setRange(r); }
              }}
              title="Pick any calendar month"
              className="text-[11px] border border-[#DCDCDC] rounded-full px-2 py-0.5 bg-white text-[#7A7A7A]"
            />
            <button
              onClick={() => setCustomOpen((v) => !v)}
              aria-expanded={customOpen}
              className={`text-[11px] rounded-full px-2.5 py-1 border ${
                customOpen
                  ? "border-[#5B4BF5] text-[#5B4BF5]"
                  : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
            >
              Custom…
            </button>
          </div>
          <span className="hidden sm:block h-4 w-px bg-[#E8E0D0]" />
          {(["all", "facebook", "instagram"] as const).map((p) => (
            <button key={p} onClick={() => setPlatform(p)}
              className={`text-[11px] rounded-full px-2.5 py-1 border ${
                platform === p ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}>
              {p === "all" ? "All" : p === "facebook" ? "Facebook" : "Instagram"}
            </button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search channels…"
            className="text-[11px] border border-[#DCDCDC] rounded-full px-3 py-1 w-40 focus:outline-none focus:border-[#B0B0B0]" />
          <button
            onClick={() => { setManageMode((v) => !v); setCheckedIds(new Set()); }}
            aria-pressed={manageMode}
            title="Select channels to remove from monitoring. Removed channels stop syncing and drop out of every figure; restore them anytime."
            className={`text-[11px] rounded-full px-2.5 py-1 border ${
              manageMode ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
              : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
          >
            {manageMode ? "Done" : "Manage"}
          </button>
          <button
            onClick={() => setShowRemoved((v) => !v)}
            aria-expanded={showRemoved}
            className="text-[11px] rounded-full px-2.5 py-1 border border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"
          >
            Removed channels
          </button>
          <button
            onClick={() => setEarningOnly((v) => !v)}
            aria-pressed={earningOnly}
            title="Show only channels Meta reports earnings above zero for. Instagram has no earnings metric, so this is Facebook only."
            className={`text-[11px] rounded-full px-2.5 py-1 border ${
              earningOnly
                ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
          >
            Earning only
          </button>

          <button
            onClick={toggleRevenue}
            aria-pressed={hideRevenue}
            title={hideRevenue ? "Show revenue figures" : "Hide revenue figures — useful when screen-sharing. Remembered on this browser."}
            className="inline-flex items-center gap-1 text-[11px] rounded-full px-2.5 py-1 border border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"
          >
            {hideRevenue ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {hideRevenue ? "Show revenue" : "Hide revenue"}
          </button>

          <button
            onClick={downloadCsv}
            disabled={channels.length === 0}
            title="Download exactly what is shown — same period, platform, search, sort and filters."
            className="inline-flex items-center gap-1 text-[11px] rounded-full px-2.5 py-1 border border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA] disabled:opacity-40"
          >
            <Download className="h-3 w-3" />
            CSV
          </button>

          <span className="text-[11px] text-[#B0B0B0] ml-auto">
            {channels.length} channel(s)
            {earningOnly && allChannels.length !== channels.length && (
              <span className="text-[#B0B0B0]"> of {allChannels.length}</span>
            )}
          </span>
        </div>
      )}

      {live.length > 0 && customOpen && (
        <div className="px-5 py-2 border-b border-[#F6F2EA] flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-[#7A7A7A]">From</span>
          <input type="date" value={customStart} max={yesterdayIso()}
            onChange={(e) => setCustomStart(e.target.value)}
            className="border border-[#DCDCDC] rounded-lg px-2 py-1" />
          <span className="text-[#7A7A7A]">to</span>
          <input type="date" value={customEnd} max={yesterdayIso()}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="border border-[#DCDCDC] rounded-lg px-2 py-1" />
          <button
            disabled={!customStart || !customEnd || customStart > customEnd}
            onClick={() => {
              setRange({ start: customStart, end: customEnd, label: customLabel(customStart, customEnd) });
              setCustomOpen(false);
            }}
            className="rounded-full px-3 py-1 bg-[#5B4BF5] text-white disabled:opacity-40"
          >
            Apply
          </button>
          <span className="text-[10px] text-[#B0B0B0]">
            completed days only — history reaches back as far as each channel&apos;s stored daily data
          </span>
        </div>
      )}

      {live.length > 0 && isRangeMode && (
        <div className="px-5 py-2 border-b border-[#F6F2EA] text-[10px] text-[#7A7A7A] leading-snug">
          Exact sums of stored daily history for <strong className="font-medium">{sfx}</strong>
          {ch?.dataThrough && <> · data through {new Date(ch.dataThrough).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })}</>}.
          Reach shows a dash here: it counts unique people, days cannot be added without
          double-counting, and Meta publishes no unique-people figure for a custom span.
          A <span className="text-[#C2861D]">n/Nd</span> chip beside a channel means its stored
          history covers only part of the range — its sums cover those days only.
        </div>
      )}

      {live.length > 0 && manageMode && (
        <div className="px-5 py-2 border-b border-[#F0EAE0] bg-[#FDF8EC] flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-[#7A7A7A]">{checkedIds.size} selected</span>
          <button
            disabled={checkedIds.size === 0 || busy !== null}
            onClick={() => setSelectedBulk(
              [...checkedIds], false,
              `Remove ${checkedIds.size} channel(s) from monitoring?\n\nThey stop syncing (no more Meta API calls are spent on them) and disappear from every figure on this page and the dashboard. Their history is kept and you can restore them anytime under "Removed channels".`,
            )}
            className="rounded-full px-3 py-1 bg-[#C0504D] text-white disabled:opacity-40"
          >
            {busy === "remove" ? "Removing…" : "Remove from monitoring"}
          </button>
          <span className="text-[10px] text-[#B0B0B0]">
            not a delete — removed channels stop syncing and can be restored anytime
          </span>
        </div>
      )}

      {live.length > 0 && showRemoved && (
        <div className="px-5 py-3 border-b border-[#F0EAE0] bg-[#FCFBF8]">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-medium text-[#1A1A1A]">
              Removed channels{hiddenCh ? ` (${hiddenCh.channelCount})` : ""}
            </p>
            {(hiddenCh?.items?.length ?? 0) > 0 && (
              <button
                disabled={busy !== null}
                onClick={() => setSelectedBulk(hiddenCh!.items.map((c) => c.id), true)}
                className="text-[11px] text-[#5B4BF5] hover:underline disabled:opacity-40"
              >
                Restore all
              </button>
            )}
          </div>
          {!hiddenCh ? (
            <p className="text-[11px] text-[#B0B0B0]">Loading…</p>
          ) : hiddenCh.items.length === 0 ? (
            <p className="text-[11px] text-[#B0B0B0]">
              Nothing here — removing a channel (via Manage) hides it from every figure and
              stops spending Meta API calls on it, without deleting its history.
            </p>
          ) : (
            <ul className="space-y-1">
              {hiddenCh.items.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-xs">
                  <span className={`text-[10px] shrink-0 ${c.platform === "facebook" ? "text-[#1877F2]" : "text-[#C13584]"}`}>
                    {c.platform === "facebook" ? "f" : "ig"}
                  </span>
                  <span className="truncate max-w-[260px] text-[#1A1A1A]">{c.name}</span>
                  <span className="text-[10px] text-[#B0B0B0]">{fmtMetric(c.followers)} followers</span>
                  <button
                    disabled={busy !== null}
                    onClick={() => setSelectedBulk([c.id], true)}
                    className="ml-auto text-[11px] text-[#5B4BF5] hover:underline disabled:opacity-40"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {live.length > 0 && (
        <div className="overflow-x-auto">
          {channels.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[#7A7A7A]">
              {ch ? "No channels match that filter." : "Waiting for your channels to be discovered…"}
            </p>
          ) : (
            <table className="w-full min-w-[820px]">
              <thead>
                {/* ⚠️ Column COUNT is dynamic (the Manage checkbox column), so the
                    expanded row's colSpan below must track it — a stale colSpan
                    silently misaligns every cell (the documented drill-down trap). */}
                <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
                  {manageMode && (
                    <th className="pl-4 pr-1 py-2 text-left">
                      <input
                        type="checkbox"
                        aria-label="Select all listed channels"
                        checked={sortedChannels.length > 0 && sortedChannels.every((c) => checkedIds.has(c.id))}
                        onChange={(e) => setCheckedIds(e.target.checked ? new Set(sortedChannels.map((c) => c.id)) : new Set())}
                        className="h-3.5 w-3.5 accent-[#5B4BF5]"
                      />
                    </th>
                  )}
                  <SortTh label="Channel" colKey="name" sort={tableSort} onSort={onSort} align="left" pad="px-5" />
                  <SortTh
                    colKey="followers" sort={tableSort} onSort={onSort}
                    title="A live total, not a period figure — how many followers the channel has right now. The period filter drives Views, Engagements and Reach."
                    label={<>Followers <span className="text-[#B0B0B0] font-normal">(now)</span></>}
                  />
                  <SortTh label={`Views ${sfx}`} colKey="views" sort={tableSort} onSort={onSort} />
                  <SortTh label={`Engagements ${sfx}`} colKey="engagements" sort={tableSort} onSort={onSort} />
                  <SortTh
                    label={`Reach ${sfx}`} colKey="reach" sort={tableSort} onSort={onSort}
                    title={isRangeMode
                      ? "No reach for a custom range: reach counts unique people, days cannot be added without double-counting, and Meta publishes no unique-people figure for arbitrary spans."
                      : "Distinct accounts that saw content at least once — Meta now calls this \u201cviewers\u201d."}
                  />
                  <SortTh
                    label={`Revenue ${sfx}`} colKey="revenue" sort={tableSort} onSort={onSort}
                    title="Approximate earnings for the period, as Meta reports them. Facebook only — Instagram publishes no earnings metric."
                  />
                  <SortTh label="Profile views" colKey="profileViews" sort={tableSort} onSort={onSort} />
                  <SortTh label="Posts" colKey="posts" sort={tableSort} onSort={onSort} pad="px-5" />
                </tr>
              </thead>
              <tbody>
                {sortedChannels.map((c: MetaChannel) => {
                  const open = expanded === c.id;
                  return (
                    <Fragment key={c.id}>
                      <tr onClick={() => setExpanded(open ? null : c.id)}
                        className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8] cursor-pointer">
                        {manageMode && (
                          <td className="pl-4 pr-1 py-2" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${c.name}`}
                              checked={checkedIds.has(c.id)}
                              onChange={(e) => setCheckedIds((cur) => {
                                const next = new Set(cur);
                                if (e.target.checked) next.add(c.id); else next.delete(c.id);
                                return next;
                              })}
                              className="h-3.5 w-3.5 accent-[#5B4BF5]"
                            />
                          </td>
                        )}
                        <td className="px-5 py-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {open ? <ChevronDown className="h-3 w-3 text-[#B0B0B0] shrink-0" />
                                  : <ChevronRight className="h-3 w-3 text-[#B0B0B0] shrink-0" />}
                            <span className={`text-[10px] shrink-0 ${c.platform === "facebook" ? "text-[#1877F2]" : "text-[#C13584]"}`}>
                              {c.platform === "facebook" ? "f" : "ig"}
                            </span>
                            <span className="text-xs font-medium text-[#1A1A1A] truncate max-w-[220px]">{c.name}</span>
                            {c.username && <span className="text-[10px] text-[#B0B0B0] truncate">@{c.username}</span>}
                            {/* Partial-coverage disclosure: this channel's stored daily
                                history spans only part of the selected range, so its sums
                                cover those days only. Bounded text (max 8 chars), so
                                shrink-0 is safe here — the documented trap is shrink-0 on
                                UNBOUNDED text. */}
                            {isRangeMode && c.rangeDays != null && (c.coveredDays ?? 0) < c.rangeDays && (
                              <span
                                title={`Stored history covers ${c.coveredDays ?? 0} of the ${c.rangeDays} days in this range. The missing days predate this channel's daily history, so its figures here are sums over the covered days only.`}
                                className="text-[9px] text-[#C2861D] border border-[#F3D9A4] bg-[#FDF8EC] rounded-full px-1.5 py-px shrink-0"
                              >
                                {c.coveredDays ?? 0}/{c.rangeDays}d
                              </span>
                            )}
                            {/* The mark means "the LATEST refresh attempt failed" — any
                                figures shown are the last successful fetch, which the sync
                                deliberately keeps (upsertWindowMetric writes only
                                {fetchedAt, error} on failure, so prior values survive). Say
                                that, or the triangle reads as "this row's data is wrong",
                                which is the opposite of what it means.
                                ⚠️ It must NOT promise the problem will clear itself. Most of
                                these are Meta's transient (#2), which the sync now retries and
                                which does clear — but a permission failure (the connected
                                account lost admin rights on the Page) is permanent and no
                                number of retries fixes it. Telling that reader "it retries
                                automatically" would send them away from the one action that
                                actually resolves it. So: state the re-attempt, and say what
                                PERSISTENCE means. True in both cases, and true for a window
                                that has never once succeeded — hence "any figures shown". */}
                            {c.metricsError && (
                              <span title={`This channel's most recent ${sfx} refresh failed, so any figures shown are from the last successful sync. The next sync re-attempts it (roughly every 3 hours); if the mark persists across syncs, the connected Meta account has most likely lost admin access to this channel and someone needs to restore it. Meta's reply: ${c.metricsError}`}>
                                <AlertTriangle className="h-3 w-3 text-[#C2861D] shrink-0" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]">
                          {fmtMetric(c.followers)}
                          {/* Only rendered when an API baseline actually spans the period.
                              A 0 here would claim "no growth" when the truth is "no history
                              yet" — so absence stays absent. */}
                          {c.followerDelta !== null && c.followerDelta !== undefined && (
                            <span
                              className={`block font-normal text-[10px] ${
                                c.followerDelta > 0 ? "text-[#3E9B4F]"
                                : c.followerDelta < 0 ? "text-[#C0504D]"
                                : "text-[#B0B0B0]"}`}
                            >
                              {/* ⚠️ Labelled from the delta's OWN span, not from the
                                  selected window. Most channels' API follower history
                                  starts later than a 28-day window reaches, so this
                                  row may genuinely be a 5-day change — saying "28d"
                                  would understate growth while sounding authoritative.
                                  Falls back to the window only if the API omits the
                                  span (an older response). */}
                              {c.followerDelta > 0 ? "+" : ""}{fmtMetric(c.followerDelta)} ·{" "}
                              {c.followerDeltaDays == null
                                ? sfx
                                : c.followerDeltaDays === 1
                                  ? "24h"
                                  : `${c.followerDeltaDays}d`}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.views28d)}</td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.engagements28d)}</td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.reach28d)}</td>
                        <td className="px-2 py-2 text-right text-xs">
                          {hideRevenue ? <span className="text-[#B0B0B0]">•••</span> : fmtMoney(c.earningsCents)}
                        </td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.profileViews28d)}</td>
                        <td className="px-5 py-2 text-right text-xs text-[#7A7A7A]">{fmtMetric(c.posts)}</td>
                      </tr>
                      {open && (
                        <tr>
                          {/* ⚠️ colSpan tracks the DYNAMIC column count — Manage adds a
                              checkbox column, and a stale colSpan silently misaligns
                              every cell below it (the documented drill-down trap). */}
                          <td colSpan={manageMode ? 9 : 8} className="p-0">
                            <ChannelExtras c={c} sfx={sfx} />
                            <ChannelAudience assetId={c.id} />
                            <ChannelPosts assetId={c.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {live.length > 0 && (
        <p className="px-5 py-3 text-[11px] text-[#B0B0B0] leading-snug border-t border-[#F0EAE0]">
          Figures cover the selected period and come straight from Meta — every channel here
          is one the connected account administers, so nothing on this page is scraped or
          hand-entered. Views and reach use Meta&apos;s current metrics, which replaced
          impressions when Meta retired that family across the API. A dash means Meta
          publishes no value for that metric on that platform — not a zero and not missing
          data. Profile views mean Page views on Facebook and profile visits on Instagram.
          <strong className="font-medium text-[#7A7A7A]">Views</strong> counts how many
          times content was shown or played, including repeat views by the same person.
          <strong className="font-medium text-[#7A7A7A]"> Reach</strong> counts how many
          distinct accounts saw it at least once — Meta&apos;s own name for it is now
          &ldquo;viewers&rdquo;. So views is normally the larger of the two, and the gap
          widens over a longer period because the same person sees more posts.
          <strong className="font-medium text-[#7A7A7A]"> Followers</strong> is a live
          total and does not move with the period; the small figure beneath it is the change
          across the selected one. Facebook reports its true daily follower count, so that
          change is measured directly. Instagram publishes no such history — its change is
          Meta&apos;s own follows-minus-unfollows for the period, which is very close but not
          identical, and is unavailable over 24 hours.
          {ch?.dataThrough && (
            <>
              <strong className="font-medium text-[#7A7A7A]">Figures run through{" "}
              {new Date(ch.dataThrough).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</strong>
              . Facebook only publishes complete days, so a period fetched today still ends at
              the Page&apos;s last local midnight. Meta&apos;s own app adds today so far, which is
              why its numbers read slightly higher — the same window, one day further on, not a
              different measurement.{" "}
            </>
          )}
          Click a channel to see its recent posts.{" "}
          <strong className="font-medium text-[#7A7A7A]">Periods:</strong>{" "}
          <strong className="font-medium text-[#7A7A7A]">Today (so far)</strong> is
          Instagram-only and refreshed every few hours — Facebook&apos;s API publishes only
          completed days, so its cells show dashes there and its today appears tomorrow
          under Yesterday. Yesterday / 7d / 28d are Meta&apos;s own live windows (the only
          ones it measures directly). Months and
          custom ranges are exact sums of stored per-day history — precise for views,
          engagements, profile views and revenue, which add up day by day. Reach is the
          exception on those: it counts unique people, days cannot be added without
          double-counting repeat visitors, and Meta publishes no unique-people figure for an
          arbitrary span — so a custom range honestly shows a dash instead. Daily history
          reaches back as far as Meta serves it (about two years for Facebook, about a year
          for Instagram, less for newer metrics); channels whose history covers only part of
          a selected range carry a coverage chip saying exactly how much.
        </p>
      )}
    </section>
  );
}
