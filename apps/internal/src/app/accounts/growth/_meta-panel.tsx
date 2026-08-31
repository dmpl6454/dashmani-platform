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

import { Fragment, useEffect, useState } from "react";
import {
  RefreshCw, Link2, Unlink, AlertTriangle, ExternalLink, Loader2, ChevronDown, ChevronRight,
  Eye, EyeOff, Download,
} from "lucide-react";
import {
  useMetaConnections, useMetaChannels, useMetaPosts,
  startMetaConnect, triggerMetaDiscovery, triggerMetaSync, disconnectMeta,
  fmtMetric, fmtMoney, fmtWatchTime, useMetaDemographics, CHANNEL_WINDOWS, windowSuffix, type MetaChannel, type MetaConnection, type ChannelWindowKey,
} from "@/lib/hooks/use-meta";

type SortKey = "followers" | "views" | "engagements" | "name";

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

export function MetaPanel() {
  const { data: conns, isLoading: connLoading, mutate: mutateConns } = useMetaConnections();
  const [platform, setPlatform] = useState<"all" | "facebook" | "instagram">("all");
  const [sort, setSort] = useState<SortKey>("followers");
  const [q, setQ] = useState("");
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
    const header = [
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
    const rows = channels.map((c) => [
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
    ]);

    // \uFEFF so Excel opens UTF-8 correctly — without it channel names with
    // non-Latin characters render as mojibake.
    const csv = "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const parts = [
      "meta-channels", sfx,
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
    sort,
    window: win,
  });

  // Label every windowed figure from the window the SERVER says it returned, not
  // from local state — mid-fetch those disagree, and a "24h" heading over 28-day
  // numbers is exactly the kind of confident-but-wrong labelling this page exists
  // to avoid.
  const sfx = windowSuffix(ch?.window ?? win);

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
            { label: "Followers", value: t.followers, raw: false, note: null },
            { label: `Views · ${sfx}`, value: t.views, raw: false,
              note: contrib && contrib.views < ch!.channelCount ? `${contrib.views}/${ch!.channelCount} channels reporting` : null },
            { label: `Engagements · ${sfx}`, value: t.engagements, raw: false,
              note: contrib && contrib.engagements < ch!.channelCount ? `${contrib.engagements}/${ch!.channelCount} reporting` : null },
            { label: `Revenue · ${sfx}`, value: t.earningsCents, raw: false, money: true,
              note: contrib ? `${contrib.earnings} channel(s) earning · Facebook only` : null },
          ].map((s) => (
            <div
              key={s.label}
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
              {/* Say what a total does NOT cover, rather than implying completeness. */}
              {s.note && <p className="mt-0.5 text-[10px] text-[#B0B0B0] leading-tight">{s.note}</p>}
            </div>
          ))}
        </div>
      )}

      {live.length > 0 && (
        <div className="px-5 py-2.5 border-b border-[#F0EAE0] flex flex-wrap items-center gap-2">
          <div
            className="flex items-center gap-1 mr-1"
            role="group"
            aria-label="Time window for views, reach and engagement"
          >
            <span className="text-[11px] text-[#B0B0B0] mr-0.5">Period</span>
            {CHANNEL_WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => setWin(w.key)}
                aria-pressed={win === w.key}
                className={`text-[11px] rounded-full px-2.5 py-1 border ${
                  win === w.key
                    ? "bg-[#5B4BF5] text-white border-[#5B4BF5]"
                    : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
              >
                {w.label}
              </button>
            ))}
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
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
            className="text-[11px] border border-[#DCDCDC] rounded-full px-2 py-1 bg-white">
            <option value="followers">Sort: Followers</option>
            <option value="views">Sort: Views</option>
            <option value="engagements">Sort: Engagements</option>
            <option value="name">Sort: Name</option>
          </select>
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

      {live.length > 0 && (
        <div className="overflow-x-auto">
          {channels.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[#7A7A7A]">
              {ch ? "No channels match that filter." : "Waiting for your channels to be discovered…"}
            </p>
          ) : (
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
                  <th className="text-left font-medium px-5 py-2">Channel</th>
                  <th
                    className="text-right font-medium px-2 py-2"
                    title="A live total, not a period figure — how many followers the channel has right now. The period filter drives Views, Engagements and Reach."
                  >
                    Followers <span className="text-[#B0B0B0] font-normal">(now)</span>
                  </th>
                  <th className="text-right font-medium px-2 py-2">Views {sfx}</th>
                  <th className="text-right font-medium px-2 py-2">Engagements {sfx}</th>
                  <th className="text-right font-medium px-2 py-2">Reach {sfx}</th>
                  <th
                    className="text-right font-medium px-2 py-2"
                    title="Approximate earnings for the period, as Meta reports them. Facebook only — Instagram publishes no earnings metric."
                  >
                    Revenue {sfx}
                  </th>
                  <th className="text-right font-medium px-2 py-2">Profile views</th>
                  <th className="text-right font-medium px-5 py-2">Posts</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c: MetaChannel) => {
                  const open = expanded === c.id;
                  return (
                    <Fragment key={c.id}>
                      <tr onClick={() => setExpanded(open ? null : c.id)}
                        className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8] cursor-pointer">
                        <td className="px-5 py-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {open ? <ChevronDown className="h-3 w-3 text-[#B0B0B0] shrink-0" />
                                  : <ChevronRight className="h-3 w-3 text-[#B0B0B0] shrink-0" />}
                            <span className={`text-[10px] shrink-0 ${c.platform === "facebook" ? "text-[#1877F2]" : "text-[#C13584]"}`}>
                              {c.platform === "facebook" ? "f" : "ig"}
                            </span>
                            <span className="text-xs font-medium text-[#1A1A1A] truncate max-w-[220px]">{c.name}</span>
                            {c.username && <span className="text-[10px] text-[#B0B0B0] truncate">@{c.username}</span>}
                            {c.metricsError && (
                              <span title={c.metricsError}><AlertTriangle className="h-3 w-3 text-[#C2861D] shrink-0" /></span>
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
                              {c.followerDelta > 0 ? "+" : ""}{fmtMetric(c.followerDelta)} · {sfx}
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
                          <td colSpan={8} className="p-0">
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
          Click a channel to see its recent posts. 24h / 7d / 28d are the only periods
          offered because they are the only ones Meta measures directly — Instagram
          refuses any range over 30 days, and a longer one cannot be added up from
          shorter ones without double-counting reach, which counts unique people.
        </p>
      )}
    </section>
  );
}
