"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft, Search, Link2, Layers, Copy, Globe, Users,
  Info, AlertTriangle, ExternalLink, X as CloseIcon, Download,
} from "lucide-react";
import { useLinkSearch, useEntitySuggestions } from "@/lib/hooks/use-link-search";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { apiFetchBlob, downloadBlob } from "@/lib/api";

function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return d; }
}

// "PERSON" / "person" → "Person".
function cap(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

// Render a handle with exactly ONE leading "@". Some stored social_accounts handles
// already include a leading "@" (e.g. "@BollywoodChronicle"), which the old `@{handle}`
// render turned into "@@BollywoodChronicle". Strip any leading @'s, then prepend one.
function fmtHandle(handle: string) {
  return `@${(handle || "").replace(/^@+/, "")}`;
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

// Mockup palette.
const PLATFORM_COLOR: Record<string, string> = { youtube: "var(--hx-FB7185)", instagram: "var(--hx-F472B6)", facebook: "var(--hx-6EB2FF)", snapchat: "var(--hx-FACC15)" };
const PLATFORM_LABEL: Record<string, string> = { youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", snapchat: "Snapchat" };
const TYPE_COLOR: Record<string, string> = { person: "var(--hx-E9BD62)", show: "var(--hx-9B7EDE)", topic: "var(--hx-6EB2FF)", brand: "var(--hx-00D7A0)" };
const pColor = (p?: string) => PLATFORM_COLOR[(p ?? "").toLowerCase()] ?? "var(--hx-A7B3C2)";
const pLabel = (p?: string) => PLATFORM_LABEL[(p ?? "").toLowerCase()] ?? cap(p ?? "—");
const tColor = (t?: string) => TYPE_COLOR[(t ?? "").toLowerCase()] ?? "var(--hx-A7B3C2)";
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const nf = (n: number) => n.toLocaleString("en-IN");

function Chip({ color, children, className = "" }: { color: string; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center h-[22px] px-[9px] rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 ${className}`}
      style={{ background: rgba(color, 0.12), color }}
    >
      {children}
    </span>
  );
}

const CARD = "flex flex-col min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]";
const CARD_HEAD = "flex items-center justify-between gap-x-4 gap-y-3 min-h-[62px] px-6 py-3 border-b border-ds-line flex-wrap";

export default function LinkSearchPage() {
  usePageTitle("Link Search");

  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [covOpen, setCovOpen] = useState(false);
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

  const { data, isValidating } = useLinkSearch(submitted);
  const { data: suggestions } = useEntitySuggestions(q);

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
    <div className="pb-8">
      {/* Header */}
      <section className="pt-[22px]">
        <Link href="/reports" className="inline-flex items-center gap-2 text-[13.5px] font-medium text-ds-t2 hover:text-ds-text">
          <ArrowLeft className="h-[15px] w-[15px]" /> Reports
        </Link>
      </section>
      <section className="pt-3.5 pb-5">
        <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Link Search</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">Find every uploaded post for a person across all of their channels.</p>
      </section>

      {/* Search bar with entity autocomplete */}
      <section ref={wrapRef} className="relative max-w-[760px]">
        <form onSubmit={(e) => { e.preventDefault(); runSearch(q); }} className="flex items-center gap-2.5">
          <label
            className={`flex-1 min-w-0 flex items-center gap-2.5 h-[50px] pl-[18px] pr-2 rounded-full bg-ds-inset border text-ds-t3 transition-colors ${showSuggestions ? "border-[rgba(233,189,98,.5)]" : "border-ds-line2 focus-within:border-[rgba(233,189,98,.5)]"}`}
          >
            <Search className="h-[17px] w-[17px] shrink-0" />
            <input
              type="text"
              value={q}
              onChange={(e) => { setQ(e.target.value); setShowSuggest(true); }}
              onFocus={() => setShowSuggest(true)}
              onKeyDown={(e) => { if (e.key === "Escape") setShowSuggest(false); }}
              placeholder="Search by person's name… (searches as you type)"
              aria-label="Search by person's name"
              className="ds-bare flex-1 min-w-0 bg-transparent border-0 outline-none p-0 text-ds-text text-[16px] sm:text-[14.5px] placeholder:text-ds-t3"
            />
            {q && (
              <button
                type="button"
                onClick={() => { setQ(""); setShowSuggest(false); }}
                className="h-8 w-8 rounded-full grid place-items-center text-ds-t3 hover:text-ds-text hover:bg-[color:var(--hx-132430)] shrink-0"
                aria-label="Clear"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            )}
          </label>
          <button type="submit" className="h-[50px] px-[26px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[14px] font-bold hover:bg-[color:var(--hx-F4D58C)] shrink-0">
            Search
          </button>
        </form>

        {/* Autocomplete dropdown */}
        {showSuggestions && (
          <div className="absolute z-30 left-0 right-0 top-[58px] p-1.5 rounded-[14px] border border-[color:var(--hx-2A4658)] bg-ds-inset shadow-[0_18px_40px_rgba(0,0,0,.55)] overflow-hidden">
            {suggestions!.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => runSearch(s.canonicalName)}
                className="w-full flex items-center gap-2.5 h-[42px] px-3 rounded-[9px] text-left text-ds-text hover:bg-[color:var(--hx-132430)]"
              >
                <span className="flex-1 min-w-0 text-[13.5px] font-semibold truncate">{s.canonicalName}</span>
                <Chip color={tColor(s.type)}>{cap(s.type)}</Chip>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Persistent coverage banner — auto-derived, self-healing accuracy.
          "Searchable of submitted" is the honest framing: a permanently-unsearchable
          link (e.g. opaque facebook.com/share/ links, or posts older than our enrichment window) can never inflate the tally. */}
      {coverage && (() => {
        // Prefer the honest fields; fall back to legacy for older API responses.
        const searchable = coverage.searchable ?? coverage.enriched ?? 0;
        const submittedCount = coverage.submitted ?? coverage.total ?? 0;
        const bp = coverage.byPlatform ?? {};
        // Per-platform rows in a stable, meaningful order. Snapchat is included:
        // resolved Spotlight urls ARE caption-searchable — only ephemeral Story links
        // remain unsearchable (see the honest per-row note below).
        const ORDER = ["youtube", "instagram", "facebook", "snapchat"] as const;
        const rows = ORDER.filter((p) => bp[p]).map((p) => ({ p, ...bp[p]! }));
        const totalPending = coverage.pendingExtraction ?? 0;
        return (
          <section className="mt-[18px] rounded-[14px] border border-[rgba(110,178,255,.25)] bg-[rgba(110,178,255,.05)] overflow-hidden">
            <div className="flex items-start gap-3.5 px-5 py-4 flex-wrap">
              <Info className="h-4 w-4 text-[color:var(--hx-6EB2FF)] shrink-0 mt-0.5" />
              <div className="flex-[1_1_420px] min-w-0 flex flex-col gap-3">
                <p className="text-[13.5px] text-ds-t5">
                  Searching <b className="text-ds-text">{nf(searchable)}</b> searchable
                  {submittedCount > 0 && <> of <b className="text-ds-text">{nf(submittedCount)}</b> submitted</>} links.
                </p>
                {rows.length > 0 && (
                  <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                    {rows.map(({ p, searchable: s, submitted: sub, since, dataSince, pendingExtraction: pPending }) => {
                      const c = pColor(p);
                      const raw = sub ? ((s ?? 0) / sub) * 100 : null;
                      const pct = raw === null ? null : Math.round(raw);
                      // A few hundred of thousands rounds to 0% — say "<1%" so it never reads as none.
                      const pctLabel = raw === null ? "" : raw > 0 && raw < 1 ? "<1%" : `${pct}%`;
                      const notes: string[] = [];
                      // TRUE data-back-to date: how far the submitted links actually go
                      // (min daily_reports.date). Distinct from "captions since" (enrichment).
                      if (dataSince) notes.push(`data since ${fmtDate(dataSince)}`);
                      if (p === "youtube") notes.push("captions: all dates");
                      if ((p === "instagram" || p === "facebook" || p === "snapchat") && since) notes.push(`captions since ${fmtDate(since)}`);
                      if ((pPending ?? 0) > 0) notes.push(`${nf(pPending!)} tagging`);
                      if (p === "snapchat") notes.push("only Spotlights are searchable; Stories have no public captions/stats");
                      return (
                        <div key={p} className="flex flex-col gap-1.5 px-3.5 py-3 rounded-[10px] bg-ds-card border border-ds-line min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-[7px] text-[12.5px] font-semibold text-ds-text">
                              <i className="h-[7px] w-[7px] rounded-full" style={{ background: c }} />
                              {pLabel(p)}
                            </span>
                            {pct !== null && <span className="text-[11.5px] font-semibold" style={{ color: c }}>{pctLabel}</span>}
                          </div>
                          <span className="text-[12px] text-ds-t2">
                            <b className="text-ds-text font-semibold">{nf(s ?? 0)}</b>
                            {sub != null && sub > 0 && <> of {nf(sub)}</>} searchable
                          </span>
                          {pct !== null && (
                            <span className="h-1 rounded-[2px] bg-[color:var(--hx-132430)] overflow-hidden">
                              <span className="block h-full" style={{ width: `${raw! > 0 ? Math.max(raw!, 1) : 0}%`, background: c }} />
                            </span>
                          )}
                          {notes.length > 0 && <span className="text-[11px] leading-[1.45] text-ds-t3">{notes.join(" · ")}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
                {totalPending > 0 && (
                  <p className="text-[12px] text-ds-t3" aria-live="polite">
                    {nf(totalPending)} captured {totalPending === 1 ? "caption is" : "captions are"} still being tagged with people &amp; topics. {totalPending === 1 ? "It" : "They"}&rsquo;ll be searchable by name within a few hours.
                  </p>
                )}
                {covOpen && (
                  <div className="flex flex-col gap-2 pt-3 border-t border-[rgba(110,178,255,.15)] text-[12px] leading-[1.6] text-[color:var(--hx-8B9AAB)]">
                    <p>
                      Two dates, and they mean different things: <b className="text-ds-t5 font-semibold">&ldquo;data since&rdquo;</b> is how far back the
                      submitted links themselves go (the earliest post any employee logged for that platform). That&rsquo;s the true reach of
                      the data. <b className="text-ds-t5 font-semibold">&ldquo;captions since&rdquo;</b> is when we started reading captions for
                      caption-search, which is later. The denominator is every link ever submitted, and &ldquo;searchable&rdquo; counts how many of
                      those we&rsquo;ve captured a caption for, old and new alike. Neither date is a cutoff on which links count.
                    </p>
                    <p>
                      The gap (submitted minus searchable) is mostly Instagram/Facebook posts that have scrolled too far back in
                      their account&rsquo;s feed for Meta to return by link (there&rsquo;s no fetch-by-id), plus opaque{" "}
                      <code className="text-[11px] text-ds-t2">facebook.com/share/</code> links that carry no post id. YouTube has no
                      such limit. These links still exist in the system; they just can&rsquo;t be caption-searched.
                    </p>
                    <p>
                      Enrichment reads each post&rsquo;s caption and tags who&rsquo;s in it, so you can search by name. YouTube and
                      Facebook are read directly from each public post; Instagram is read from the accounts we manage. New posts
                      become searchable automatically. Enrichment runs in the background every couple of hours.
                    </p>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setCovOpen((v) => !v)}
                aria-expanded={covOpen}
                className="h-8 px-3.5 rounded-full border border-[rgba(110,178,255,.3)] text-[color:var(--hx-6EB2FF)] text-[12px] font-semibold whitespace-nowrap shrink-0 hover:bg-[rgba(110,178,255,.08)]"
              >
                {covOpen ? "Hide details" : "How coverage works"}
              </button>
            </div>
          </section>
        );
      })()}

      {/* Idle state — nothing searched yet */}
      {!submitted && !loadingFresh && (
        <section className="mt-4 py-12 px-5 rounded-[16px] border border-dashed border-ds-line2 text-center">
          <Search className="h-6 w-6 text-ds-t3 mx-auto" />
          <div className="mt-3 text-[14px] font-semibold text-ds-t5">Start typing a name to search</div>
          <div className="mt-1.5 text-[12.5px] text-ds-t3">Suggestions appear as you type; results load automatically.</div>
        </section>
      )}

      {/* Loading state — never bare isLoading (keepPreviousData persists data across queries) */}
      {loadingFresh && (
        <section className="mt-4 py-10 px-5 rounded-[16px] border border-ds-line bg-ds-card text-center text-[13px] text-ds-t3">
          Searching…
        </section>
      )}

      {/* Disambiguation — multiple entity matches */}
      {!loadingFresh && disambiguation.length > 0 && (
        <section className={`${CARD} mt-4`}>
          <div className="px-6 py-5 flex flex-col gap-3.5">
            <span className="text-[15px] font-semibold tracking-[-.01em] text-ds-text">Multiple matches. Did you mean:</span>
            <div className="flex flex-wrap gap-2">
              {disambiguation.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => runSearch(d.canonicalName)}
                  className="inline-flex items-center gap-2 h-[38px] px-4 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[13px] font-semibold hover:border-[rgba(233,189,98,.5)]"
                >
                  {d.canonicalName}
                  <span className="text-[10.5px] text-ds-t3">{cap(d.type)}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Results — only when we have an entity and no disambiguation */}
      {!loadingFresh && disambiguation.length === 0 && entity && (
        <>
          {/* Truncation note */}
          {data?.truncated && (
            <div className="mt-4 px-4 py-2.5 rounded-[10px] border border-[rgba(233,189,98,.3)] bg-[rgba(233,189,98,.08)] flex items-center gap-2 text-[12.5px] text-ds-t5">
              <AlertTriangle className="h-4 w-4 text-ds-gold shrink-0" />
              Showing a capped subset; refine your search.
            </div>
          )}

          {/* Entity header */}
          <section className="flex items-center gap-x-3.5 gap-y-2.5 flex-wrap mt-6">
            <h2 className="text-[24px] font-bold tracking-[-.02em] text-ds-text">{entity.canonicalName}</h2>
            <span
              className="inline-flex items-center h-6 px-2.5 rounded-full text-[11.5px] font-semibold"
              style={{ background: rgba(tColor(entity.type), 0.12), color: tColor(entity.type) }}
            >
              {cap(entity.type)}
            </span>
            {entity.aliases.length > 0 && <span className="text-[12.5px] text-ds-t3">aka {entity.aliases.join(", ")}</span>}
            {data!.totalPosts > 0 && (
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="ml-auto inline-flex items-center gap-2 h-10 px-4 rounded-full border border-ds-line2 bg-ds-inset text-ds-t5 text-[13px] font-semibold whitespace-nowrap hover:border-[rgba(0,215,160,.5)] hover:text-ds-text disabled:opacity-60 disabled:cursor-not-allowed"
                aria-label="Export all links to Excel"
                title="Download every link for this person as an Excel sheet"
              >
                <Download className={`h-[15px] w-[15px] text-ds-teal ${exporting ? "animate-pulse" : ""}`} />
                {exporting ? "Preparing…" : "Export to Excel"}
              </button>
            )}
          </section>
          {exportError && (
            <div role="alert" className="mt-2.5 px-3.5 py-2.5 rounded-[10px] border border-[rgba(229,72,77,.3)] bg-[rgba(229,72,77,.08)] flex items-center gap-2 text-[12.5px] text-[color:var(--hx-FB7185)]">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Couldn&rsquo;t export: {exportError}
            </div>
          )}

          {/* Summary strip */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
            {[
              { label: "Total Posts", value: data!.totalPosts, color: "var(--hx-FB7185)", Icon: Link2 },
              { label: "Unique Posts", value: data!.uniquePosts, color: "var(--hx-00D7A0)", Icon: Layers },
              { label: "Duplicates", value: data!.duplicatePosts, color: "var(--hx-E9BD62)", Icon: Copy },
              { label: "Channels", value: data!.channelCount, color: "var(--hx-6EB2FF)", Icon: Globe },
            ].map(({ label, value, color, Icon }) => (
              <div key={label} className="flex flex-col gap-3.5 px-5 py-[18px] rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)] min-w-0">
                <span className="h-8 w-8 rounded-[9px] grid place-items-center" style={{ background: rgba(color, 0.13), color }}>
                  <Icon className="h-[15px] w-[15px]" />
                </span>
                <span className="leading-[1.2]">
                  <span className="block text-[28px] font-bold tracking-[-.04em] tabular-nums text-ds-text whitespace-nowrap">{nf(value)}</span>
                  <span className="text-[12px] text-ds-t3">{label}</span>
                </span>
              </div>
            ))}
          </section>

          <section className="grid gap-4 mt-4 items-start [grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))]">
            {/* Channel breakdown */}
            <div className={CARD}>
              <div className={CARD_HEAD}>
                <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-.01em] text-ds-text whitespace-nowrap">
                  <Globe className="h-4 w-4 text-[color:var(--hx-6EB2FF)]" /> Channel Breakdown
                </span>
                <span className="text-[12px] text-ds-t3">{channels.length} channel{channels.length !== 1 ? "s" : ""}</span>
              </div>
              {channels.length === 0 ? (
                <p className="px-6 py-6 text-[12.5px] text-ds-t3">No channels found.</p>
              ) : (
                <>
                  <div className="grid grid-cols-[minmax(120px,1fr)_96px_60px] gap-x-3 items-center h-[42px] px-5 bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.08em] uppercase text-ds-t3">
                    <span>Channel</span><span>Platform</span><span className="text-right">Posts</span>
                  </div>
                  {channels.map((c) => (
                    <div key={c.accountId} className="grid grid-cols-[minmax(120px,1fr)_96px_60px] gap-x-3 items-center min-h-[60px] py-2 px-5 border-b border-[color:var(--hx-132430)] last:border-b-0">
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.3]">
                        <Link href={`/accounts/${c.accountId}`} className="text-[13.5px] font-semibold text-ds-text truncate hover:text-ds-gold" title={c.displayName}>
                          {c.displayName}
                        </Link>
                        <span className="text-[11.5px] text-ds-t3 truncate">{fmtHandle(c.handle)}</span>
                      </span>
                      <span><Chip color={pColor(c.platform)}>{pLabel(c.platform)}</Chip></span>
                      <span className="text-right text-[15px] font-bold text-ds-gold tabular-nums">{nf(c.postCount)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Results list — grouped by canonicalKey */}
            <div className={CARD}>
              <div className={CARD_HEAD}>
                <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-.01em] text-ds-text whitespace-nowrap">
                  <Link2 className="h-4 w-4 text-[color:var(--hx-FB7185)]" /> Posts
                </span>
                <span className="text-[12px] text-ds-t3">{groupedPosts.length} unique link{groupedPosts.length !== 1 ? "s" : ""}</span>
              </div>
              {groupedPosts.length === 0 ? (
                <p className="px-6 py-6 text-[12.5px] text-ds-t3">No posts found.</p>
              ) : (
                <ul className="flex flex-col">
                  {groupedPosts.map((g) => {
                    const p = g.lead;
                    const isDup = p.dupCount > 1;
                    return (
                      <li key={p.canonicalKey} className="px-5 py-3.5 border-b border-[color:var(--hx-132430)] last:border-b-0">
                        <div className="flex items-start gap-3">
                          <Chip color={pColor(p.platform)} className="mt-px">{pLabel(p.platform)}</Chip>
                          <div className="flex-1 min-w-0 flex flex-col gap-1">
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={p.url}
                              className="flex items-center gap-1.5 min-w-0 text-[13px] text-ds-t5 hover:text-ds-gold"
                            >
                              <span className="truncate min-w-0">{p.url}</span>
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                            <span className="text-[11.5px] leading-[1.5] text-ds-t3">
                              {p.account.displayName} <span className="text-[color:var(--hx-4A6275)]">{fmtHandle(p.account.handle)}</span>
                              {" · "}submitted by <b className="text-ds-t2 font-semibold">{p.employee.name}</b>
                              {" · "}{fmtDate(p.date)}
                            </span>
                          </div>
                          {isDup && (
                            <span className="shrink-0 inline-flex items-center h-[22px] px-[9px] rounded-full bg-[rgba(233,189,98,.12)] text-ds-gold text-[10.5px] font-bold whitespace-nowrap">
                              ×{p.dupCount} submissions
                            </span>
                          )}
                        </div>

                        {/* Per-submission list when duplicated */}
                        {isDup && (
                          <div className="flex flex-col gap-1 mt-2.5 ml-0 sm:ml-[74px] pl-3 border-l-2 border-ds-line2">
                            {g.subs.map((s, i) => (
                              <span key={`${s.employee.id}-${s.date}-${i}`} className="text-[11.5px] text-ds-t3">
                                <b className="text-ds-t2 font-semibold">{s.employee.name}</b>
                                {" · "}{fmtDate(s.date)}
                                {" · "}{fmtHandle(s.account.handle)}
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </>
      )}

      {/* Empty / zero state */}
      {!loadingFresh && submitted && !entity && disambiguation.length === 0 && data && (
        <section className="mt-4 py-11 px-6 rounded-[16px] border border-ds-line bg-ds-card text-center">
          <Users className="h-[26px] w-[26px] text-ds-t3 mx-auto" />
          <div className="mt-3 text-[14px] font-semibold text-ds-text">No posts found for &ldquo;{submitted}&rdquo;.</div>
          <div className="mt-1.5 mx-auto max-w-[460px] text-[12.5px] leading-[1.55] text-ds-t3">
            {coverage
              ? `Only ${nf(coverage.nameSearchable ?? coverage.searchable ?? 0)} of ${nf(coverage.submitted ?? coverage.total ?? 0)} submitted links are searchable by name so far. This person may have posts that aren't tagged yet (check back as enrichment catches up).`
              : "Try a different name or check the spelling."}
          </div>
        </section>
      )}
    </div>
  );
}
