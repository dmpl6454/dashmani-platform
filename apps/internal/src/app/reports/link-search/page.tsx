"use client";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft, Search, Link2, Layers, CopyMinus, Globe, Users,
  Info, AlertTriangle, ExternalLink, X as CloseIcon, RefreshCw, Download,
} from "lucide-react";
import { useLinkSearch, useEntitySuggestions } from "@/lib/hooks/use-link-search";
import { useInsightsRefresh } from "@/lib/hooks/use-insights-refresh";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { apiFetchBlob, downloadBlob } from "@/lib/api";

function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return d; }
}

function cap(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Render a handle with exactly ONE leading "@". Some stored social_accounts handles
// already include a leading "@" (e.g. "@BollywoodChronicle"), which the old `@{handle}`
// render turned into "@@BollywoodChronicle". Strip any leading @'s, then prepend one.
function fmtHandle(handle: string) {
  return `@${(handle || "").replace(/^@+/, "")}`;
}

function phaseLabel(phase: "idle" | "harvesting" | "extracting"): string {
  if (phase === "harvesting") return "Reading Instagram & Facebook captions…";
  if (phase === "extracting") return "Tagging people & topics…";
  return "Starting…";
}

// Debounce a fast-changing value (search input) so we don't fire a query on every
// keystroke. ~350ms is the sweet spot: snappy but well clear of typing cadence.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

// Minimum query length before an AUTOMATIC (debounced) search fires. Single
// characters would match too broadly and waste a round-trip on the bounded
// (OOM-safe) search endpoint. Explicit Enter / button / suggestion click bypass
// this and search whatever was typed.
const MIN_AUTOSEARCH_LEN = 2;
const SEARCH_DEBOUNCE_MS = 350;

export default function LinkSearchPage() {
  usePageTitle("Link Search");

  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // ── Dynamic search ──────────────────────────────────────────────────────────
  // Auto-search as the user types (debounced), so they don't have to press Search.
  // The debounced term drives `submitted` once it's >= MIN_AUTOSEARCH_LEN; Enter /
  // the button / a suggestion click still search immediately via runSearch().
  const debouncedQ = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    const t = debouncedQ.trim();
    // Only auto-fire for queries long enough to be meaningful. Clearing the box
    // (length 0) resets back to the coverage-only view; a single stray char does
    // not trigger a query.
    if (t.length === 0) setSubmitted("");
    else if (t.length >= MIN_AUTOSEARCH_LEN) setSubmitted(t);
  }, [debouncedQ]);

  const { data, isLoading, isValidating, mutate: mutateLinkSearch } = useLinkSearch(submitted);
  const { data: suggestions } = useEntitySuggestions(q);

  // Stable callback — SWR's mutate is referentially stable, so this never
  // changes identity and won't re-fire the hook's mount-probe effect on typing.
  const onEnrichmentComplete = useCallback(() => { mutateLinkSearch(); }, [mutateLinkSearch]);
  const { status: refreshStatus, phase: refreshPhase, triggerRefresh, dismiss: dismissRefresh } =
    useInsightsRefresh({ onComplete: onEnrichmentComplete });

  // Close the suggestion dropdown on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowSuggest(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function runSearch(term: string) {
    const t = term.trim();
    setQ(t);
    setSubmitted(t);
    setShowSuggest(false);
  }

  // Export EVERY submitted link for the currently-resolved entity to a styled
  // .xlsx (date, platform, channel, submitted-by, URL, dup flag) + an About sheet
  // with totals + the coverage caveat. Uses the resolved entity name (or the typed
  // query) so the export matches exactly what's on screen.
  async function handleExport() {
    const term = (data?.entity?.canonicalName || submitted || q).trim();
    if (!term || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await apiFetchBlob(
        `/admin/link-search/export.xlsx?q=${encodeURIComponent(term)}`,
      );
      downloadBlob(blob, filename || `link-search-${term}.xlsx`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const coverage = data?.coverage;
  const entity = data?.entity ?? null;
  const disambiguation = data?.disambiguation ?? [];

  // Channels sorted desc by postCount.
  const channels = useMemo(
    () => [...(data?.channels ?? [])].sort((a, b) => b.postCount - a.postCount),
    [data?.channels],
  );

  // Group posts by canonicalKey so duplicate submissions collapse into one row.
  const groupedPosts = useMemo(() => {
    type Post = NonNullable<typeof data>["posts"][number];
    const map = new Map<string, { lead: Post; subs: Post[] }>();
    for (const p of data?.posts ?? []) {
      const existing = map.get(p.canonicalKey);
      if (existing) existing.subs.push(p);
      else map.set(p.canonicalKey, { lead: p, subs: [p] });
    }
    return Array.from(map.values());
  }, [data?.posts]);

  const showSuggestions = showSuggest && q.trim().length >= 2 && (suggestions?.length ?? 0) > 0;
  // isValidating = true on EVERY in-flight request (including refetches with
  // keepPreviousData). isLoading is only true before the first result arrives.
  // We want a spinner any time a search is running, so use isValidating.
  const loadingFresh = isValidating;

  return (
    <div className="space-y-6 pop-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-ink-4 hover:text-ink transition-colors">
          <ArrowLeft className="h-4 w-4" /> Reports
        </Link>
      </div>

      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">Link Search</h1>
        <p className="text-sm text-ink-4 mt-0.5">
          Find every uploaded post for a person across all of their channels.
        </p>
      </div>

      {/* Search bar with entity autocomplete */}
      <div ref={wrapRef} className="relative max-w-2xl">
        <form
          onSubmit={(e) => { e.preventDefault(); runSearch(q); }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4 pointer-events-none" />
            <input
              type="text"
              value={q}
              onChange={(e) => { setQ(e.target.value); setShowSuggest(true); }}
              onFocus={() => setShowSuggest(true)}
              placeholder="Search by person's name… (searches as you type)"
              className="w-full h-11 pl-10 pr-9 rounded-xl border-2 border-ink/10 bg-bg text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors"
            />
            {q && (
              <button
                type="button"
                onClick={() => { setQ(""); setShowSuggest(false); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink"
                aria-label="Clear"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            type="submit"
            className="h-11 px-5 rounded-xl bg-ink text-white text-sm font-medium hover:bg-ink/90 transition-colors shrink-0"
          >
            Search
          </button>
        </form>

        {/* Autocomplete dropdown */}
        {showSuggestions && (
          <div className="absolute z-30 mt-1.5 w-full max-w-2xl rounded-xl border-2 border-ink/10 bg-bg shadow-hard overflow-hidden">
            {suggestions!.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => runSearch(s.canonicalName)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-muted transition-colors"
              >
                <span className="text-sm font-medium text-ink truncate flex-1">{s.canonicalName}</span>
                <span className="text-[10px] text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0">{cap(s.type)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Persistent coverage banner — auto-derived, self-healing accuracy.
          "Searchable of submitted" is the honest framing: a permanently-unsearchable
          link (e.g. opaque facebook.com/share/ links, or posts older than our enrichment window) can never inflate the tally. */}
      {coverage && (() => {
        // Prefer the honest fields; fall back to legacy for older API responses.
        const searchable = coverage.searchable ?? coverage.enriched ?? 0;
        const submitted = coverage.submitted ?? coverage.total ?? 0;
        const bp = coverage.byPlatform ?? {};
        // Per-platform rows in a stable, meaningful order.
        const ORDER = ["youtube", "instagram", "facebook", "snapchat"] as const;
        const LABEL: Record<string, string> = { youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", snapchat: "Snapchat" };
        const rows = ORDER
          .filter((p) => bp[p])
          .map((p) => ({ p, ...bp[p]! }));
        const totalPending = coverage.pendingExtraction ?? 0;
        const isRunning = refreshStatus === "running";
        return (
          <div className="space-y-2">
            {/* Success banner */}
            {refreshStatus === "success" && (
              <div role="status" aria-live="polite" className="rounded-xl border border-sage/30 bg-sage/5 px-4 py-2.5 flex items-center gap-2">
                <Info className="h-4 w-4 text-sage shrink-0" />
                <p className="text-xs text-ink flex-1">
                  Enrichment complete. New posts are now searchable.
                </p>
                <button
                  type="button"
                  onClick={dismissRefresh}
                  className="text-ink-4 hover:text-ink transition-colors shrink-0"
                  aria-label="Dismiss"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Error banner */}
            {refreshStatus === "error" && (
              <div role="alert" aria-live="assertive" className="rounded-xl border border-terra/30 bg-terra/5 px-4 py-2.5 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-terra shrink-0 mt-0.5" />
                <p className="text-xs text-ink flex-1">
                  Couldn&rsquo;t refresh just now — the Instagram/Facebook API may be rate-limited or temporarily unavailable.
                  Your existing results are unaffected, and enrichment keeps running automatically. Try again in a few minutes.
                </p>
                <button
                  type="button"
                  onClick={dismissRefresh}
                  className="text-ink-4 hover:text-ink transition-colors shrink-0"
                  aria-label="Dismiss"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Coverage banner */}
            <div className="rounded-xl border border-indigo/20 bg-indigo-soft px-4 py-3 flex items-start gap-3">
              <Info className="h-4 w-4 text-indigo shrink-0 mt-0.5" />
              <div className="text-xs text-ink leading-relaxed space-y-1.5 w-full">
                {/* Header row with refresh button */}
                <div className="flex items-start justify-between gap-3">
                  <p>
                    Searching <span className="font-semibold">{searchable.toLocaleString()}</span> searchable
                    {submitted > 0 && <> of <span className="font-semibold">{submitted.toLocaleString()}</span> submitted</>} links.
                  </p>
                  <button
                    type="button"
                    onClick={triggerRefresh}
                    disabled={isRunning}
                    className="shrink-0 flex items-center gap-1.5 rounded-lg border border-indigo/30 bg-white/60 px-2.5 py-1 text-[11px] font-medium text-indigo hover:bg-white/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    aria-label="Refresh enrichment"
                  >
                    <RefreshCw className={`h-3 w-3 ${isRunning ? "animate-spin" : ""}`} />
                    Refresh enrichment
                  </button>
                </div>

                {/* Live phase text while running */}
                {isRunning && (
                  <p className="text-indigo font-medium" aria-live="polite">
                    {phaseLabel(refreshPhase)}
                  </p>
                )}

                <ul className="text-ink-4 space-y-1">
                  {rows.map(({ p, searchable: s, submitted: sub, since, pendingExtraction: pPending }) => (
                    <li key={p} className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="font-medium text-ink-3 w-20 shrink-0">{LABEL[p] ?? p}</span>
                      <span>
                        <span className="font-semibold text-ink">{(s ?? 0).toLocaleString()}</span>
                        {sub != null && sub > 0 && <> of {sub.toLocaleString()}</>} searchable
                      </span>
                      {p === "youtube" && <span className="text-ink-4">· all dates</span>}
                      {(p === "instagram" || p === "facebook") && since && (
                        <span className="text-ink-4">· capturing since {fmtDate(since)}</span>
                      )}
                      {(pPending ?? 0) > 0 && (
                        <span className="text-ink-4">· {(pPending!).toLocaleString()} tagging</span>
                      )}
                    </li>
                  ))}
                </ul>
                {totalPending > 0 && (
                  <p className="text-ink-4 pt-0.5" aria-live="polite">
                    {totalPending.toLocaleString()} captured {totalPending === 1 ? "caption is" : "captions are"} still being tagged with people &amp; topics — {totalPending === 1 ? "it" : "they"}&rsquo;ll be searchable by name within a few hours. (Use Refresh to check progress.)
                  </p>
                )}

                <p className="text-ink-4 pt-0.5 border-t border-indigo/10 mt-1">
                  The denominator is <span className="font-medium">every link ever submitted</span> for each platform (all dates),
                  and &ldquo;searchable&rdquo; counts how many of those we&rsquo;ve captured a caption for — old and new alike, not just
                  recent ones. &ldquo;Capturing since&rdquo; is the date we started reading captions, not a cutoff on which links count.
                </p>
                <p className="text-ink-4 pt-0.5">
                  The gap (submitted minus searchable) is mostly Instagram/Facebook posts that have scrolled too far back in
                  their account&rsquo;s feed for Meta to return by link (there&rsquo;s no fetch-by-id), plus opaque
                  <span className="font-mono text-[10px]"> facebook.com/share/</span> links that carry no post id. YouTube has no
                  such limit. These links still exist in the system — they just can&rsquo;t be caption-searched.
                </p>

                {/* Plain-language explainer */}
                <p className="text-ink-4 pt-0.5">
                  Enrichment reads each post&rsquo;s caption and tags who&rsquo;s in it, so you can search by name. YouTube and
                  Facebook are read directly from each public post; Instagram is read from the accounts we manage. New posts
                  become searchable automatically within a few hours — use Refresh to pull the latest now. A full pass usually
                  takes a few minutes.
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Loading state — never bare isLoading (keepPreviousData persists data across queries) */}
      {loadingFresh && (
        <div className="v3-card p-8 flex items-center justify-center">
          <p className="text-sm text-ink-4">Searching…</p>
        </div>
      )}

      {/* Disambiguation — multiple entity matches */}
      {!loadingFresh && disambiguation.length > 0 && (
        <div className="v3-card p-5 space-y-3">
          <p className="font-semibold text-ink">Multiple matches — did you mean:</p>
          <div className="flex flex-wrap gap-2">
            {disambiguation.map((d) => (
              <button
                key={d.id}
                onClick={() => runSearch(d.canonicalName)}
                className="flex items-center gap-1.5 rounded-full border-2 border-ink/10 px-3.5 py-1.5 text-sm font-medium text-ink hover:border-indigo hover:bg-indigo-soft transition-colors"
              >
                {d.canonicalName}
                <span className="text-[10px] text-ink-4">{cap(d.type)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Results — only when we have an entity and no disambiguation */}
      {!loadingFresh && disambiguation.length === 0 && entity && (
        <>
          {/* Truncation note */}
          {data?.truncated && (
            <div className="rounded-xl border border-action/30 bg-action/10 px-4 py-2.5 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-action-deep shrink-0" />
              <p className="text-xs text-ink">Showing a capped subset; refine your search.</p>
            </div>
          )}

          {/* Entity header */}
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="font-display text-xl font-semibold text-ink">{entity.canonicalName}</h2>
            <span className="text-xs text-ink-4 bg-ink/5 rounded-full px-2.5 py-0.5">{cap(entity.type)}</span>
            {entity.aliases.length > 0 && (
              <span className="text-xs text-ink-4">aka {entity.aliases.join(", ")}</span>
            )}
            {data!.totalPosts > 0 && (
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="ml-auto self-center flex items-center gap-1.5 rounded-lg border-2 border-ink/10 px-3 py-1.5 text-xs font-medium text-ink hover:border-indigo hover:bg-indigo-soft disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                aria-label="Export all links to Excel"
                title="Download every link for this person as an Excel sheet"
              >
                <Download className={`h-3.5 w-3.5 ${exporting ? "animate-pulse" : ""}`} />
                {exporting ? "Preparing…" : "Export to Excel"}
              </button>
            )}
          </div>
          {exportError && (
            <div role="alert" className="rounded-xl border border-terra/30 bg-terra/5 px-4 py-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-terra shrink-0" />
              <p className="text-xs text-ink">Couldn&rsquo;t export: {exportError}</p>
            </div>
          )}

          {/* Summary strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="v3-card-sm p-4 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-terra-soft flex items-center justify-center">
                <Link2 className="h-3.5 w-3.5 text-terra" />
              </div>
              <p className="font-num text-2xl font-semibold text-ink leading-none pt-1">{data!.totalPosts.toLocaleString()}</p>
              <p className="text-xs text-ink-4">Total Posts</p>
            </div>
            <div className="v3-card-sm p-4 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-sage-soft flex items-center justify-center">
                <Layers className="h-3.5 w-3.5 text-sage" />
              </div>
              <p className="font-num text-2xl font-semibold text-ink leading-none pt-1">{data!.uniquePosts.toLocaleString()}</p>
              <p className="text-xs text-ink-4">Unique Posts</p>
            </div>
            <div className="v3-card-sm p-4 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-attention/10 flex items-center justify-center">
                <CopyMinus className="h-3.5 w-3.5 text-attention" />
              </div>
              <p className="font-num text-2xl font-semibold text-ink leading-none pt-1">{data!.duplicatePosts.toLocaleString()}</p>
              <p className="text-xs text-ink-4">Duplicates</p>
            </div>
            <div className="v3-card-sm p-4 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-indigo-soft flex items-center justify-center">
                <Globe className="h-3.5 w-3.5 text-indigo" />
              </div>
              <p className="font-num text-2xl font-semibold text-ink leading-none pt-1">{data!.channelCount.toLocaleString()}</p>
              <p className="text-xs text-ink-4">Channels</p>
            </div>
          </div>

          {/* Channel breakdown */}
          <div className="v3-card p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-indigo" />
              <p className="font-semibold text-ink">Channel Breakdown</p>
              <span className="ml-auto text-xs text-ink-4">{channels.length} channel{channels.length !== 1 ? "s" : ""}</span>
            </div>
            {channels.length === 0 ? (
              <p className="text-xs text-ink-4">No channels found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-medium text-ink-4 uppercase tracking-wide border-b border-ink/8">
                      <th className="text-left py-2 font-medium">Channel</th>
                      <th className="text-left py-2 font-medium">Platform</th>
                      <th className="text-right py-2 font-medium">Posts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/6">
                    {channels.map((c) => (
                      <tr key={c.accountId}>
                        <td className="py-2.5 pr-3">
                          <Link href={`/accounts/${c.accountId}`} className="font-medium text-ink hover:text-indigo transition-colors">
                            {c.displayName}
                          </Link>
                          <span className="text-[11px] text-ink-4 font-mono ml-2">{fmtHandle(c.handle)}</span>
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className="text-xs text-ink-4 bg-ink/5 rounded-full px-2 py-0.5">{cap(c.platform)}</span>
                        </td>
                        <td className="py-2.5 text-right font-semibold text-terra tabular-nums">{c.postCount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Results list — grouped by canonicalKey */}
          <div className="v3-card p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-terra" />
              <p className="font-semibold text-ink">Posts</p>
              <span className="ml-auto text-xs text-ink-4">{groupedPosts.length} unique link{groupedPosts.length !== 1 ? "s" : ""}</span>
            </div>
            {groupedPosts.length === 0 ? (
              <p className="text-xs text-ink-4">No posts found.</p>
            ) : (
              <ul className="space-y-2">
                {groupedPosts.map((g) => {
                  const p = g.lead;
                  const isDup = p.dupCount > 1;
                  return (
                    <li key={p.canonicalKey} className="rounded-xl border border-ink/8 px-4 py-3">
                      <div className="flex items-start gap-3">
                        <span className="text-xs text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0 mt-0.5">{cap(p.platform)}</span>
                        <div className="flex-1 min-w-0">
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-ink hover:text-indigo transition-colors truncate max-w-full"
                            title={p.url}
                          >
                            <span className="truncate">{p.url}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                          <p className="text-[11px] text-ink-4 mt-0.5">
                            {p.account.displayName} <span className="font-mono">{fmtHandle(p.account.handle)}</span>
                            {" · "}submitted by <span className="font-medium text-ink-3">{p.employee.name}</span>
                            {" · "}{fmtDate(p.date)}
                          </p>
                        </div>
                        {isDup && (
                          <span className="shrink-0 text-[10px] font-bold text-attention bg-attention/10 rounded-full px-2 py-0.5">
                            ×{p.dupCount} submissions
                          </span>
                        )}
                      </div>

                      {/* Per-submission list when duplicated */}
                      {isDup && (
                        <div className="mt-2 pl-3 border-l-2 border-ink/8 space-y-1">
                          {g.subs.map((s, i) => (
                            <p key={`${s.employee.id}-${s.date}-${i}`} className="text-[11px] text-ink-4">
                              <span className="font-medium text-ink-3">{s.employee.name}</span>
                              {" · "}{fmtDate(s.date)}
                              {" · "}<span className="font-mono">{fmtHandle(s.account.handle)}</span>
                            </p>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {/* Empty / zero state */}
      {!loadingFresh && submitted && !entity && disambiguation.length === 0 && data && (
        <div className="v3-card p-8 text-center space-y-2">
          <Users className="h-7 w-7 text-ink-4 mx-auto" />
          <p className="text-sm font-medium text-ink">No posts found for &ldquo;{submitted}&rdquo;.</p>
          <p className="text-xs text-ink-4 max-w-md mx-auto">
            {coverage
              ? `Only ${(coverage.nameSearchable ?? coverage.searchable ?? 0).toLocaleString()} of ${(coverage.submitted ?? coverage.total ?? 0).toLocaleString()} submitted links are searchable by name so far — this person may have posts that aren't tagged yet (check back as enrichment catches up).`
              : "Try a different name or check the spelling."}
          </p>
        </div>
      )}
    </div>
  );
}
