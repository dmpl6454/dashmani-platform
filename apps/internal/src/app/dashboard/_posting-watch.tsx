// apps/internal/src/app/dashboard/_posting-watch.tsx
// "Posting watch" — assigned channels whose connected Facebook Page / Instagram account
// has gone 2h+ without a new post between 07:00 and 23:00 IST. Admin-only (the page
// decides; this component assumes it is allowed to fetch).
//
// ⚠️ Its own component on purpose: the 30-second clock below re-renders only this card,
// not the 1,000-line dashboard with its charts. And it sits inside its own error boundary,
// because apps/internal has no error.tsx — a render fault here would otherwise blank the
// whole dashboard, which is every internal user's landing page.
"use client";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, BellRing, ExternalLink, Moon, RefreshCw, Search } from "lucide-react";
import {
  usePostingWatch,
  type PostingWatchChannel,
  type PostingWatchErrorKind,
  type PostingWatchGroup,
  type PostingWatchNotConnected,
  type PostingWatchPayload,
  type PostingWatchPerson,
} from "@/lib/hooks/use-posting-watch";
// ── Dark ("ds") pieces — styling only, matching the dashboard mockup ─────────────

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
/** Accent per status tab: amber for silence, red for access trouble, slate for not connected. */
const TAB_ACCENT: Record<"quiet_today" | "no_post_today" | "inactive" | "cant_check" | "not_connected", string> = {
  quiet_today: "#E9BD62",
  no_post_today: "#F0803C",
  inactive: "#9B7EDE",
  cant_check: "#E52D47",
  not_connected: "#6EB2FF",
};

function StatusTab({ active, accent, label, count, onClick }: { active: boolean; accent: string; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="group inline-flex items-center gap-2 h-[34px] pl-3.5 pr-2 rounded-full border text-[12px] font-semibold whitespace-nowrap transition-colors"
      style={
        active
          ? { borderColor: rgba(accent, 0.55), background: rgba(accent, 0.12), color: accent }
          : { borderColor: "#223543", background: "#0B1720", color: "#A7B3C2" }
      }
    >
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: count > 0 ? accent : "#3A4E5E" }} aria-hidden="true" />
      {label}
      <span
        className="font-num min-w-[22px] h-[20px] px-1.5 grid place-items-center rounded-full text-[11px] font-bold"
        style={active ? { background: rgba(accent, 0.2), color: accent } : { background: "#132430", color: count > 0 ? "#F4F6F8" : "#738395" }}
      >
        {count}
      </span>
    </button>
  );
}

function Seg<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="inline-flex items-center p-[3px] rounded-full border border-ds-line bg-ds-inset" role="group">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`h-[26px] px-3.5 rounded-full text-[11.5px] font-semibold transition-colors ${
            value === o.key ? "bg-ds-gold text-[#060D14]" : "text-ds-t2 hover:text-ds-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Time, always in IST (the business window is IST, whatever the viewer's clock) ──

const IST_OFFSET_MS = 330 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A channel past its deadline is confirmed within a minute or two; this much later means
 *  the checks are behind. */
const LATE_AFTER_MS = 10 * MINUTE;

function clockFromMinutes(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function istClock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return clockFromMinutes(d.getUTCHours() * 60 + d.getUTCMinutes());
}

const istDay = (ms: number): number => Math.floor((ms + IST_OFFSET_MS) / DAY);

/** "8:01 AM" today, "yesterday 10:42 PM", otherwise "Mon 28 Sep, 10:42 PM". */
function istWhen(ms: number, nowMs: number): string {
  const diff = istDay(nowMs) - istDay(ms);
  if (diff === 0) return istClock(ms);
  if (diff === 1) return `yesterday ${istClock(ms)}`;
  const d = new Date(ms + IST_OFFSET_MS);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}, ${istClock(ms)}`;
}

/** FLOORED: 1h59m reads "1h 59m", never "2h" — a rounded figure would contradict the rule. */
function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MINUTE));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MINUTE);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** The gap threshold is configurable on the server, so the copy reads it from the payload. */
function gapText(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

// ── Copy ─────────────────────────────────────────────────────────────────────────

type Tab = PostingWatchGroup | "not_connected";
type PlatformFilter = "all" | "facebook" | "instagram";
const TAB_ORDER: Tab[] = ["quiet_today", "no_post_today", "inactive", "cant_check", "not_connected"];
const SILENT_TABS: ReadonlySet<Tab> = new Set<Tab>(["quiet_today", "no_post_today", "inactive"]);
/** Fixed only by a human (reconnect / restore Page access). The rest Meta recovers from. */
const NEEDS_A_HUMAN: ReadonlySet<PostingWatchErrorKind> = new Set<PostingWatchErrorKind>(["token", "permission", "not_found"]);

function tabLabel(tab: Tab): string {
  switch (tab) {
    case "quiet_today":
      return "Went quiet";
    case "no_post_today":
      return "No post today";
    case "inactive":
      return "Inactive 7d+";
    case "cant_check":
      return "Can't check";
    case "not_connected":
      return "Not connected";
  }
}

/** What is wrong with the channels in "Can't check": access, Meta itself, or both. */
type CantCheckCause = "access" | "meta" | "mixed";

function tabHint(tab: Tab, startLabel: string, gap: string, cause: CantCheckCause | null): string {
  switch (tab) {
    case "quiet_today":
      return `Posted earlier today, then nothing for ${gap} or more.`;
    case "no_post_today":
      return `Nothing posted since ${startLabel} today. Overnight silence doesn't count.`;
    case "inactive":
      return "No post in 7 days or more.";
    case "cant_check":
      if (cause === "meta") return "Meta is failing for these right now. They're retried automatically, so there's nothing to fix. A channel that can't be checked is never counted as a gap.";
      if (cause === "mixed")
        return "Some need Page access fixed or a reconnect on Account Growth. For the others Meta itself is failing, and they're retried automatically. A channel that can't be checked is never counted as a gap.";
      return "Meta wouldn't let us check these. That's an access problem, not a gap. Fix Page access or reconnect on Account Growth.";
    case "not_connected":
      return "Assigned in the portal, but no connected Facebook Page or Instagram account matches them on Account Growth, so they can't be checked.";
  }
}

/** Claims about FLAGS, not about posting: an empty list only means nothing is flagged. */
function emptyText(tab: Tab, startLabel: string): string {
  switch (tab) {
    case "quiet_today":
      return "No assigned channel is flagged as gone quiet.";
    case "no_post_today":
      return `No assigned channel is flagged for having no post since ${startLabel}.`;
    case "inactive":
      return "No assigned channel is flagged as inactive for 7 days.";
    case "cant_check":
      return "Every assigned channel can be checked.";
    case "not_connected":
      return "Every assigned Facebook and Instagram channel is connected.";
  }
}

const ERROR_COPY: Record<PostingWatchErrorKind, string> = {
  token: "Meta access has expired. Reconnect on Account Growth.",
  permission: "No admin access to this Page on Meta (or 2-step verification is required).",
  not_found: "Meta can't find this Page any more.",
  rate_limited: "Meta asked us to slow down. Retrying.",
  unreachable: "Meta isn't responding. Retrying.",
  meta_error: "Meta returned an error. Retrying.",
};

function peopleLabel(people: PostingWatchPerson[]): string {
  if (people.length === 0) return "No one assigned";
  const names = people.map((p) => p.name);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

// ── Filtering (shared by the list and the pill counts, so they always agree) ──────

function matchesQuery(query: string, name: string, people: PostingWatchPerson[]): boolean {
  return query === "" || name.toLowerCase().includes(query) || people.some((a) => a.name.toLowerCase().includes(query));
}

function filterRows<T extends { platform: string; name: string; assignees: PostingWatchPerson[] }>(rows: T[], platform: PlatformFilter, query: string): T[] {
  return rows.filter((r) => (platform === "all" || r.platform === platform) && matchesQuery(query, r.name, r.assignees));
}

function tabCounts(p: PostingWatchPayload, platform: PlatformFilter, query: string): Record<Tab, number> {
  const out: Record<Tab, number> = { quiet_today: 0, no_post_today: 0, inactive: 0, cant_check: 0, not_connected: 0 };
  for (const c of filterRows(p.channels, platform, query)) out[c.group]++;
  out.not_connected = filterRows(p.notConnected, platform, query).length;
  return out;
}

// ── Pieces ───────────────────────────────────────────────────────────────────────

function PlatformChip({ platform }: { platform: "facebook" | "instagram" }) {
  const fb = platform === "facebook";
  return (
    <span
      className="h-9 w-9 rounded-[8px] grid place-items-center text-[11px] font-bold text-white shrink-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]"
      style={{ background: fb ? "linear-gradient(135deg,#1877F2,#0B45BB)" : "linear-gradient(135deg,#F0803C,#EC42B7)" }}
      title={fb ? "Facebook" : "Instagram"}
    >
      {fb ? "FB" : "IG"}
    </span>
  );
}

function ChannelName({ name, href }: { name: string; href: string | null }) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[13.5px] font-semibold text-ds-text truncate hover:text-ds-gold transition-colors" title={`${name} — open on Meta`}>
      {name}
    </a>
  ) : (
    <span className="text-[13.5px] font-semibold text-ds-text truncate" title={name}>
      {name}
    </span>
  );
}

function ChannelRow({ c, nowMs, startLabel }: { c: PostingWatchChannel; nowMs: number; startLabel: string }) {
  const last = parse(c.lastPostAt);
  const since = parse(c.silentSince);
  const errSince = parse(c.errorSince);
  const checked = parse(c.checkedAt);
  let detail: ReactNode;
  if (c.group === "cant_check") {
    // Meta's own wording only where it helps a human fix access; a transient error's text
    // ("please retry later") adds nothing the row does not already say.
    const metaSaid = c.errorKind != null && NEEDS_A_HUMAN.has(c.errorKind) && c.errorDetail ? `Meta said: ${c.errorDetail}` : undefined;
    detail = (
      <span title={metaSaid}>
        {c.errorKind ? ERROR_COPY[c.errorKind] : "Can't be checked right now."}
        {errSince != null && ` Since ${istWhen(errSince, nowMs)}.`}
      </span>
    );
  } else if (c.group === "inactive") {
    detail = last != null ? `Last post ${istWhen(last, nowMs)}` : "No posts found on Meta.";
  } else {
    const lastText = last != null ? `last post ${istWhen(last, nowMs)}` : "no earlier post found";
    detail = c.group === "no_post_today" ? `Nothing since ${startLabel} · ${lastText}` : `Last post ${last != null ? istWhen(last, nowMs) : "unknown"}`;
  }
  return (
    <li className="flex items-center gap-3.5 px-4 py-3 min-w-0 transition-colors hover:bg-ds-hover/60">
      <PlatformChip platform={c.platform} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <ChannelName name={c.name} href={c.href} />
          {c.pages.length > 1 && (
            <span className="text-[10px] font-semibold text-ds-t2 border border-ds-line2 rounded-full px-1.5 py-[1px] shrink-0" title={`Counts as posting when any of its ${c.pages.length} Pages posts`}>
              {c.pages.length} Pages
            </span>
          )}
        </div>
        <p className="text-[12px] text-ds-t5 truncate mt-0.5" title={c.assignees.map((a) => a.name).join(", ")}>
          {peopleLabel(c.assignees)}
        </p>
        <p className="text-[11.5px] text-ds-t3 flex items-center gap-1 flex-wrap mt-0.5">
          <span className="min-w-0">{detail}</span>
          {c.lastPostUrl && c.group !== "cant_check" && (
            <a href={c.lastPostUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-[#6EB2FF] hover:text-ds-text" aria-label={`View the last post on ${c.name}`}>
              view <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {/* How fresh THIS flag is — every row is backed by its own live check of Meta. */}
          {checked != null && c.group !== "cant_check" && <span>· checked {ago(nowMs - checked)}</span>}
        </p>
      </div>
      {c.group === "inactive" ? (
        // For a dormant channel "silent since 7 AM" says nothing; the age of its last post does.
        last != null && (
          <div className="shrink-0 text-right">
            <p className="font-num text-[15px] font-bold text-[#B9A6EC] whitespace-nowrap">{duration(nowMs - last)}</p>
            <p className="text-[10px] uppercase tracking-[.08em] text-ds-t3">since last post</p>
          </div>
        )
      ) : since != null ? (
        <div className="shrink-0 text-right">
          <p className="font-num text-[15px] font-bold text-ds-gold whitespace-nowrap">{duration(nowMs - since)}</p>
          <p className="text-[10px] uppercase tracking-[.08em] text-ds-t3">silent</p>
        </div>
      ) : (
        c.group === "cant_check" && (
          <span className="h-8 w-8 rounded-full grid place-items-center shrink-0" style={{ background: "rgba(229,45,71,.12)" }}>
            <AlertTriangle className="h-4 w-4 text-[#F26B7E]" aria-label="Can't check" />
          </span>
        )
      )}
    </li>
  );
}

function NotConnectedRow({ r }: { r: PostingWatchNotConnected }) {
  const handle = r.handle.split("?")[0].trim();
  return (
    <li className="flex items-center gap-3.5 px-4 py-3 min-w-0 transition-colors hover:bg-ds-hover/60">
      <PlatformChip platform={r.platform} />
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-semibold text-ds-text truncate" title={r.name}>
          {r.name}
        </p>
        <p className="text-[12px] text-ds-t5 truncate mt-0.5" title={r.assignees.map((a) => a.name).join(", ")}>
          {peopleLabel(r.assignees)}
        </p>
        {r.reason === "ambiguous" ? (
          <p className="text-[11.5px] text-ds-t3 mt-0.5">Its name matches Pages of more than one channel, so it isn&apos;t watched.</p>
        ) : (
          handle &&
          handle !== r.name && (
            <p className="text-[11.5px] text-ds-t3 truncate mt-0.5" title={handle}>
              Handle: {handle}
            </p>
          )
        )}
      </div>
      <span className="hidden sm:inline-flex items-center h-[22px] px-2.5 rounded-full text-[10.5px] font-semibold shrink-0 border border-[rgba(110,178,255,.35)] bg-[rgba(110,178,255,.08)] text-[#6EB2FF]">
        {r.reason === "ambiguous" ? "Ambiguous" : "Not connected"}
      </span>
    </li>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <section className="relative overflow-hidden rounded-[10px] bg-ds-card border border-[#1E3442] p-5 sm:p-6 space-y-4 min-w-0 shadow-[0_18px_40px_-28px_rgba(0,0,0,.9)]">
      {/* Soft gold glow in the corner — decoration only */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -left-16 h-56 w-56 rounded-full"
        style={{ background: "radial-gradient(circle, rgba(233,189,98,.10), transparent 70%)" }}
      />
      <div className="relative space-y-4">{children}</div>
    </section>
  );
}

function Header({ right, subtitle }: { right?: ReactNode; subtitle?: string }) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3.5 min-w-0">
        <div className="h-11 w-11 rounded-[10px] grid place-items-center shrink-0 border border-[rgba(233,189,98,.3)] bg-[rgba(233,189,98,.1)]">
          <BellRing className="h-5 w-5 text-ds-gold" strokeWidth={1.8} />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-ds-gold">Monitoring</p>
          <h2 className="text-[17px] font-semibold tracking-[-.01em] text-ds-text leading-tight">Posting watch</h2>
          <p className="text-[12px] text-ds-t3 mt-0.5">{subtitle ?? "Assigned channels that have stopped posting"}</p>
        </div>
      </div>
      {right}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="text-[12px] text-ds-t5 rounded-[8px] border border-[rgba(233,189,98,.28)] bg-[rgba(233,189,98,.07)] px-3.5 py-2.5 flex items-center justify-between gap-3 flex-wrap">
      {children}
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ds-gold hover:text-[#F4D58C]">
      <RefreshCw className="h-3.5 w-3.5" /> Retry now
    </button>
  );
}

// ── The card ─────────────────────────────────────────────────────────────────────

function PostingWatchInner() {
  const { data: res, error, isLoading, mutate } = usePostingWatch(true);
  const p: PostingWatchPayload | undefined = res?.data;

  // A clock that ticks every 30 s so "silent 2h 14m" stays live between polls. It runs
  // from the SERVER's time at the moment the response arrived, so neither a viewer's
  // wrong computer clock nor an old response can skew it.
  const [clientNow, setClientNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClientNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const serverNow = parse(p?.now);
  const nowMs = res && serverNow != null ? serverNow + Math.max(0, clientNow - res.receivedAt) : clientNow;

  const [tab, setTab] = useState<Tab | null>(null);
  const [autoTab, setAutoTab] = useState<Tab | null>(null);
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  // All hooks run before any early return below.
  const ready = p != null && p.status === "ok";
  const active = ready && p.window.active;
  const counts = ready ? tabCounts(p, platform, query) : null;
  const firstNonEmpty: Tab = counts && active ? TAB_ORDER.find((t) => counts[t] > 0) ?? "quiet_today" : "quiet_today";
  const latchedCount = autoTab != null && counts ? counts[autoTab] : 0;
  const latchedForActive = useRef<boolean | null>(null);
  // The automatic tab is picked once and then kept while someone reads it: it moves only
  // when its own list empties or the window opens/closes, never because another list grew.
  useEffect(() => {
    if (!ready || tab != null) return;
    if (autoTab == null || latchedCount === 0 || latchedForActive.current !== active) {
      latchedForActive.current = active;
      setAutoTab(firstNonEmpty);
    }
  }, [ready, tab, autoTab, latchedCount, active, firstNonEmpty]);

  if (!p) {
    if (error && !isLoading) {
      return (
        <Frame>
          <Header />
          <div className="flex items-center justify-between gap-3 flex-wrap rounded-[8px] border border-ds-line bg-ds-inset px-4 py-3">
            <p className="text-[13px] text-ds-t2">Couldn&apos;t load the posting watch. Retrying automatically.</p>
            <RetryButton onClick={() => void mutate()} />
          </div>
        </Frame>
      );
    }
    return (
      <Frame>
        <Header />
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 rounded-[8px] bg-ds-inset border border-ds-line motion-safe:animate-pulse" />
          ))}
        </div>
      </Frame>
    );
  }

  const subtitle = `Assigned channels with no new post for ${gapText(p.thresholdMinutes)} or more`;
  const startLabel = clockFromMinutes(p.window.startMinute);
  const endLabel = clockFromMinutes(p.window.endMinute);

  if (p.status !== "ok" || !counts) {
    const text =
      p.status === "off"
        ? "Posting watch is switched off."
        : p.status === "paused"
          ? "Posting watch is waiting for a one-time database update. It will start on its own once that's done."
          : "Couldn't read the posting watch just now. Retrying automatically.";
    return (
      <Frame>
        <Header subtitle={subtitle} />
        <p className="text-[13px] text-ds-t2 rounded-[8px] border border-ds-line bg-ds-inset px-4 py-3">{text}</p>
      </Frame>
    );
  }

  const configured = p.monitor.configured;
  const pausedUntil = parse(p.monitor.pausedUntil);
  const paused = pausedUntil != null && pausedUntil > nowMs;
  const lastSuccess = parse(p.monitor.lastSuccessAt);
  const verifyingSince = parse(p.monitor.verifyingSince);
  const windowStart = parse(p.window.start) ?? 0;
  const nextStart = parse(p.window.nextStart);
  const asOf = parse(p.asOf);
  const late = active && configured && !paused && verifyingSince != null && nowMs - verifyingSince > LATE_AFTER_MS;
  // No channel can be overdue before the window open + the gap (+ the confirming minute).
  const firstFlagAt = windowStart + p.thresholdMinutes * MINUTE;
  const beforeFirstFlag = active && nowMs < firstFlagAt + MINUTE;

  const current: Tab = tab ?? autoTab ?? firstNonEmpty;
  const channelRows = current === "not_connected" ? [] : filterRows(p.channels.filter((c) => c.group === current), platform, query);
  const ncRows = current === "not_connected" ? filterRows(p.notConnected, platform, query) : [];
  const rowCount = current === "not_connected" ? ncRows.length : channelRows.length;

  const cantRows = filterRows(p.channels.filter((c) => c.group === "cant_check"), platform, query);
  const humanFixable = cantRows.filter((c) => c.errorKind != null && NEEDS_A_HUMAN.has(c.errorKind)).length;
  const cause: CantCheckCause | null =
    cantRows.length === 0 ? null : humanFixable === cantRows.length ? "access" : humanFixable === 0 ? "meta" : "mixed";

  let emptyMessage: string;
  if (query || platform !== "all") {
    const elsewhere = TAB_ORDER.filter((t) => t !== current && counts[t] > 0);
    emptyMessage =
      elsewhere.length > 0
        ? `Nothing here matches. Found in ${elsewhere.map((t) => `${tabLabel(t)} (${counts[t]})`).join(", ")}.`
        : "Nothing matches these filters.";
  } else if (SILENT_TABS.has(current) && beforeFirstFlag) {
    emptyMessage = `No channel can be overdue before ${istClock(firstFlagAt)}. Channels with no post since ${startLabel} are flagged from then.`;
  } else if (SILENT_TABS.has(current) && p.counts.verifying > 0) {
    emptyMessage = `Checking ${p.counts.verifying} channel${p.counts.verifying === 1 ? "" : "s"} now.`;
  } else {
    emptyMessage = emptyText(current, startLabel);
  }

  const status = !configured ? (
    <div className="inline-flex items-center gap-1.5 h-[28px] px-3 rounded-full border border-[rgba(233,189,98,.35)] bg-[rgba(233,189,98,.08)] text-[11.5px] font-semibold text-ds-gold">
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      Not connected to Meta
    </div>
  ) : active ? (
    <div className="inline-flex items-center gap-2 h-[28px] px-3 rounded-full border border-[rgba(0,215,160,.3)] bg-[rgba(0,215,160,.07)] text-[11.5px] text-ds-t2">
      <span className="inline-flex items-center gap-1.5 font-semibold text-ds-teal">
        <span className="h-1.5 w-1.5 rounded-full bg-ds-teal [animation:dsBeat_2s_infinite]" aria-hidden="true" />
        Live
      </span>
      {/* A SUCCESSFUL check, and only today's: nothing needs checking before the first deadline. */}
      {lastSuccess != null && lastSuccess >= windowStart && <span>· checked {ago(nowMs - lastSuccess)}</span>}
    </div>
  ) : (
    <div className="inline-flex items-center gap-1.5 h-[28px] px-3 rounded-full border border-ds-line2 bg-ds-inset text-[11.5px] text-ds-t2">
      <Moon className="h-3.5 w-3.5 text-[#9B7EDE]" />
      Paused overnight{nextStart != null && ` · resumes ${istWhen(nextStart, nowMs)}`}
    </div>
  );

  return (
    <Frame>
      <Header right={status} subtitle={subtitle} />

      {!configured && <Notice>Posting watch isn&apos;t connected to Meta on this server, so nothing is being checked.</Notice>}
      {(p.stale || error) && (
        <Notice>
          <span>
            Couldn&apos;t refresh just now. Showing the update from {asOf != null ? istWhen(asOf, nowMs) : "earlier"}, and retrying automatically.
          </span>
          <RetryButton onClick={() => void mutate()} />
        </Notice>
      )}
      {paused && <Notice>Meta asked us to slow down, so checks resume at {istClock(pausedUntil as number)}. The list may lag until then.</Notice>}
      {late && (
        <Notice>
          Checks are running behind. Some channels have been waiting since {istClock(verifyingSince as number)} to be confirmed. The list will catch up
          automatically.
        </Notice>
      )}

      <div className="space-y-3.5">
        <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Status">
          {TAB_ORDER.map((t) => (
            <StatusTab key={t} active={current === t} accent={TAB_ACCENT[t]} label={tabLabel(t)} count={counts[t]} onClick={() => setTab(t)} />
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Seg<PlatformFilter>
            options={[
              { key: "all", label: "All" },
              { key: "facebook", label: "Facebook" },
              { key: "instagram", label: "Instagram" },
            ]}
            value={platform}
            onChange={setPlatform}
          />
          <label className="relative flex items-center w-full sm:w-72 h-[34px] rounded-full border border-ds-line2 bg-ds-inset px-3.5 gap-2 transition-colors focus-within:border-[rgba(233,189,98,.55)]">
            <span className="sr-only">Search channels or people</span>
            <Search className="h-3.5 w-3.5 text-ds-t3 shrink-0" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search channels or people"
              className="ds-bare flex-1 min-w-0 bg-transparent border-0 text-[12.5px] text-ds-text placeholder:text-ds-t3 focus:outline-none"
            />
          </label>
        </div>
        <p className="text-[12px] text-ds-t3 leading-relaxed flex items-start gap-2">
          <span className="mt-[6px] h-1 w-1 rounded-full shrink-0" style={{ background: TAB_ACCENT[current] }} aria-hidden="true" />
          {tabHint(current, startLabel, gapText(p.thresholdMinutes), cause)}
        </p>
      </div>

      <div className="rounded-[8px] border border-ds-line bg-ds-inset overflow-hidden">
        {!active && SILENT_TABS.has(current) ? (
          <p className="text-[13px] text-ds-t2 px-4 py-8 text-center">
            Monitoring runs {startLabel} – {endLabel} IST. Gaps overnight are fine.
          </p>
        ) : rowCount === 0 ? (
          <p className="text-[13px] text-ds-t2 px-4 py-8 text-center">{emptyMessage}</p>
        ) : (
          <ul className="divide-y divide-[#132430] max-h-[26rem] overflow-y-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:#223543_transparent]">
            {current === "not_connected"
              ? ncRows.map((r) => <NotConnectedRow key={r.accountId} r={r} />)
              : channelRows.map((c) => <ChannelRow key={c.key} c={c} nowMs={nowMs} startLabel={startLabel} />)}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap pt-1 text-[11.5px] text-ds-t3">
        <span>
          <span className="font-num font-semibold text-ds-t5">{p.counts.monitored}</span> assigned channel{p.counts.monitored === 1 ? "" : "s"} watched
        </span>
        {active && (
          <span>
            <span className="font-num font-semibold text-ds-teal">{p.counts.onSchedule}</span> on schedule
          </span>
        )}
        {active && p.counts.verifying > 0 && (
          <span>
            checking <span className="font-num font-semibold text-ds-t5">{p.counts.verifying}</span>
          </span>
        )}
        <span className="sm:ml-auto inline-flex items-center gap-1.5">
          <span className="h-1 w-1 rounded-full bg-ds-gold" aria-hidden="true" />
          {startLabel} – {endLabel} IST
        </span>
      </div>
    </Frame>
  );
}

class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error("[posting-watch] card failed to render:", err);
  }

  render() {
    if (this.state.failed) {
      return (
        <Frame>
          <Header />
          <p className="text-[13px] text-ds-t2">The posting watch couldn&apos;t be shown. Reload the page to try again.</p>
        </Frame>
      );
    }
    return this.props.children;
  }
}

export function PostingWatchCard() {
  return (
    <CardBoundary>
      <PostingWatchInner />
    </CardBoundary>
  );
}
