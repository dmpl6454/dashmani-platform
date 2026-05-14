"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, StatusBadge, Avatar, FormatPill, AspectThumb, Empty } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { Actions, fmt, sel, usePortalStore, type Post, type Project } from "@/lib/portal-store";

export default function DashboardPage() {
  const router = useRouter();
  const pending = usePortalStore(sel.pending);
  const posts = usePortalStore(sel.posts);
  const projects = usePortalStore(sel.projects);
  const activity = usePortalStore(sel.activity);

  const overdue = pending.filter((p) => p.overdue).length;
  const dueToday = pending.filter((p) => {
    if (!p.scheduled) return false;
    return new Date(p.scheduled).toDateString() === new Date().toDateString();
  }).length;

  const scheduled = posts.filter((p) => p.status === "SCHEDULED").length;
  const live7d = posts.filter((p) => p.status === "PUBLISHED").length;
  const avgApproval = "6h";

  return (
    <>
      <Topstrip
        title="Home"
        sub={new Date().toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })}
      />
      <div className="px-6 py-6 max-w-[1200px] mx-auto w-full">
        {/* ── Approvals queue — hero. Shown unconditionally; "All caught up" is the empty state. ── */}
        <section aria-labelledby="approvals-heading" className="mb-6">
          <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
            <div>
              <h2 id="approvals-heading" className="text-[22px] font-semibold leading-tight">
                {pending.length > 0 ? "Awaiting your review" : "You're all caught up"}
              </h2>
              <p className="text-[13px] text-ink-3 mt-0.5">
                {pending.length > 0 ? (
                  <>
                    {pending.length} item{pending.length !== 1 ? "s" : ""}
                    {dueToday > 0 ? ` · ${dueToday} due today` : ""}
                    {overdue > 0 ? <> · <span className="text-attention font-medium">{overdue} overdue</span></> : ""}
                  </>
                ) : (
                  <>Last reviewed {activity[0]?.at || "just now"}.</>
                )}
              </p>
            </div>
            {pending.length > 0 && (
              <Button variant="default" size="sm" iconRight={<Icon.ArrowRight size={14}/>} onClick={() => router.push("/approvals")}>
                Open inbox
              </Button>
            )}
          </div>

          {pending.length === 0 ? (
            <div className="bg-surface border border-border rounded-lg p-8">
              <Empty
                icon={<Icon.Check size={20}/>}
                title="No approvals pending"
                hint="Your agency will send drafts here when they're ready for review."
                cta={<Button variant="ghost" size="sm" onClick={() => router.push("/content")} iconRight={<Icon.ArrowRight size={14}/>}>Browse scheduled content</Button>}
              />
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {pending.slice(0, 5).map((p, i) => (
                <DashApprovalRow
                  key={p.id}
                  post={p}
                  project={projects.find((pr) => pr.id === p.project) || null}
                  divider={i < Math.min(4, pending.length - 1)}
                />
              ))}
              {pending.length > 5 && (
                <button
                  onClick={() => router.push("/approvals")}
                  className="w-full h-10 text-[13px] font-medium text-ink-2 hover:bg-muted/60 transition-colors border-t border-rule flex items-center justify-center gap-1.5"
                >
                  See {pending.length - 5} more <Icon.ArrowRight size={14}/>
                </button>
              )}
            </div>
          )}
        </section>

        {/* ── Vanity stats demoted to a single inline strip. Operational, not decorative. ── */}
        <section aria-label="Quick stats" className="mb-6">
          <div className="bg-surface border border-border rounded-lg divide-x divide-rule flex">
            <DashStat label="Active projects" value={projects.filter((p) => p.status === "ACTIVE").length} />
            <DashStat label="Scheduled posts" value={scheduled} sub="next 7 days" />
            <DashStat label="Avg. approval" value={avgApproval} sub="last 30d" />
            <DashStat label="Posts went live" value={live7d} sub="last 7 days" />
          </div>
        </section>

        {/* ── Projects + Activity ── */}
        <section className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Your projects</h3>
              <button onClick={() => router.push("/projects")} className="text-[12px] text-ink-3 hover:text-ink inline-flex items-center gap-1">
                View all <Icon.ArrowRight size={12}/>
              </button>
            </div>
            <ul>
              {projects.filter((p) => p.status === "ACTIVE" || p.attention).slice(0, 4).map((p, i, arr) => (
                <li key={p.id}>
                  <button
                    onClick={() => router.push("/projects")}
                    className={`w-full px-4 h-11 flex items-center gap-3 hover:bg-muted/40 transition-colors text-left ${i < arr.length - 1 ? "border-b border-rule" : ""}`}
                  >
                    <StatusBadge status={p.status} className="!h-5 !text-[10.5px]" />
                    <span className="flex-1 text-[13.5px] truncate text-rowtight">{p.name}</span>
                    {p.pending > 0 && <span className="text-[11px] text-attention font-medium">{p.pending} for you</span>}
                    <span className="text-[11px] text-ink-3 tabular-nums w-12 text-right">{p.tasks.done}/{p.tasks.total}</span>
                    <Icon.ChevRight size={14} className="text-ink-4" />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Since you were here</h3>
              <span className="text-[11px] text-ink-3">last 12h</span>
            </div>
            <ul className="px-4 py-3 space-y-2.5">
              {activity.slice(0, 6).map((a, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  {a.a ? <Avatar initial={a.a} size="xs" /> : <span className="h-5 w-5 rounded-full grid place-items-center text-ink-4"><Icon.Dot size={10}/></span>}
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] leading-snug text-rowtight">
                      <span className="font-medium text-ink">{a.who}</span> <span className="text-ink-2">{a.text}</span>
                    </p>
                    <p className="text-[11px] text-ink-3 mt-0.5">{a.at}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </>
  );
}

function DashStat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="flex-1 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-3 font-medium">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold leading-none text-ink tabular-nums">{value}</span>
        {sub && <span className="text-[11px] text-ink-3">{sub}</span>}
      </div>
    </div>
  );
}

function DashApprovalRow({ post, project, divider }: { post: Post; project: Project | null; divider: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const due = post.scheduled ? fmt.date(post.scheduled) : null;
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    setTimeout(() => { fn(); setBusy(false); }, 80);
  };
  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 cursor-pointer transition-colors ${divider ? "border-b border-rule" : ""}`}
      onClick={() => router.push(`/content/${post.id}`)}
    >
      <AspectThumb aspect={post.aspect || "1:1"} format={post.format} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-ink truncate">{post.title}</span>
          <FormatPill format={post.format} aspect={post.aspect} />
        </div>
        <div className="text-[12px] text-ink-3 mt-0.5 truncate">
          {project?.short} · by {post.authorName} ·{" "}
          <span className={post.overdue ? "text-attention font-medium" : ""}>{due}{post.overdue ? " · overdue" : ""}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 opacity-90 group-hover:opacity-100">
        <Button variant="default" size="sm" onClick={act(() => Actions.revise(post.id, "Please revise per upcoming notes."))} disabled={busy}>Revise</Button>
        <Button variant="primary" size="sm" onClick={act(() => Actions.approve(post.id))} icon={<Icon.Check size={15} sw={2.4}/>} disabled={busy}>Approve</Button>
      </div>
    </div>
  );
}
