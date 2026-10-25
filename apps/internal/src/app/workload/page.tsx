"use client";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useWorkload } from "@/lib/hooks/use-accounts";
import { usePageTitle } from "@/lib/hooks/use-page-title";

// Initials avatar, same palette as the Employees page.
const AV_BG = ["var(--hx-10222E)", "var(--hx-0E2A22)", "var(--hx-1B1630)", "var(--hx-2A2410)", "var(--hx-2A1116)"];
const AV_FG = ["var(--hx-238BFF)", "var(--hx-34D399)", "var(--hx-9B7EDE)", "var(--hx-E9BD62)", "var(--hx-FB7185)"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};

// Platform tile: name, short label, colour (mockup palette).
const PLATFORM: Record<string, [string, string, string]> = {
  instagram: ["Instagram", "IG", "var(--hx-EC42B7)"],
  facebook: ["Facebook", "FB", "var(--hx-238BFF)"],
  youtube: ["YouTube", "YT", "var(--hx-FF5A5F)"],
  snapchat: ["Snapchat", "SC", "var(--hx-E9D23A)"],
  linkedin: ["LinkedIn", "IN", "var(--hx-4AA3DF)"],
  twitter: ["X / Twitter", "X", "var(--hx-A7B3C2)"],
  x: ["X / Twitter", "X", "var(--hx-A7B3C2)"],
  tiktok: ["TikTok", "TT", "var(--hx-25F4EE)"],
};
function platformOf(slug?: string, name?: string): [string, string, string] {
  const k = (slug || name || "").toLowerCase();
  return PLATFORM[k] ?? [name || slug || "Other", (name || slug || "?").slice(0, 2).toUpperCase(), "var(--hx-738395)"];
}
const tint = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

// Load = accounts + open tasks. Same thresholds the page always used to colour the Accounts figure.
type BandKey = "over" | "busy" | "ok";
const BANDS: { key: BandKey; label: string; color: string; rule: string; test: (l: number) => boolean }[] = [
  { key: "over", label: "Overloaded", color: "var(--hx-FB7185)", rule: "load above 15", test: (l) => l > 15 },
  { key: "busy", label: "Busy", color: "var(--hx-FBBF24)", rule: "load 9–15", test: (l) => l > 8 && l <= 15 },
  { key: "ok", label: "Balanced", color: "var(--hx-00D7A0)", rule: "load 8 or less", test: (l) => l <= 8 },
];
const bandOf = (l: number) => BANDS.find((b) => b.test(l)) ?? BANDS[2];

type SortKey = "load" | "name" | "team" | "acc" | "tasks" | "crit" | "high";
const HEADS: { label: string; key: SortKey | null; align: "left" | "center" }[] = [
  { label: "Employee", key: "name", align: "left" },
  { label: "Team", key: "team", align: "left" },
  { label: "Accounts", key: "acc", align: "center" },
  { label: "Open Tasks", key: "tasks", align: "center" },
  { label: "Critical", key: "crit", align: "center" },
  { label: "High", key: "high", align: "center" },
  { label: "Assigned Accounts", key: null, align: "left" },
];
const GRID =
  "grid gap-3.5 items-center [grid-template-columns:minmax(210px,1.4fr)_minmax(110px,.8fr)_80px_90px_70px_64px_minmax(360px,2.4fr)]";

type Row = {
  id: string; name: string; team: string; acc: number; tasks: number; crit: number; high: number; load: number;
  accounts: { id: string; handle: string; platform: [string, string, string] }[];
};

export default function WorkloadPage() {
  usePageTitle("Workload");
  const { data, isLoading, error } = useWorkload();
  const employees = (data as any)?.data || [];

  const [search, setSearch] = useState("");
  const [team, setTeam] = useState("");
  const [band, setBand] = useState<BandKey | "">("");
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "load", dir: -1 });

  const all: Row[] = useMemo(
    () =>
      employees.map((e: any) => {
        const acc = e.accountCount ?? 0;
        const tasks = e.openTaskCount ?? 0;
        return {
          id: e.id,
          name: e.name ?? "—",
          team: e.team?.name ?? "",
          acc,
          tasks,
          crit: e.tasksByPriority?.critical ?? 0,
          high: e.tasksByPriority?.high ?? 0,
          load: acc + tasks,
          accounts: (e.accounts ?? []).map((a: any) => ({
            id: a.id,
            handle: a.handle ?? "",
            platform: platformOf(a.platform?.slug, a.platform?.name),
          })),
        };
      }),
    [employees],
  );

  const teams = useMemo(() => [...new Set(all.map((e) => e.team).filter(Boolean))].sort(), [all]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const f = all.filter(
      (e) =>
        (!team || e.team === team) &&
        (!band || bandOf(e.load).key === band) &&
        (!q || `${e.name} ${e.team} ${e.accounts.map((a) => a.handle).join(" ")}`.toLowerCase().includes(q)),
    );
    const k = sort.k;
    return [...f].sort((x, y) => {
      const a = x[k], b = y[k];
      const c = typeof a === "string" ? a.localeCompare(b as string) : (a as number) - (b as number);
      return c * sort.dir || x.name.localeCompare(y.name);
    });
  }, [all, search, team, band, sort]);

  const totalAcc = all.reduce((s, e) => s + e.acc, 0);
  const totalTasks = all.reduce((s, e) => s + e.tasks, 0);
  const totalLoad = totalAcc + totalTasks;

  const clickHead = (key: SortKey | null) => {
    if (!key) return;
    setSort((s) => ({ k: key, dir: s.k === key ? ((-s.dir) as 1 | -1) : key === "name" || key === "team" ? 1 : -1 }));
  };

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="pt-[26px] pb-5">
        <div className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Work</div>
        <h1 className="mt-2 text-[28px] font-semibold tracking-[-.02em] text-ds-text">Workload Matrix</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2 [text-wrap:pretty]">
          Employee account assignments and open task load at a glance.
        </p>
      </section>

      {/* Total load + bands */}
      <section className="relative rounded-[12px] bg-[linear-gradient(180deg,var(--hx-0B1A27)_0%,var(--hx-08131C)_75%)] border border-[color:var(--hx-1D3444)] overflow-hidden">
        <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
        <div className="flex flex-wrap gap-x-10 gap-y-6 px-7 pt-[26px] pb-[22px] items-end">
          <div className="flex-none min-w-0">
            <div className="text-[10.5px] tracking-[.22em] uppercase text-ds-t2 font-semibold">Total Load</div>
            <div className="flex items-baseline gap-3 mt-2.5 flex-wrap">
              <span className="text-[60px] font-semibold tracking-[-.04em] leading-[.9] text-ds-text">
                {isLoading && !data ? "—" : totalLoad.toLocaleString("en-IN")}
              </span>
              <span className="text-[13px] text-ds-t3 whitespace-nowrap">accounts + open tasks</span>
            </div>
            <div className="text-[12px] text-ds-t2 mt-3">
              {isLoading && !data ? "Loading…" : `${totalAcc} accounts · ${totalTasks} open tasks · ${all.length} employees`}
            </div>
          </div>
          <div className="flex flex-wrap flex-[1_1_360px] sm:justify-end">
            {BANDS.map((b) => {
              const n = all.filter((e) => b.test(e.load)).length;
              const on = !band || band === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setBand((cur) => (cur === b.key ? "" : b.key))}
                  aria-pressed={band === b.key}
                  title={band === b.key ? "Show all" : `Show only ${b.label.toLowerCase()}`}
                  className="flex-[1_1_120px] max-w-[200px] text-left py-1 px-[22px] border-l border-[color:var(--hx-1D3444)] text-ds-text transition-opacity"
                  style={{ opacity: on ? 1 : 0.45 }}
                >
                  <div className="flex items-center gap-[7px] text-[10px] tracking-[.16em] uppercase text-ds-t3 font-semibold whitespace-nowrap">
                    <i className="h-[7px] w-[7px] rounded-full" style={{ background: b.color }} />
                    {b.label}
                  </div>
                  <div className="text-[28px] font-semibold tracking-[-.03em] mt-2" style={{ color: b.color }}>
                    {isLoading && !data ? "—" : n}
                  </div>
                  <div className="text-[10.5px] text-ds-t3 mt-[3px] whitespace-nowrap">{b.rule}</div>
                </button>
              );
            })}
          </div>
        </div>
        {all.length > 0 && (
          <div className="flex gap-[3px] h-2 mx-7 mb-6 rounded-[4px] overflow-hidden">
            {BANDS.map((b) => {
              const n = all.filter((e) => b.test(e.load)).length;
              return n ? <div key={b.key} style={{ width: `${(n / all.length) * 100}%`, background: b.color }} /> : null;
            })}
          </div>
        )}
      </section>

      {/* Filters */}
      <section className="flex items-center gap-2.5 flex-wrap mt-[18px]">
        <label className="flex items-center gap-2 h-[34px] px-3 rounded-full bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_280px] min-w-[200px] max-w-full">
          <Search className="h-[13px] w-[13px] shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee, team or handle…"
            aria-label="Search employee, team or handle"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[16px] sm:text-[12px] placeholder:text-ds-t3"
          />
        </label>
        {teams.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {["", ...teams].map((t) => {
              const sel = team === t;
              return (
                <button
                  key={t || "__all"}
                  type="button"
                  onClick={() => setTeam(t)}
                  aria-pressed={sel}
                  className={`h-[26px] px-[11px] rounded-full border text-[11px] font-semibold whitespace-nowrap transition-colors ${
                    sel
                      ? "border-[rgba(233,189,98,.55)] bg-[rgba(233,189,98,.14)] text-ds-text"
                      : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text"
                  }`}
                >
                  {t || "All teams"}
                </button>
              );
            })}
          </div>
        )}
        <span className="ml-auto text-[11px] text-ds-t3 whitespace-nowrap">
          {list.length} of {all.length} employees
        </span>
      </section>

      {/* Matrix */}
      <section className="mt-3 bg-ds-card border border-ds-line rounded-[10px] overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[1080px]">
            <div className={`${GRID} px-[22px] py-[11px] text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold border-b border-ds-line bg-[color:var(--hx-0A1620)]`}>
              {HEADS.map((h, i) => {
                const active = h.key !== null && sort.k === h.key;
                const cls = `${h.align === "center" ? "text-center" : "text-left"} whitespace-nowrap uppercase tracking-[.12em] ${active ? "text-ds-text" : ""}`;
                const inner = (
                  <>
                    {h.label}
                    {active && <span className="text-ds-gold ml-1 normal-case">{sort.dir < 0 ? "▼" : "▲"}</span>}
                  </>
                );
                const sticky = i === 0 ? "sticky left-0 z-[1] bg-[color:var(--hx-0A1620)] -my-[11px] -ml-[22px] py-[11px] pl-[22px]" : "";
                return h.key ? (
                  <button key={h.label} type="button" onClick={() => clickHead(h.key)} className={`${cls} ${sticky} hover:text-ds-text`}>
                    {inner}
                  </button>
                ) : (
                  <span key={h.label} className={cls}>{inner}</span>
                );
              })}
            </div>

            {isLoading && !data ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`${GRID} px-[22px] py-3 border-b border-[color:var(--hx-101E29)]`}>
                  <div className="flex items-center gap-[11px]">
                    <div className="h-8 w-8 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <div className="h-3.5 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  </div>
                  <div className="h-3.5 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                </div>
              ))
            ) : error ? (
              <div className="px-[22px] py-12 text-center text-ds-t3 text-[12.5px]">The workload couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : list.length === 0 ? (
              <div className="px-[22px] py-12 text-center text-ds-t3 text-[12.5px]">
                {all.length === 0 ? "No employees to show yet." : "No employees match these filters"}
              </div>
            ) : (
              list.map((e) => {
                const k = hash(e.name) % 5;
                const color = bandOf(e.load).color;
                return (
                  <div key={e.id} className={`group ${GRID} px-[22px] py-3 border-b border-[color:var(--hx-101E29)] last:border-b-0 text-[12.5px] hover:bg-[color:var(--hx-0B1824)]`}>
                    <span className="sticky left-0 z-[1] flex items-center gap-[11px] min-w-0 -my-3 -ml-[22px] py-3 pl-[22px] self-stretch bg-ds-card group-hover:bg-[color:var(--hx-0B1824)] shadow-[1px_0_0_#101E29]">
                      <span
                        aria-hidden="true"
                        className="h-8 w-8 rounded-full border border-ds-line2 grid place-items-center text-[12px] font-bold shrink-0"
                        style={{ background: AV_BG[k], color: AV_FG[k] }}
                      >
                        {e.name.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                      <span className="flex-1 min-w-0 font-semibold text-ds-text truncate" title={e.name}>{e.name}</span>
                    </span>
                    <span className="text-ds-t2 truncate" title={e.team || undefined}>{e.team || "—"}</span>
                    <span className="text-center font-semibold" style={{ color }} title={`Load ${e.load} (accounts + open tasks)`}>{e.acc}</span>
                    <span className="text-center text-ds-t5">{e.tasks}</span>
                    <span className="text-center">
                      {e.crit > 0 ? (
                        <span className="inline-grid place-items-center min-w-[26px] h-[22px] px-2 rounded-full bg-[rgba(251,113,133,.12)] border border-[rgba(251,113,133,.3)] text-[color:var(--hx-FB7185)] text-[11px] font-bold">{e.crit}</span>
                      ) : (
                        <span className="text-[color:var(--hx-33506A)]">—</span>
                      )}
                    </span>
                    <span className="text-center">
                      {e.high > 0 ? (
                        <span className="inline-grid place-items-center min-w-[26px] h-[22px] px-2 rounded-full bg-[rgba(251,191,36,.1)] border border-[rgba(251,191,36,.28)] text-[color:var(--hx-FBBF24)] text-[11px] font-bold">{e.high}</span>
                      ) : (
                        <span className="text-[color:var(--hx-33506A)]">—</span>
                      )}
                    </span>
                    <span className="flex flex-wrap gap-1 min-w-0 max-h-12 overflow-hidden">
                      {e.accounts.slice(0, 3).map((a) => (
                        <span
                          key={a.id}
                          title={a.platform[0]}
                          className="inline-flex items-center gap-[5px] h-[22px] pl-[3px] pr-2 rounded-full bg-ds-inset border border-ds-line text-ds-t5 text-[10.5px] font-medium whitespace-nowrap max-w-[220px]"
                        >
                          <span
                            className="h-4 w-4 rounded-[5px] grid place-items-center text-[7.5px] font-extrabold shrink-0"
                            style={{ background: tint(a.platform[2], 0.16), color: a.platform[2] }}
                          >
                            {a.platform[1]}
                          </span>
                          <span className="truncate">{a.handle}</span>
                        </span>
                      ))}
                      {e.accounts.length > 3 && (
                        <span
                          title={e.accounts.slice(3).map((a) => a.handle).join(", ")}
                          className="h-[22px] px-2 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold text-[10.5px] font-bold inline-flex items-center"
                        >
                          +{e.accounts.length - 3}
                        </span>
                      )}
                      {e.accounts.length === 0 && <span className="text-[color:var(--hx-33506A)]">—</span>}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
