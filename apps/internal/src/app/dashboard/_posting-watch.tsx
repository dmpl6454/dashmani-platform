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
import { Pill, PillGroup } from "./_pills";

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
  return platform === "facebook" ? (
    <span className="mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-blue-50 text-blue-600 border-blue-200 shrink-0" title="Facebook">
      FB
    </span>
  ) : (
    <span className="mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-pink-100 text-pink-700 border-pink-200 shrink-0" title="Instagram">
      IG
    </span>
  );
}

function ChannelName({ name, href }: { name: string; href: string | null }) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-ink truncate hover:underline" title={`${name} — open on Meta`}>
      {name}
    </a>
  ) : (
    <span className="text-sm font-semibold text-ink truncate" title={name}>
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
    <li className="flex items-start gap-3 px-3 py-2.5 min-w-0">
      <PlatformChip platform={c.platform} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <ChannelName name={c.name} href={c.href} />
          {c.pages.length > 1 && (
            <span className="text-[10px] text-ink-4 bg-ink/5 rounded-full px-1.5 py-0.5 shrink-0" title={`Counts as posting when any of its ${c.pages.length} Pages posts`}>
              {c.pages.length} Pages
            </span>
          )}
        </div>
        <p className="text-xs text-ink-3 truncate" title={c.assignees.map((a) => a.name).join(", ")}>
          {peopleLabel(c.assignees)}
        </p>
        <p className="text-xs text-ink-4 flex items-center gap-1 flex-wrap">
          <span className="min-w-0">{detail}</span>
          {c.lastPostUrl && c.group !== "cant_check" && (
            <a href={c.lastPostUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-indigo hover:underline" aria-label={`View the last post on ${c.name}`}>
              view <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {/* How fresh THIS flag is — every row is backed by its own live check of Meta. */}
          {checked != null && c.group !== "cant_check" && <span className="text-ink-4">· checked {ago(nowMs - checked)}</span>}
        </p>
      </div>
      {c.group === "inactive" ? (
        // For a dormant channel "silent since 7 AM" says nothing; the age of its last post does.
        last != null && (
          <div className="shrink-0 text-right">
            <p className="font-num text-sm font-bold text-ink-3 whitespace-nowrap">{duration(nowMs - last)}</p>
            <p className="text-[10px] text-ink-4">since last post</p>
          </div>
        )
      ) : since != null ? (
        <div className="shrink-0 text-right">
          <p className="font-num text-sm font-bold text-attention whitespace-nowrap">{duration(nowMs - since)}</p>
          <p className="text-[10px] text-ink-4">silent</p>
        </div>
      ) : (
        c.group === "cant_check" && <AlertTriangle className="h-4 w-4 text-danger shrink-0 mt-0.5" aria-label="Can't check" />
      )}
    </li>
  );
}

function NotConnectedRow({ r }: { r: PostingWatchNotConnected }) {
  const handle = r.handle.split("?")[0].trim();
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 min-w-0">
      <PlatformChip platform={r.platform} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink truncate" title={r.name}>
          {r.name}
        </p>
        <p className="text-xs text-ink-3 truncate" title={r.assignees.map((a) => a.name).join(", ")}>
          {peopleLabel(r.assignees)}
        </p>
        {r.reason === "ambiguous" ? (
          <p className="text-xs text-ink-4">Its name matches Pages of more than one channel, so it isn&apos;t watched.</p>
        ) : (
          handle &&
          handle !== r.name && (
            <p className="text-xs text-ink-4 truncate" title={handle}>
              Handle: {handle}
            </p>
          )
        )}
      </div>
    </li>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <section className="lg:col-span-3 v3-card p-5 space-y-4 min-w-0">{children}</section>;
}

function Header({ right, subtitle }: { right?: ReactNode; subtitle?: string }) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-10 w-10 rounded-xl bg-attention/10 flex items-center justify-center shrink-0">
          <BellRing className="h-5 w-5 text-attention" />
        </div>
        <div className="min-w-0">
          <h2 className="font-bold text-ink">Posting watch</h2>
          <p className="text-xs text-ink-4">{subtitle ?? "Assigned channels that have stopped posting"}</p>
        </div>
      </div>
      {right}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="text-xs text-ink-3 rounded-lg bg-attention/5 px-3 py-2 flex items-center justify-between gap-3 flex-wrap">{children}</div>;
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo hover:underline">
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
          <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl bg-muted px-4 py-3">
            <p className="text-sm text-ink-3">Couldn&apos;t load the posting watch. Retrying automatically.</p>
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
            <div key={i} className="h-12 rounded-xl bg-ink/5 animate-pulse" />
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
        <p className="text-sm text-ink-3 rounded-xl bg-muted px-4 py-3">{text}</p>
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
    <div className="flex items-center gap-1.5 text-xs text-ink-4">
      <AlertTriangle className="h-3.5 w-3.5 text-attention" aria-hidden="true" />
      Not connected to Meta
    </div>
  ) : active ? (
    <div className="flex items-center gap-2 text-xs text-ink-4">
      <span className="inline-flex items-center gap-1.5 font-semibold text-success">
        <span className="h-2 w-2 rounded-full bg-success dot-pulse" aria-hidden="true" />
        Live
      </span>
      {/* A SUCCESSFUL check, and only today's: nothing needs checking before the first deadline. */}
      {lastSuccess != null && lastSuccess >= windowStart && <span>· checked {ago(nowMs - lastSuccess)}</span>}
    </div>
  ) : (
    <div className="flex items-center gap-1.5 text-xs text-ink-4">
      <Moon className="h-3.5 w-3.5" />
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

      <div className="space-y-3">
        <PillGroup>
          {TAB_ORDER.map((t) => (
            <Pill key={t} active={current === t} accent="terra" onClick={() => setTab(t)}>
              {tabLabel(t)} <span className="font-num">{counts[t]}</span>
            </Pill>
          ))}
        </PillGroup>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PillGroup>
            {(["all", "facebook", "instagram"] as const).map((pl) => (
              <Pill key={pl} active={platform === pl} onClick={() => setPlatform(pl)}>
                {pl === "all" ? "All" : pl === "facebook" ? "Facebook" : "Instagram"}
              </Pill>
            ))}
          </PillGroup>
          <label className="relative block w-full sm:w-64">
            <span className="sr-only">Search channels or people</span>
            <Search className="h-3.5 w-3.5 text-ink-4 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search channels or people"
              className="w-full h-8 pl-8 pr-3 rounded-full border-2 border-ink/10 bg-surface text-xs text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo/40"
            />
          </label>
        </div>
        <p className="text-xs text-ink-4">{tabHint(current, startLabel, gapText(p.thresholdMinutes), cause)}</p>
      </div>

      <div className="rounded-xl border-2 border-ink/10 overflow-hidden">
        {!active && SILENT_TABS.has(current) ? (
          <p className="text-sm text-ink-3 px-4 py-6 text-center">
            Monitoring runs {startLabel} – {endLabel} IST. Gaps overnight are fine.
          </p>
        ) : rowCount === 0 ? (
          <p className="text-sm text-ink-3 px-4 py-6 text-center">{emptyMessage}</p>
        ) : (
          <ul className="divide-y-2 divide-ink/5 max-h-[26rem] overflow-y-auto overscroll-contain">
            {current === "not_connected"
              ? ncRows.map((r) => <NotConnectedRow key={r.accountId} r={r} />)
              : channelRows.map((c) => <ChannelRow key={c.key} c={c} nowMs={nowMs} startLabel={startLabel} />)}
          </ul>
        )}
      </div>

      <p className="text-xs text-ink-4">
        {p.counts.monitored} assigned channel{p.counts.monitored === 1 ? "" : "s"} watched
        {active && ` · ${p.counts.onSchedule} on schedule`}
        {active && p.counts.verifying > 0 && ` · checking ${p.counts.verifying}`}
        {` · ${startLabel} – ${endLabel} IST`}
      </p>
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
          <p className="text-sm text-ink-3">The posting watch couldn&apos;t be shown. Reload the page to try again.</p>
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
