"use client";
// Tasks — premium dark redesign ("ds"), built to the Tasks.dc.html mockup.
// UI only: same /tasks endpoint and links. Tasks carry no project or progress
// field, so the mockup's project slot shows the linked channel and the progress
// bar is omitted rather than invented.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search, LayoutGrid, List, ListChecks, CalendarDays, AlertCircle, CheckSquare, MessageSquare } from "lucide-react";
import { useTasks } from "@/lib/hooks/use-tasks";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUS: Record<string, { label: string; color: string }> = {
  TODO: { label: "To Do", color: "#A7B3C2" },
  IN_PROGRESS: { label: "In Progress", color: "#238BFF" },
  IN_REVIEW: { label: "In Review", color: "#FBBF24" },
  DONE: { label: "Done", color: "#00D7A0" },
  CANCELLED: { label: "Cancelled", color: "#738395" },
};
const COLUMNS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
const PRIO: Record<string, { label: string; color: string }> = {
  CRITICAL: { label: "Critical", color: "#FB7185" },
  HIGH: { label: "High", color: "#FBBF24" },
  MEDIUM: { label: "Medium", color: "#6EB2FF" },
  LOW: { label: "Low", color: "#A7B3C2" },
};
const AV_BG = ["#10222E", "#0E2A22", "#1B1630", "#2A2410", "#2A1116"];
const AV_FG = ["#238BFF", "#34D399", "#9B7EDE", "#E9BD62", "#FB7185"];
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); };
const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const isOpen = (t: any) => t.status !== "DONE" && t.status !== "CANCELLED";
function dueOf(t: any, todayMs: number): { text: string; color: string } {
  if (!t.dueDate) return { text: "—", color: "#738395" };
  const d = new Date(t.dueDate);
  const short = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (!isOpen(t)) return { text: short, color: "#738395" };
  const days = Math.round((startOfDay(d) - todayMs) / DAY);
  if (days < 0) return { text: `${-days}d overdue`, color: "#FB7185" };
  if (days === 0) return { text: "Today", color: "#FBBF24" };
  if (days === 1) return { text: "Tomorrow", color: "#FBBF24" };
  return { text: short, color: "#A7B3C2" };
}
const contextOf = (t: any) => (t.account ? `${t.account.platform?.name ?? ""} · ${t.account.displayName || t.account.handle}`.replace(/^ · /, "") : "");

function Chip({ color, children, caps }: { color: string; children: React.ReactNode; caps?: boolean }) {
  return (
    <span
      className={`inline-flex items-center h-[18px] px-[7px] rounded-[9px] border text-[9.5px] font-bold whitespace-nowrap ${caps ? "uppercase tracking-[.06em]" : ""}`}
      style={{ color, background: rgba(color, 0.1), borderColor: rgba(color, 0.3) }}
    >
      {children}
    </span>
  );
}
function Avatar({ name, size }: { name: string; size: number }) {
  const h = hash(name);
  return (
    <span className="rounded-full border border-ds-line2 grid place-items-center font-bold shrink-0" style={{ width: size, height: size, fontSize: size * 0.42, background: AV_BG[h % 5], color: AV_FG[h % 5] }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

const LIST_GRID = "grid [grid-template-columns:minmax(260px,2.4fr)_120px_100px_minmax(150px,1.2fr)_90px] gap-3";

export default function TasksPage() {
  usePageTitle("Tasks");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const [prio, setPrio] = useState<string>("ALL");
  const { data, isLoading, error } = useTasks({ search });
  const tasks: any[] = (data as any)?.data || [];
  const hasMore: boolean = !!(data as any)?.meta?.has_more;

  const today = new Date();
  const todayMs = startOfDay(today);
  const monthStartMs = new Date(today.getFullYear(), today.getMonth(), 1).getTime();

  const kpi = useMemo(() => {
    const open = tasks.filter(isOpen);
    const dueIn = (t: any) => (t.dueDate ? Math.round((startOfDay(new Date(t.dueDate)) - todayMs) / DAY) : null);
    return {
      open: open.length,
      dueWeek: open.filter((t) => { const d = dueIn(t); return d != null && d >= 0 && d <= 6; }).length,
      overdue: open.filter((t) => { const d = dueIn(t); return d != null && d < 0; }).length,
      doneMonth: tasks.filter((t) => t.status === "DONE" && t.completedAt && new Date(t.completedAt).getTime() >= monthStartMs).length,
    };
  }, [tasks, todayMs, monthStartMs]);

  const visible = prio === "ALL" ? tasks : tasks.filter((t) => t.priority === prio);
  const more = hasMore ? "+" : "";

  const kpis = [
    { label: "Open Tasks", value: kpi.open, color: "#238BFF", icon: ListChecks, note: "open now" },
    { label: "Due This Week", value: kpi.dueWeek, color: "#FBBF24", icon: CalendarDays, note: "next 7 days" },
    { label: "Overdue", value: kpi.overdue, color: "#FB7185", icon: AlertCircle, note: "needs attention" },
    { label: "Completed", value: kpi.doneMonth, color: "#00D7A0", icon: CheckSquare, note: "this month" },
  ];

  return (
    <div className="pb-6">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="basis-full sm:basis-auto sm:flex-1 min-w-0">
          <h1 className="m-0 text-[26px] font-semibold tracking-[-.02em] text-ds-text">Tasks</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {isLoading ? "Loading…" : `${tasks.length}${more} task${tasks.length !== 1 ? "s" : ""} · ${kpi.open}${more} open${kpi.overdue ? ` · ${kpi.overdue} overdue` : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 p-0.5 rounded-[8px] bg-ds-inset border border-ds-line2" role="group" aria-label="View">
            {([["kanban", "Board", LayoutGrid], ["list", "List", List]] as const).map(([k, label, Icon]) => (
              <button
                key={k}
                type="button"
                aria-pressed={view === k}
                onClick={() => setView(k)}
                className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-[11.5px] font-semibold whitespace-nowrap transition-colors ${view === k ? "bg-ds-blue text-white" : "text-ds-t2 hover:text-ds-text"}`}
              >
                <Icon className="h-[13px] w-[13px]" strokeWidth={1.8} />{label}
              </button>
            ))}
          </div>
          <Link href="/tasks/new" className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22] hover:text-ds-gold2">
            <Plus className="h-3.5 w-3.5" /> New Task
          </Link>
        </div>
      </section>

      {/* KPI cards */}
      <section className="grid gap-2.5 sm:gap-3.5 grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="relative overflow-hidden flex flex-col min-[480px]:flex-row gap-2.5 min-[480px]:gap-3.5 min-[480px]:items-center p-3 sm:p-4 rounded-[8px] bg-ds-card border border-ds-line">
              <span className="absolute inset-x-0 top-0 h-0.5 opacity-80" style={{ background: k.color }} />
              <span className="h-10 w-10 rounded-[10px] grid place-items-center shrink-0" style={{ background: rgba(k.color, 0.13), color: k.color }}>
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-ds-t5">{k.label}</span>
                <span className="flex items-baseline gap-2 mt-1.5 whitespace-nowrap">
                  <span className="text-[26px] font-semibold tracking-[-.02em] leading-none text-ds-text">{isLoading ? "—" : `${k.value}${more}`}</span>
                  <span className="text-[11px] text-ds-t3 truncate">{k.note}</span>
                </span>
              </span>
            </div>
          );
        })}
      </section>

      {/* Search + priority filter */}
      <section className="flex items-center gap-3 flex-wrap mt-3.5">
        <label className="flex items-center gap-2 h-[34px] px-3 rounded-[17px] bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_320px] min-w-[200px] w-full sm:w-auto">
          <Search className="h-[13px] w-[13px] shrink-0" strokeWidth={1.8} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            aria-label="Search tasks"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[12px] placeholder:text-ds-t3"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Priority">
          {[["ALL", "All priorities", "#E9BD62"] as const, ...Object.entries(PRIO).map(([k, p]) => [k, p.label, p.color] as const)].map(([k, label, dot]) => {
            const sel = prio === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={sel}
                onClick={() => setPrio(k)}
                className={`inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-[13px] border text-[11px] font-semibold whitespace-nowrap transition-colors ${sel ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-text" : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text"}`}
              >
                <i className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />{label}
              </button>
            );
          })}
        </div>
      </section>

      {error && tasks.length === 0 ? (
        <section role="alert" className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line px-5 py-12 text-center text-[12.5px] text-ds-t2">
          Couldn&apos;t load tasks. Refresh the page to try again.
        </section>
      ) : view === "kanban" ? (
        /* ── Board ── */
        <section className="grid gap-3.5 mt-3.5 items-start grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((s) => {
            const st = STATUS[s];
            const col = visible.filter((t) => t.status === s);
            return (
              <div key={s} className="rounded-[8px] bg-ds-card border border-ds-line p-3 min-w-0">
                <div className="flex items-center gap-2 px-1 pt-1 pb-3">
                  <i className="h-2 w-2 rounded-full" style={{ background: st.color, boxShadow: `0 0 0 3px ${rgba(st.color, 0.15)}` }} />
                  <span className="flex-1 text-[11px] font-bold tracking-[.12em] uppercase text-ds-t5">{st.label}</span>
                  <span className="h-5 min-w-[22px] px-[7px] rounded-[10px] bg-ds-hover text-ds-t2 text-[10.5px] font-bold grid place-items-center">{isLoading ? "–" : col.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {isLoading ? (
                    Array.from({ length: 2 }, (_, i) => <div key={i} className="h-[104px] rounded-[8px] bg-ds-inset border border-ds-line motion-safe:animate-pulse" aria-hidden="true" />)
                  ) : col.length === 0 ? (
                    <div className="py-5 text-center text-[11px] text-ds-t3 border border-dashed border-ds-line rounded-[8px]">No tasks</div>
                  ) : (
                    col.map((t) => {
                      const p = PRIO[t.priority] ?? PRIO.LOW;
                      const due = dueOf(t, todayMs);
                      const who = t.assignee?.name as string | undefined;
                      const ctx = contextOf(t);
                      return (
                        <Link key={t.id} href={`/tasks/${t.id}`} className="flex flex-col gap-2.5 p-3 rounded-[8px] bg-ds-inset border border-ds-line text-ds-text transition-colors hover:border-ds-line3 hover:bg-[#0D1B26]">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <Chip color={p.color} caps>{p.label}</Chip>
                            {ctx && <span className="ml-auto text-[10px] text-ds-t3 truncate" title={ctx}>{ctx}</span>}
                          </span>
                          <span className="text-[12.5px] font-semibold leading-[1.4] [text-wrap:pretty]">{t.title}</span>
                          <span className="flex items-center gap-2 pt-2.5 border-t border-ds-grid">
                            {who ? <Avatar name={who} size={22} /> : <span className="h-[22px] w-[22px] rounded-full border border-dashed border-ds-line3 shrink-0" />}
                            <span className={`text-[11px] flex-1 min-w-0 truncate ${who ? "text-ds-t2" : "text-[#FBBF24]"}`}>{who ?? "Unassigned"}</span>
                            {t._count?.comments > 0 && <span className="inline-flex items-center gap-1 text-[10px] text-ds-t3 whitespace-nowrap" title={`${t._count.comments} comment${t._count.comments !== 1 ? "s" : ""}`}><MessageSquare className="h-[11px] w-[11px]" strokeWidth={1.8} />{t._count.comments}</span>}
                            <span className="inline-flex items-center gap-1 text-[10.5px] whitespace-nowrap" style={{ color: due.color }}>
                              <CalendarDays className="h-[11px] w-[11px]" strokeWidth={1.8} />{due.text}
                            </span>
                          </span>
                        </Link>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ) : (
        /* ── List ── */
        <section className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line overflow-hidden">
          <div className="overflow-x-auto">
            <div className="min-w-[760px]" role="table" aria-label="Tasks">
              <div role="row" className={`${LIST_GRID} px-5 py-2.5 text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold border-b border-ds-line bg-[#0A1620]`}>
                <span role="columnheader">Title</span><span role="columnheader">Status</span><span role="columnheader">Priority</span>
                <span role="columnheader">Assignee</span><span role="columnheader">Due</span>
              </div>
              {isLoading ? (
                Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className={`${LIST_GRID} items-center px-5 py-[11px] border-b border-ds-grid`} aria-hidden="true">
                    <span className="h-3 w-52 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" /><span className="h-5 w-20 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <span className="h-5 w-14 rounded-full bg-ds-hover motion-safe:animate-pulse" /><span className="h-3 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" /><span />
                  </div>
                ))
              ) : visible.length === 0 ? (
                <div className="px-5 py-12 text-center text-[12.5px] text-ds-t3">No tasks found</div>
              ) : (
                visible.map((t) => {
                  const st = STATUS[t.status] ?? STATUS.TODO;
                  const p = PRIO[t.priority] ?? PRIO.LOW;
                  const due = dueOf(t, todayMs);
                  const who = t.assignee?.name as string | undefined;
                  const ctx = contextOf(t);
                  return (
                    <div key={t.id} role="row" className={`${LIST_GRID} items-center px-5 py-[11px] border-b border-ds-grid text-[12.5px] transition-colors hover:bg-[#0B1824]`}>
                      <Link href={`/tasks/${t.id}`} role="cell" className="min-w-0 text-ds-text leading-[1.35] hover:text-ds-gold">
                        <span className="block font-semibold truncate">{t.title}</span>
                        <span className="text-[10.5px] text-ds-t3">{ctx || "—"}</span>
                      </Link>
                      <span role="cell">
                        <span className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap" style={{ color: st.color, background: rgba(st.color, 0.1), borderColor: rgba(st.color, 0.28) }}>
                          <i className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />{st.label}
                        </span>
                      </span>
                      <span role="cell">
                        <span className="inline-flex items-center h-5 px-2 rounded-[10px] border text-[10px] font-bold uppercase tracking-[.04em]" style={{ color: p.color, background: rgba(p.color, 0.1), borderColor: rgba(p.color, 0.3) }}>{p.label}</span>
                      </span>
                      <span role="cell" className="flex items-center gap-2 min-w-0">
                        {who ? <Avatar name={who} size={24} /> : <span className="h-6 w-6 rounded-full border border-dashed border-ds-line3 shrink-0" />}
                        <span className={`truncate ${who ? "text-ds-t5" : "text-[#FBBF24]"}`}>{who ?? "Unassigned"}</span>
                      </span>
                      <span role="cell" className="whitespace-nowrap" style={{ color: due.color }}>{due.text}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          {hasMore && !isLoading && (
            <p className="px-5 py-3 text-[11px] text-ds-t3">Showing the first {tasks.length} tasks — search to narrow the list.</p>
          )}
        </section>
      )}
    </div>
  );
}
