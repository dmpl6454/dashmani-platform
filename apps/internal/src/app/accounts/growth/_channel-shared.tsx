"use client";

/**
 * Shared chrome for the YouTube and Snapchat boards on Account Growth.
 *
 * ⚠️ WHY A SHELL RATHER THAN TWO COPIES. The two boards differ only in their columns and
 * in what each platform refuses to publish; everything around the table — the period
 * pills, the totals strip, Manage mode, the removed-channels list, the error surface — is
 * the same job twice. Two copies would drift, and the first thing to drift is the honesty
 * wording, which is the part that must not. The shell owns all of it and hands each panel
 * the filtered rows to render however its columns need.
 *
 * ⚠️ Every panel built on this must keep a null rendering as an em-dash, never 0. A "0
 * followers" reads as a fact about the channel when the truth is that the platform
 * publishes no number for it — the documented fabricated-zero class.
 */

import { useState, type ReactNode } from "react";
import { AlertTriangle, ExternalLink, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  useChannelBoard, useRemovedChannels, addChannel, setChannelActive,
  CHANNEL_PERIODS,
  type ChannelBoard, type ChannelPeriod, type ChannelPlatform, type ChannelRow,
} from "@/lib/hooks/use-channels";
// ⚠️ Imported, not re-implemented. fmtMetric already has several independent copies
// across this repo and they have drifted before (one of them rendered a genuinely-absent
// metric as "0"); this is the canonical one and an eighth copy helps nobody.
import { fmtMetric } from "@/lib/hooks/use-meta";

export { fmtMetric };

/**
 * Exact integer with thousands separators. Used where the figure IS exact and the
 * precision is the point — YouTube's lifetime view counter, video counts, channel counts.
 * fmtMetric's "4.6m" is right for a headline and wrong when someone is checking a number.
 */
export function fmtExact(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString();
}

/** A signed change, or "—" when there is nothing measured to show. */
export function fmtDelta(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmtMetric(n)}`;
}

/**
 * A rounding step as a short label: 100000 -> "100k", 1000000 -> "1m".
 *
 * Deliberately not fmtMetric, which would render "100.0k" — a step is an exact round
 * number and the trailing ".0" makes it look measured rather than definitional.
 */
export function fmtStep(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${n / 1_000_000}m`;
  if (n >= 1_000) return `${n / 1_000}k`;
  return String(n);
}

/** Short relative time: "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(isoString: string | null | undefined): string {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Only ever hand an href to the browser if it is actually a web URL. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/** ~2 days, matching the freshness window the growth overview has always used. */
const LIVE_WITHIN_MS = 48 * 60 * 60 * 1000;

/**
 * Sync freshness. Derived here rather than sent by the API, because the API returns the
 * raw `lastSyncedAt` and "how old is too old" is a presentation judgement.
 *
 * ⚠️ This is a raw duration diff, NOT the IST date key. A freshness window is a length of
 * time, not a calendar day — an 11pm sync is not stale at midnight.
 */
export function SyncBadge({
  lastSyncedAt,
  metricsFetchedAt,
}: {
  lastSyncedAt: string | null | undefined;
  /**
   * ⚠️ Load-bearing for Snapchat. `lastSyncedAt` only moves when a real FOLLOWER COUNT was
   * measured, and seven profiles withhold theirs — we fetch them successfully every cycle
   * and have no number to stamp. Without this fallback those channels render "Manual",
   * which tells the reader the figure was typed in by hand. It was not; there is no figure.
   */
  metricsFetchedAt?: string | null;
}) {
  const stamp = lastSyncedAt ?? metricsFetchedAt ?? null;
  const measured = Boolean(lastSyncedAt);
  const ago = relativeTime(stamp);
  const age = stamp ? Date.now() - new Date(stamp).getTime() : null;
  const state = age === null ? "MANUAL" : age <= LIVE_WITHIN_MS ? "LIVE" : "STALE";

  const map = {
    LIVE: {
      dot: "bg-[#3E9B4F]", cls: "text-[#3E9B4F] border-[#C6E8CB]",
      label: ago ? `Live · ${ago}` : "Live",
      title: measured
        ? "Live — collected automatically from the platform within the last two days."
        : "Live — we checked this profile within the last two days. The platform published no follower count for it, which is why that column shows a dash.",
    },
    STALE: {
      dot: "bg-[#C2861D]", cls: "text-[#C2861D] border-[#F3D9A4]",
      label: ago ? `Stale · ${ago}` : "Stale",
      title: "Stale — the last successful collection was more than two days ago, so this figure may have moved since.",
    },
    MANUAL: {
      dot: "bg-[#7A7A7A]", cls: "text-[#7A7A7A] border-[#DCDCDC]",
      label: "Manual",
      title: "Manual — never collected automatically, so this figure is whatever was entered by hand.",
    },
  }[state];

  return (
    <span
      title={map.title}
      className={`inline-flex items-center gap-1 text-[10px] font-medium border rounded-full px-1.5 py-0.5 leading-none whitespace-nowrap ${map.cls}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${map.dot}`} />
      {map.label}
    </span>
  );
}

/**
 * WHERE the number came from — a separate axis from SyncBadge's freshness. A scraped
 * figure can be perfectly fresh and still be best-effort, and the reader deserves both
 * facts.
 *
 * Deliberately a soft FILLED chip while SyncBadge is an OUTLINED one: two pills with the
 * same silhouette sitting side by side read as one control with two halves.
 */
export function SourceBadge({ source }: { source: string | null | undefined }) {
  if (source !== "api" && source !== "scraper") return null;
  const isApi = source === "api";
  return (
    <span
      title={isApi
        ? "API — read from the platform's official API. Exact figure."
        : "Scraper — parsed from the channel's public page because no API covers it. Accurate in practice, but best-effort: the platform can change the page and withhold a figure at any time."}
      className={`inline-flex items-center text-[10px] font-medium border rounded-full px-1.5 py-0.5 leading-none whitespace-nowrap ${
        isApi
          ? "bg-[#EAF0FB] text-[#2F5FAE] border-[#CBDCF5]"
          : "bg-[#F3EEF8] text-[#6B4E9B] border-[#DFD2EC]"}`}
    >
      {isApi ? "API" : "Scraper"}
    </span>
  );
}

/**
 * The last collection attempt failed.
 *
 * ⚠️ The mark means "the LATEST attempt failed", not "this row is wrong" — whatever
 * figures are shown are the last good ones. And it must not promise the problem clears
 * itself: a renamed or deleted channel never resolves without someone fixing the handle.
 */
export function ErrorMark({ message }: { message: string }) {
  return (
    <span title={`The most recent collection for this channel failed, so any figures shown are from the last successful one. It is re-attempted on the next run; if the mark persists, the handle has most likely changed or the channel is gone, and someone needs to fix it here. The platform's reply: ${message}`}>
      <AlertTriangle className="h-3 w-3 text-[#C2861D] shrink-0" />
    </span>
  );
}

export type SortDir = "asc" | "desc";

/**
 * One comparison for a sortable column.
 *
 * ⚠️ NULLS SORT LAST IN BOTH DIRECTIONS. A channel the platform has not published a
 * figure for must never outrank one it has, and an ascending sort that opens with a wall
 * of dashes reads as broken. This is the repo-wide convention.
 */
export function compareCells(
  av: number | string | null,
  bv: number | string | null,
  dir: SortDir,
): number {
  if (typeof av === "string" || typeof bv === "string") {
    const a = String(av ?? ""), b = String(bv ?? "");
    return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
  }
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return dir === "asc" ? av - bv : bv - av;
}

/** Clickable, direction-toggling column header. Generic over each panel's column keys. */
export function SortTh<K extends string>({
  label, colKey, sort, onSort, align = "right", pad = "px-2", title,
}: {
  label: ReactNode;
  colKey: K;
  sort: { key: K; dir: SortDir };
  onSort: (k: K) => void;
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
        {/* Fixed-width slot so headers do not shift as the arrow moves between columns. */}
        <span className="inline-block w-2.5 text-[9px] leading-none text-[#5B4BF5]">
          {active ? (sort.dir === "desc" ? "▼" : "▲") : ""}
        </span>
      </button>
    </th>
  );
}

/**
 * A column that carries real data but deliberately cannot be sorted, rendered so it is
 * visibly a plain header rather than a sort control someone will keep clicking.
 */
export function PlainTh({ label, title, pad = "px-2", align = "right" }: {
  label: ReactNode; title?: string; pad?: string; align?: "left" | "right";
}) {
  return (
    <th className={`${align === "left" ? "text-left" : "text-right"} font-medium ${pad} py-2`} title={title}>
      {label}
      {/* Same fixed-width slot as SortTh, kept empty, so a mixed header row stays aligned. */}
      <span className="inline-block w-2.5" />
    </th>
  );
}

/** The channel's own page, opened in a new tab. Nothing rendered when there is no URL. */
export function ChannelLink({ url, name }: { url: string | null | undefined; name: string }) {
  const href = safeHref(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${name}`}
      aria-label={`Open ${name}`}
      // Bounded 12px icon, so shrink-0 is safe here — the documented trap is shrink-0 on
      // UNBOUNDED text, which can never wrap and therefore overflows its container.
      className="shrink-0 text-[#C4C4C4] hover:text-[#5B4BF5] transition-colors"
    >
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/** An extra totals tile whose meaning is platform-specific. */
export interface ExtraTotal {
  label: string;
  value: number | null;
  /** true renders the value as an exact integer rather than a compact "4.6m". */
  raw?: boolean;
  note?: string | null;
  title?: string;
}

interface ShellChildContext {
  rows: ChannelRow[];
  manageMode: boolean;
  /** Remove a channel from the board. Confirms first; a soft flag, never a delete. */
  onRemove: (row: ChannelRow) => void;
  busy: string | null;
}

export function ChannelBoardShell({
  platform, title, subtitle, sourceNote,
  followerNoun, addPlaceholder, addHint, followersAbsentNote,
  extraTotal, columnNote, footnote, children,
}: {
  platform: ChannelPlatform;
  title: string;
  subtitle: string;
  /** Where these numbers come from, stated on the board itself, not only in the footnote. */
  sourceNote: ReactNode;
  /** "subscribers" or "followers" — the word this platform uses. */
  followerNoun: string;
  addPlaceholder: string;
  addHint: string;
  /** Shown after an add whose follower count the platform withheld. */
  followersAbsentNote: string;
  extraTotal: (board: ChannelBoard) => ExtraTotal;
  /**
   * The caveat that belongs beside the columns rather than in the footnote — which
   * column can be trusted for growth, and why another one shows dashes.
   *
   * ⚠️ Rendered OUTSIDE the horizontal scroll container. Put prose inside it and the
   * table's min-width stretches the paragraph to ~820px, so on a phone the explanation
   * can only be read by scrolling sideways.
   */
  columnNote?: ReactNode;
  footnote: ReactNode;
  children: (ctx: ShellChildContext) => ReactNode;
}) {
  const [days, setDays] = useState<ChannelPeriod>(30);
  const [q, setQ] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [addHandle, setAddHandle] = useState("");
  const [added, setAdded] = useState<{ name: string; followers: number | null; restored: boolean } | null>(null);

  const { data: board, error: loadError, isLoading, mutate } = useChannelBoard(platform, days);
  const { data: removed, mutate: mutateRemoved } = useRemovedChannels(platform, showRemoved);

  const allRows = board?.rows ?? [];
  // Search is client-side on purpose: the endpoint takes only platform and days, the
  // estate is a few dozen channels, and filtering here means the table and any future
  // export are guaranteed to agree because they read the same array.
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? allRows.filter((r) =>
        r.displayName.toLowerCase().includes(needle) || r.handle.toLowerCase().includes(needle))
    : allRows;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const handle = addHandle.trim();
    if (!handle || busy) return;
    setErr(null); setAdded(null); setBusy("add");
    try {
      const res = await addChannel(platform, handle);
      setAdded({
        name: res.displayName || res.handle,
        followers: res.followers,
        restored: res.restored,
      });
      setAddHandle("");
      await Promise.all([mutate(), mutateRemoved()]);
    } catch (e2) {
      // ⚠️ Surfaced verbatim. The API answers a bad handle with a human sentence naming
      // exactly what to paste instead; replacing it with "could not add that channel"
      // throws away the only thing that tells the admin how to fix it.
      setErr(e2 instanceof Error ? e2.message : "Could not add that channel.");
    } finally { setBusy(null); }
  }

  async function setActive(row: { id: string; displayName?: string; handle: string }, active: boolean) {
    if (busy) return;
    if (!active && !window.confirm(
      `Remove ${row.displayName || row.handle} from this board?\n\nIt stops being collected and drops out of every figure here. Its history is kept and you can restore it anytime under "Removed channels".`,
    )) return;
    setErr(null); setAdded(null); setBusy(active ? `restore-${row.id}` : `remove-${row.id}`);
    try {
      await setChannelActive(row.id, active);
      await Promise.all([mutate(), mutateRemoved()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That change did not go through.");
    } finally { setBusy(null); }
  }

  const t = board?.totals;
  const extra = board ? extraTotal(board) : null;

  return (
    <section className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#F0EAE0]">
        <h2 className="font-serif text-lg text-[#1A1A1A]">{title}</h2>
        <p className="text-xs text-[#7A7A7A] mt-0.5">{subtitle}</p>
        <p className="text-[11px] text-[#B0B0B0] mt-1 leading-snug max-w-3xl">{sourceNote}</p>
      </div>

      {err && (
        <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-[#C0504D] bg-[#FDF1F1] border border-[#F3C7C6] rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="min-w-0">{err}</span>
        </div>
      )}

      {loadError && (
        <p className="px-5 py-8 text-center text-xs text-[#C0504D]">
          This board could not be loaded. Your submitted channels are safe — this is a loading
          problem, not a data problem.{" "}
          <button onClick={() => void mutate()} className="underline hover:text-[#1A1A1A]">Retry</button>
        </p>
      )}

      {t && extra && (
        // 3 tiles: one column on a phone, three from `sm`. ⚠️ Never two — with three
        // tiles a two-column grid orphans the last one onto a row of its own, which is
        // exactly what had to be fixed on the Meta board.
        <div className="px-5 py-5 grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-5 border-b border-[#F0EAE0]">
          {[
            { label: "Channels", value: t.channels, raw: true, note: null as string | null, title: undefined as string | undefined },
            {
              // ⚠️ "(now)" is load-bearing. Followers is a STOCK — how many right now —
              // so the headline is window-invariant BY DEFINITION and reads the same on
              // every period. That has been reported as faulty data twice on the Meta
              // board, so the label, the tooltip and the note all say so.
              label: `${followerNoun[0].toUpperCase()}${followerNoun.slice(1)} (now)`,
              value: t.followers, raw: false,
              title: `A live total, not a period figure — how many ${followerNoun} these channels have right now, so it reads the same on every period by design. Movement over the selected period is the per-channel change column in the table.`,
              note: t.followersWithheld > 0
                ? `${t.followersReported} of ${t.channels} published a count · ${t.followersWithheld} withheld`
                : `${t.followersReported} of ${t.channels} published a count`,
            },
            { label: extra.label, value: extra.value, raw: extra.raw ?? false, note: extra.note ?? null, title: extra.title },
          ].map((s, i) => (
            <div
              key={s.label}
              title={s.title}
              // Hairline between tiles only where all three are guaranteed to share a
              // row — at phone width the grid stacks and a leading border would land
              // mid-column and read as a bug.
              className={`min-w-0 sm:border-l sm:border-[#F0EAE0] sm:pl-4 ${i === 0 ? "sm:border-l-0 sm:pl-0" : ""}`}
            >
              <p
                // ⚠️ clamp, not a fixed size, and the coefficient is deliberately small:
                // `vw` is the WINDOW and the portal sidebar takes ~340px of it, so a
                // generous coefficient ellipsises at 1024px inside a narrow tile.
                className="font-num text-[clamp(1.5rem,2.2vw,2rem)] font-semibold tracking-tight leading-none text-[#1A1A1A] truncate"
              >
                {s.raw ? fmtExact(s.value) : fmtMetric(s.value)}
              </p>
              <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8A8A8A] truncate">
                {s.label}
              </p>
              {s.note && <p className="mt-0.5 text-[10px] leading-tight text-[#B0B0B0]">{s.note}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="px-5 py-2.5 border-b border-[#F0EAE0] flex flex-wrap items-center gap-2">
        {/* ⚠️ Each board owns its own period. They are not hoisted onto the page,
            because the Meta tab's windows are Meta's own (which it can answer at all)
            while these are day counts over our stored snapshots — the same "30" would
            mean two different things. */}
        <div className="flex flex-wrap items-center gap-1 mr-1" role="group" aria-label="Reporting period">
          <span className="text-[11px] text-[#B0B0B0] mr-0.5">Period</span>
          {CHANNEL_PERIODS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={`text-[11px] rounded-full px-2.5 py-1 border ${
                days === d
                  ? "bg-[#5B4BF5] text-white border-[#5B4BF5]"
                  : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
            >
              {d}d
            </button>
          ))}
        </div>
        <span className="hidden sm:block h-4 w-px bg-[#E8E0D0]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search channels…"
          // ⚠️ 16px on phones. iOS Safari auto-zooms into any focused input below that
          // and then pans the viewport, which is how controls end up off-screen.
          className="text-[16px] sm:text-[11px] border border-[#DCDCDC] rounded-full px-3 py-1 w-40 focus:outline-none focus:border-[#B0B0B0]"
        />
        <button
          onClick={() => { setManageMode((v) => !v); setAdded(null); setErr(null); }}
          aria-pressed={manageMode}
          title="Add a channel to this board, or remove one. Removing stops collection and hides it from every figure here; it can be restored anytime."
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
        <span className="text-[11px] text-[#B0B0B0] ml-auto">
          {rows.length} channel(s)
          {needle && allRows.length !== rows.length && (
            <span className="text-[#B0B0B0]"> of {allRows.length}</span>
          )}
        </span>
      </div>

      {manageMode && (
        <div className="px-5 py-3 border-b border-[#F0EAE0] bg-[#FDF8EC]">
          <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-2">
            <input
              value={addHandle}
              onChange={(e) => setAddHandle(e.target.value)}
              placeholder={addPlaceholder}
              aria-label="Channel handle to add"
              disabled={busy !== null}
              // 16px on phones for the same iOS reason as the search box above.
              className="text-[16px] sm:text-[12px] border border-[#DCDCDC] rounded-lg px-3 py-1.5 w-full sm:w-72 bg-white focus:outline-none focus:border-[#B0B0B0] disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!addHandle.trim() || busy !== null}
              className="inline-flex items-center gap-1 text-[12px] font-medium rounded-full px-3 py-1.5 bg-[#5B4BF5] text-white disabled:opacity-40"
            >
              {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {busy === "add" ? "Looking it up…" : "Add channel"}
            </button>
            <span className="basis-full sm:basis-auto text-[10px] text-[#B0B0B0] leading-snug">{addHint}</span>
          </form>

          {/* ⚠️ Say WHAT was resolved, not just "added". A handle that resolves proves a
              channel exists, not that it is the right one — showing the name and count
              back is what makes a wrong channel visible immediately instead of silently
              sitting on the board. */}
          {added && (
            <p className="mt-2 text-[11px] text-[#3E9B4F] leading-snug">
              {added.restored ? "Restored" : "Added"}{" "}
              <strong className="font-medium">{added.name}</strong>
              {added.followers !== null
                ? <> — {fmtMetric(added.followers)} {followerNoun}. Check that is the channel you meant.</>
                : <> — {followersAbsentNote}</>}
            </p>
          )}
        </div>
      )}

      {showRemoved && (
        <div className="px-5 py-3 border-b border-[#F0EAE0] bg-[#FCFBF8]">
          <p className="text-xs font-medium text-[#1A1A1A] mb-1.5">
            Removed channels{removed ? ` (${removed.rows.length})` : ""}
          </p>
          {!removed ? (
            <p className="text-[11px] text-[#B0B0B0]">Loading…</p>
          ) : removed.rows.length === 0 ? (
            <p className="text-[11px] text-[#B0B0B0]">
              Nothing here — removing a channel (via Manage) hides it from every figure on this
              board and stops collecting it, without deleting its history.
            </p>
          ) : (
            <ul className="space-y-1">
              {removed.rows.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-xs">
                  <span className="truncate max-w-[260px] text-[#1A1A1A]">{r.displayName || r.handle}</span>
                  <span className="text-[10px] text-[#B0B0B0] shrink-0">{fmtMetric(r.followerCount)} {followerNoun}</span>
                  <button
                    disabled={busy !== null}
                    onClick={() => void setActive(r, true)}
                    className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#5B4BF5] hover:underline disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {busy === `restore-${r.id}` ? "Restoring…" : "Restore"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ⚠️ An empty change column with no explanation reads as "nothing grew". When no
          channel yet has history spanning the window, say so and say since when — the
          figures are not missing, they are still being collected. */}
      {board && board.totals.withHistory === 0 && board.totals.channels > 0 && (
        <div className="px-5 py-2 border-b border-[#F6F2EA] text-[10px] text-[#7A7A7A] leading-snug">
          {/* ⚠️ `board.days`, the period the SERVER echoed — never the local `days` state.
              Mid-fetch the two disagree, and this is the only sentence on the board that
              names a period, so it is the only place that could mislabel one. */}
          No channel has {board.days} days of history yet, so every change reads as a dash.
          {board.historyFrom
            ? <> We have been collecting since{" "}
                <strong className="font-medium text-[#5A5A5A]">
                  {new Date(`${board.historyFrom.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}
                </strong>, so the shorter periods fill in first.</>
            : <> Collection has only just started — the shorter periods fill in first.</>}
        </div>
      )}

      {columnNote && board && rows.length > 0 && (
        <p className="px-5 py-2 border-b border-[#F6F2EA] text-[10px] text-[#7A7A7A] leading-snug">
          {columnNote}
        </p>
      )}

      <div className="overflow-x-auto">
        {isLoading && !board ? (
          <p className="px-5 py-8 text-center text-xs text-[#7A7A7A]">Loading channels…</p>
        ) : !board ? null : rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-xs text-[#7A7A7A]">
            {allRows.length === 0
              ? "No channels on this board yet — use Manage to add one."
              : "No channels match that search."}
          </p>
        ) : (
          children({ rows, manageMode, onRemove: (row) => void setActive(row, false), busy })
        )}
      </div>

      <p className="px-5 py-3 text-[11px] text-[#B0B0B0] leading-snug border-t border-[#F0EAE0]">
        {footnote}
      </p>
    </section>
  );
}

/** The trailing Remove cell, shown only in Manage mode. Shared so both boards match. */
export function RemoveCell({ row, busy, onRemove }: {
  row: ChannelRow; busy: string | null; onRemove: (row: ChannelRow) => void;
}) {
  return (
    <td className="px-5 py-2 text-right">
      <button
        onClick={() => onRemove(row)}
        disabled={busy !== null}
        title={`Remove ${row.displayName || row.handle} from this board`}
        aria-label={`Remove ${row.displayName || row.handle} from this board`}
        className="inline-flex items-center gap-1 text-[11px] text-[#C0504D] hover:underline disabled:opacity-40"
      >
        <Trash2 className="h-3 w-3" />
        {busy === `remove-${row.id}` ? "Removing…" : "Remove"}
      </button>
    </td>
  );
}
