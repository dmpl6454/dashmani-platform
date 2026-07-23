"use client";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ArrowUpDown, ArrowUp, ArrowDown, Link2 } from "lucide-react";
import { useTrueLinks } from "@/lib/hooks/use-reports";

/**
 * True Links panel — dedupe-aware stats for the Reports page.
 *
 * Shows, for the ACTIVE filters (window pills + employee dropdown):
 *   • True Links  — distinct posts by canonicalKey (the same arbiter submit-time
 *     dedupe and the exports use), vs the raw submission count.
 *   • Cross-employee duplicates — links ≥2 DIFFERENT employees posted (allowed;
 *     surfaced for visibility, team-membership-independent).
 * Expands into a client-side-sortable per-employee leaderboard: who shares the
 * most duplicate links, who owns the most unique links.
 *
 * Safety properties (deliberate):
 *   • Own SWR hook + own API endpoint (server-side 60s TTL cache) — it NEVER
 *     touches or waits on the existing summary; the rest of the page renders
 *     exactly as before while this loads.
 *   • The endpoint always returns the TEAM-WIDE breakdown; employee scoping is a
 *     pure client-side lookup into byEmployee (dup detection must see the whole
 *     team to mean anything — same rule as the export's shared-by column).
 *   • Sorting is client-side over ~90 in-memory rows — zero refetches.
 *   • Calm failure: on error the card shows an honest note and SWR retries;
 *     it can never crash or reload the page.
 */

interface EmpRow {
  id: string;
  name: string;
  totalSubmissions: number;
  distinctLinks: number;
  sharedDupLinks: number;
  trueUniqueLinks: number;
}

interface Breakdown {
  totalSubmissions: number;
  trueLinks: number;
  crossEmployeeDupLinks: number;
  crossEmployeeDupSubmissions: number;
  byEmployee: EmpRow[];
}

type SortKey = "sharedDupLinks" | "trueUniqueLinks" | "distinctLinks" | "totalSubmissions" | "dupRate" | "name";

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: "name", label: "Employee", title: "Sort by name" },
  { key: "sharedDupLinks", label: "Shared Dup Links", title: "Links this person posted that at least one OTHER employee also posted" },
  { key: "trueUniqueLinks", label: "True Unique Links", title: "Distinct links ONLY this person posted" },
  { key: "distinctLinks", label: "Distinct Links", title: "This person's distinct posts (their own repeats collapsed)" },
  { key: "totalSubmissions", label: "Submitted", title: "All link rows this person submitted in the window" },
  { key: "dupRate", label: "Dup Rate", title: "Shared duplicate links ÷ distinct links" },
];

function dupRate(r: EmpRow): number {
  return r.distinctLinks > 0 ? r.sharedDupLinks / r.distinctLinks : 0;
}

const nf = new Intl.NumberFormat("en-IN");

export function TrueLinksPanel({
  startDate,
  endDate,
  employeeId,
  windowLabel,
}: {
  startDate: string;
  endDate: string;
  employeeId?: string;
  windowLabel: string;
}) {
  const { data, isLoading, error } = useTrueLinks(startDate, endDate);
  const breakdown = (data as any)?.data as Breakdown | undefined;
  // Failed with nothing loaded: show "—", never a fabricated 0 (a real 0 means
  // "no links in this window", which we cannot honestly claim on a fetch error).
  const failed = !!error && !breakdown;

  const [expanded, setExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("sharedDupLinks");
  const [sortAsc, setSortAsc] = useState(false);

  const rows = breakdown?.byEmployee ?? [];
  const scopedRow = employeeId ? rows.find((r) => r.id === employeeId) : undefined;

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let d: number;
      if (sortKey === "name") d = a.name.localeCompare(b.name);
      else if (sortKey === "dupRate") d = dupRate(a) - dupRate(b);
      else d = a[sortKey] - b[sortKey];
      // Tiebreak OUTSIDE the asc/desc negation so tied blocks always read A→Z
      // (negating the tiebreak would render ties Z→A under every desc sort).
      return (sortAsc ? d : -d) || a.name.localeCompare(b.name);
    });
    return copy;
  }, [rows, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === "name"); // names read A→Z; numbers read big→small
    }
  }

  // Headline values: team totals, or the selected employee's slice of them.
  // A number renders ONLY from loaded data — "—" covers loading, a failed fetch
  // with nothing cached, and the hook's plausibility-gated (null-key) state; a
  // literal 0 must always mean "loaded and truly zero", never "couldn't load".
  // The employee sub shows unique + shared = distinct explicitly so the visible
  // arithmetic closes ("submitted" can exceed distinct via their own same-window
  // repeats — labeled as such, never left to look like missing links).
  const headline = employeeId
    ? {
        value: !breakdown ? "—" : scopedRow?.trueUniqueLinks ?? 0,
        label: "True Unique Links",
        sub: !breakdown
          ? windowLabel.toLowerCase()
          : scopedRow
          ? `+ ${nf.format(scopedRow.sharedDupLinks)} shared with others = ${nf.format(scopedRow.distinctLinks)} distinct · ${nf.format(scopedRow.totalSubmissions)} submitted · ${windowLabel.toLowerCase()}`
          : `no links in this window · ${windowLabel.toLowerCase()}`,
      }
    : {
        value: !breakdown ? "—" : breakdown.trueLinks,
        label: "True Links",
        sub: breakdown
          ? `of ${nf.format(breakdown.totalSubmissions)} submitted · ${windowLabel.toLowerCase()}`
          : windowLabel.toLowerCase(),
      };

  const dupChip = employeeId
    ? scopedRow && scopedRow.sharedDupLinks > 0
      ? `${nf.format(scopedRow.sharedDupLinks)} shared with others`
      : null
    : breakdown && breakdown.crossEmployeeDupLinks > 0
    ? `${nf.format(breakdown.crossEmployeeDupLinks)} links posted by 2+ people (${nf.format(breakdown.crossEmployeeDupSubmissions)} submissions)`
    : null;

  return (
    <div className="bg-white rounded-2xl border border-[#E8E0D0] transition-shadow duration-200 hover:shadow-[0_8px_32px_rgba(0,0,0,0.06)]">
      {/* Header / collapsed summary */}
      <div className="p-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="h-10 w-10 rounded-xl bg-emerald-50 shadow-[0_2px_8px_rgba(16,185,129,0.12)] flex items-center justify-center shrink-0">
          <Link2 className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[#7A7A7A] font-medium">{headline.label}</p>
          {/* Raw (ungrouped) headline number — matches the neighboring stat cards,
              which render values unformatted. Grouped formatting stays in the
              chips/table below where digit density is higher. headline.value is
              already "—" for every no-data state (loading/failed/gated). */}
          <p className="font-num font-light text-[32px] text-[#1A1A1A] leading-tight">
            {headline.value}
          </p>
          <p className="text-xs text-[#B0B0B0] mt-0.5">{headline.sub}</p>
        </div>
        {!isLoading && dupChip && (
          <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-3 py-1.5">
            {dupChip}
          </span>
        )}
        {/* Gate on rows presence only (NOT !error): with stale data + a failed
            revalidation the table can still render, so its collapse control must
            stay mounted — otherwise an expanded table gets orphaned open. */}
        {!isLoading && rows.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1A1A1A] bg-[#FEFCF8] border border-[#E8E0D0] rounded-full px-3 py-1.5 hover:shadow-sm transition-shadow"
          >
            {expanded ? "Hide breakdown" : "By employee"}
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
        {failed && (
          <span className="text-xs text-[#B0B0B0]">Couldn&apos;t load — retrying quietly</span>
        )}
      </div>

      {/* Expanded: sortable per-employee leaderboard (team-wide; selected employee highlighted) */}
      {expanded && rows.length > 0 && (
        <div className="border-t border-[#F0EAD9]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left">
                  {COLUMNS.map((col) => {
                    const active = sortKey === col.key;
                    const Arrow = !active ? ArrowUpDown : sortAsc ? ArrowUp : ArrowDown;
                    return (
                      <th
                        key={col.key}
                        title={col.title}
                        className={`px-5 py-3 text-[11px] font-semibold uppercase tracking-wide select-none cursor-pointer whitespace-nowrap ${
                          active ? "text-[#1A1A1A]" : "text-[#9A9A9A]"
                        } ${col.key !== "name" ? "text-right" : ""}`}
                        onClick={() => toggleSort(col.key)}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          <Arrow className="h-3 w-3" />
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const isSelected = employeeId === r.id;
                  const rate = dupRate(r);
                  return (
                    <tr
                      key={r.id}
                      className={`border-t border-[#F5F0E4] ${
                        isSelected ? "bg-amber-50/60" : "hover:bg-[#FEFCF8]"
                      }`}
                    >
                      <td className="px-5 py-2.5 font-medium text-[#1A1A1A] whitespace-nowrap">
                        {r.name}
                        {isSelected && (
                          <span className="ml-2 text-[10px] font-semibold text-amber-600 uppercase">selected</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right font-num tabular-nums">
                        {r.sharedDupLinks > 0 ? (
                          <span className="font-semibold text-emerald-700 bg-emerald-50 rounded-md px-2 py-0.5">
                            {nf.format(r.sharedDupLinks)}
                          </span>
                        ) : (
                          <span className="text-[#C9C2B2]">0</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right font-num tabular-nums">{nf.format(r.trueUniqueLinks)}</td>
                      <td className="px-5 py-2.5 text-right font-num tabular-nums text-[#7A7A7A]">{nf.format(r.distinctLinks)}</td>
                      <td className="px-5 py-2.5 text-right font-num tabular-nums text-[#7A7A7A]">{nf.format(r.totalSubmissions)}</td>
                      <td className="px-5 py-2.5 text-right font-num tabular-nums text-[#7A7A7A]">
                        {(rate * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-[11px] text-[#B0B0B0] border-t border-[#F5F0E4]">
            &ldquo;Shared&rdquo; means at least one <em>other</em> employee posted the same post (any team) —
            allowed, shown for visibility. Counting uses the same link-identity rules as submission dedupe,
            so tracking-token variants of one post count once.
          </p>
        </div>
      )}
    </div>
  );
}
