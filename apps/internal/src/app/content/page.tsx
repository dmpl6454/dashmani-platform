"use client";
// Content — premium dark redesign ("ds"), built to the Content.dc.html mockup.
// UI only: same /content endpoint. The status strip needs every status's count at
// once, so the list is fetched without a status filter and filtered in the page;
// a ?status= link (e.g. from the dashboard) still pre-selects a status.
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CalendarDays, Plus, Search, X } from "lucide-react";
import { useContentPosts } from "@/lib/hooks/use-content";
import { useProjects } from "@/lib/hooks/use-projects";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUSES = [
  ["DRAFT", "Draft", "#A7B3C2"],
  ["PENDING_APPROVAL", "Needs Review", "#FBBF24"],
  ["APPROVED", "Approved", "#34D399"],
  ["SCHEDULED", "Scheduled", "#238BFF"],
  ["PUBLISHED", "Published", "#00D7A0"],
  ["FAILED", "Failed", "#FB7185"],
  ["REJECTED", "Rejected", "#E5484D"],
] as const;
const STATUS = Object.fromEntries(STATUSES.map(([k, label, color]) => [k, { label, color }])) as Record<string, { label: string; color: string }>;
const PLATFORM_COLOR: Record<string, string> = { instagram: "#EC42B7", facebook: "#238BFF", youtube: "#FF5A5F", snapchat: "#E9D23A" };
const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const GRID = "grid [grid-template-columns:minmax(260px,2.2fr)_minmax(130px,1fr)_minmax(170px,1.2fr)_120px_130px_minmax(120px,1fr)] gap-3";
const DAY = 86_400_000;

function whenOf(post: any): { text: string; color: string } {
  const iso = post.status === "PUBLISHED" ? (post.publishedAt ?? post.scheduledAt) : post.scheduledAt;
  if (!iso) return { text: "Not scheduled", color: "#738395" };
  const d = new Date(iso);
  const today = new Date();
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY);
  const day = dayDiff === 0 ? "Today" : dayDiff === 1 ? "Tomorrow" : dayDiff === -1 ? "Yesterday" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return { text: `${day} · ${time}`, color: post.status === "SCHEDULED" ? "#6EB2FF" : post.status === "FAILED" ? "#FB7185" : "#A7B3C2" };
}

export default function ContentListPage() {
  usePageTitle("Content");
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(searchParams.get("status") || "");
  const [projectId, setProjectId] = useState("");
  // The list is filtered by the SERVER, exactly as before the redesign (the endpoint pages at
  // 100 rows, so filtering locally would silently drop older posts of the chosen status).
  // A second, unfiltered request feeds the status counts; with no status chosen both share
  // one SWR key, so there is no extra request in that case.
  const { data, isLoading, error } = useContentPosts({ search, status, projectId });
  const { data: allData, isLoading: countsLoading } = useContentPosts({ search, projectId });
  const { data: projectsData } = useProjects();
  const listed: any[] = (data as any)?.data || [];
  const hasMore: boolean = !!(data as any)?.meta?.has_more;
  const all: any[] = (allData as any)?.data || [];
  const countsCapped: boolean = !!(allData as any)?.meta?.has_more;
  const projects: any[] = (projectsData as any)?.data || [];

  const posts = listed;
  const countOf = (k: string) => all.filter((p) => p.status === k).length;
  const more = countsCapped ? "+" : "";
  const cur = status ? STATUS[status] : null;

  return (
    <div className="pb-6">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="basis-full sm:basis-auto sm:flex-1 min-w-0">
          <p className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Content Studio</p>
          <h1 className="mt-2 mb-0 text-[28px] font-semibold tracking-[-.02em] text-ds-text">Content</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {countsLoading ? "Loading…" : `${all.length}${more} post${all.length !== 1 ? "s" : ""} · ${countOf("SCHEDULED")}${more} scheduled · ${countOf("PENDING_APPROVAL")}${more} awaiting review`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/content/calendar" className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text">
            <CalendarDays className="h-[13px] w-[13px]" strokeWidth={1.8} /> Calendar
          </Link>
          <Link href="/content/new" className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22] hover:text-ds-gold2">
            <Plus className="h-3.5 w-3.5" /> New Content
          </Link>
        </div>
      </section>

      {/* Status pipeline — click to filter, click again to clear */}
      <section className="flex overflow-x-auto bg-ds-card border border-ds-line rounded-[8px]" role="group" aria-label="Filter by status">
        {STATUSES.map(([k, label, color]) => {
          const sel = status === k;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={sel}
              onClick={() => setStatus(sel ? "" : k)}
              className="relative flex-[1_0_128px] min-w-0 flex flex-col gap-2 p-4 border-r border-ds-grid last:border-r-0 text-left text-ds-text transition-colors hover:bg-[#0B1824]"
              style={{ background: sel ? "#0B1824" : "transparent" }}
            >
              <span className="absolute inset-x-0 bottom-0 h-0.5" style={{ background: sel ? color : "transparent" }} />
              <span className="flex items-center gap-[7px] text-[10px] tracking-[.1em] uppercase font-semibold whitespace-nowrap min-w-0" style={{ color: sel ? "#F4F6F8" : "#A7B3C2" }}>
                <i className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: color }} />
                <span className="truncate">{label}</span>
              </span>
              <span className="text-[28px] font-semibold tracking-[-.03em] leading-none">{countsLoading ? "—" : `${countOf(k)}${more}`}</span>
            </button>
          );
        })}
      </section>

      {/* Filters */}
      <section className="flex items-center gap-2.5 flex-wrap mt-3.5">
        <label className="flex items-center gap-2 h-[34px] px-3 rounded-[17px] bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_300px] min-w-[200px] w-full sm:w-auto">
          <Search className="h-[13px] w-[13px] shrink-0" strokeWidth={1.8} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search content…"
            aria-label="Search content"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[12px] placeholder:text-ds-t3"
          />
        </label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project"
          className="h-[34px] px-3 rounded-[17px] border border-ds-line2 bg-ds-inset text-ds-t5 text-[12px]"
        >
          <option value="">All Projects</option>
          {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {cur && (
          <button
            type="button"
            onClick={() => setStatus("")}
            className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-[13px] border border-ds-gold/55 bg-ds-gold/[.14] text-ds-text text-[11px] font-semibold whitespace-nowrap"
          >
            {cur.label} <X className="h-3 w-3 text-ds-gold" aria-label="Clear status filter" />
          </button>
        )}
      </section>

      {/* Table */}
      {error && listed.length === 0 ? (
        <section role="alert" className="mt-3.5 px-5 py-14 text-center rounded-[8px] bg-ds-card border border-ds-line text-[12.5px] text-ds-t2">
          Couldn&apos;t load content. Refresh the page to try again.
        </section>
      ) : !isLoading && posts.length === 0 ? (
        <section className="mt-3.5 px-5 py-14 text-center rounded-[8px] bg-ds-card border border-dashed border-ds-line2 text-[12.5px] text-ds-t3">
          No content posts found
        </section>
      ) : (
        <section className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line overflow-hidden">
          <div className="overflow-x-auto">
            <div className="min-w-[860px]" role="table" aria-label="Content posts">
              <div role="row" className={`${GRID} px-5 py-2.5 text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold border-b border-ds-line bg-[#0A1620]`}>
                <span role="columnheader">Title</span><span role="columnheader">Project</span><span role="columnheader">Account</span>
                <span role="columnheader">Status</span><span role="columnheader">Scheduled</span><span role="columnheader">By</span>
              </div>
              {isLoading
                ? Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className={`${GRID} items-center px-5 py-2.5 border-b border-ds-grid`} aria-hidden="true">
                      <span className="h-3 w-52 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" /><span className="h-3 w-24 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                      <span className="h-3 w-32 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" /><span className="h-5 w-20 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                      <span className="h-3 w-24 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" /><span className="h-3 w-20 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                    </div>
                  ))
                : posts.map((post) => {
                    const st = STATUS[post.status] ?? { label: post.status, color: "#A7B3C2" };
                    const when = whenOf(post);
                    const plat = (post.account?.platform?.slug || post.account?.platform?.name || "").toLowerCase();
                    const media = post.mediaUrls?.length ?? 0;
                    const handle = post.account ? (post.account.displayName || post.account.handle) : null;
                    return (
                      <div key={post.id} role="row" className={`${GRID} items-center px-5 py-2.5 border-b border-ds-grid text-[12.5px] transition-colors hover:bg-[#0B1824]`}>
                        <Link href={`/content/${post.id}`} role="cell" className="flex items-center gap-3 min-w-0 text-ds-text hover:text-ds-gold">
                          <span className="font-semibold truncate">{post.title}</span>
                          {media > 0 && <span className="h-[18px] px-1.5 rounded-[4px] bg-ds-hover text-ds-t2 text-[10px] inline-flex items-center shrink-0 whitespace-nowrap">{media} media</span>}
                        </Link>
                        <span role="cell" className="text-ds-t2 truncate" title={post.project?.name || undefined}>{post.project?.name || "—"}</span>
                        <span role="cell" className="flex items-center gap-2 min-w-0 text-ds-t5" title={post.account ? `${post.account.platform?.name}: ${post.account.handle}` : undefined}>
                          {handle ? (
                            <>
                              <i className="h-[7px] w-[7px] rounded-full shrink-0" style={{ background: PLATFORM_COLOR[plat] ?? "#738395" }} />
                              <span className="truncate">{handle}</span>
                            </>
                          ) : <span className="text-ds-t3">—</span>}
                        </span>
                        <span role="cell">
                          <span className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap" style={{ color: st.color, background: rgba(st.color, 0.1), borderColor: rgba(st.color, 0.35) }}>
                            <i className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />{st.label}
                          </span>
                        </span>
                        <span role="cell" className="whitespace-nowrap" style={{ color: when.color }}>{when.text}</span>
                        <span role="cell" className="text-ds-t2 truncate">{post.createdBy?.name || "—"}</span>
                      </div>
                    );
                  })}
            </div>
          </div>
          {hasMore && !isLoading && <p className="px-5 py-3 text-[11px] text-ds-t3">Showing the first {listed.length} posts — search or pick a project to narrow the list.</p>}
        </section>
      )}
    </div>
  );
}
