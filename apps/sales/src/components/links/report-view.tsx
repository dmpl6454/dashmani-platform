"use client";
import { useState, type ReactNode } from "react";
import { num, when, type Report, type ReportPost, type Total } from "@/lib/links";

// The six reports, rendered from GET /sales/links/batches/:id/report. The same object feeds the
// Excel / CSV / PDF / JSON exports, so what's on screen is what's in the file.

const platformName = (p: string) => (p === "instagram" ? "Instagram" : p === "facebook" ? "Facebook" : p);
const tot = (t: Total) => (t.sum == null ? "—" : num(t.sum));
const cover = (t: Total) => (t.sum == null ? "no posts report it" : `${t.reporting} of ${t.of} posts`);
const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
const acct = (p: ReportPost) => p.account ?? (p.username ? `@${p.username}` : p.url.replace(/^https:\/\/(www\.)?/, ""));

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5 min-w-0" aria-labelledby={`rep-${n}`}>
      <h3 id={`rep-${n}`} className="text-lg font-extrabold mb-3"><span className="text-ink-4 mr-2 tabular-nums">{n}</span>{title}</h3>
      {children}
    </section>
  );
}

function Table({ head, rows, min = 640 }: { head: string[]; rows: ReactNode[][]; min?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" style={{ minWidth: min }}>
        <thead className="text-ink-3 text-left"><tr className="border-b-2 border-border">{head.map((h, i) => <th key={i} className={`py-2 pr-3 ${i > 1 ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-rule">{r.map((c, j) => <td key={j} className={`py-1.5 pr-3 ${j > 1 ? "text-right tabular-nums" : ""}`}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const PostLink = ({ p }: { p: ReportPost }) => <a href={p.url} target="_blank" rel="noreferrer noopener" className="underline break-all">{acct(p)}</a>;

export function ReportView({ report }: { report: Report }) {
  const k = report.executive.kpis;
  const [postsShown, setPostsShown] = useState(100);
  const topList = (label: string, ps: ReportPost[], key: "views" | "likes" | "comments" | "shares") =>
    ps.length ? (
      <div className="min-w-0">
        <h4 className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-1">{label}</h4>
        <ol className="text-xs space-y-1">{ps.map((p, i) => <li key={p.id} className="flex gap-2 min-w-0"><span className="text-ink-4 w-5 shrink-0 tabular-nums">{i + 1}.</span><span className="min-w-0 flex-1 truncate"><PostLink p={p} /></span><b className="tabular-nums">{num(p[key])}</b></li>)}</ol>
      </div>
    ) : null;

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-xs text-ink-3">Generated {when(report.generatedAt)}. A dash means Meta doesn&apos;t publish that number — it is never a zero.</p>

      <Section n={1} title="Executive summary">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <p>Links submitted: <b>{report.counts.total}</b> ({report.counts.invalid} invalid, {report.counts.duplicate} duplicate)</p>
          <p>Unique posts: <b>{report.counts.unique}</b></p>
          <p>Verified / restricted / failed: <b>{k.posts.verified} / {k.posts.restricted} / {k.posts.failed}</b>{k.posts.pending ? ` (${k.posts.pending} pending)` : ""}</p>
          <p>Views: <b>{tot(k.views)}</b> <span className="text-ink-4">({cover(k.views)})</span></p>
          <p>Likes: <b>{tot(k.likes)}</b> <span className="text-ink-4">({cover(k.likes)})</span></p>
          <p>Comments: <b>{tot(k.comments)}</b> <span className="text-ink-4">({cover(k.comments)})</span></p>
          <p>Shares: <b>{tot(k.shares)}</b> <span className="text-ink-4">({cover(k.shares)})</span></p>
          <p>Reach: <b>{tot(k.reach)}</b> <span className="text-ink-4">({cover(k.reach)})</span></p>
          <p>Followers: <b>{num(k.followers.sum)}</b> <span className="text-ink-4">(sum of {k.followers.accountsWithFollowers} unique accounts)</span></p>
          <p>Engagement rate on followers: <b>{pct(k.engagement.weightedRateFollowers)}</b></p>
          <p>Live / cached values: <b>{k.live} / {k.cached}</b></p>
        </div>
        {report.executive.highlights.length > 0 && <ul className="mt-3 text-sm list-disc pl-5">{report.executive.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>}
        <details className="mt-3 text-xs text-ink-3"><summary className="cursor-pointer">Data limitations</summary><ul className="list-disc pl-5 mt-2 space-y-1">{report.executive.dataLimitations.map((l, i) => <li key={i}>{l}</li>)}</ul></details>
      </Section>

      <Section n={2} title="Post by post">
        <Table
          min={900}
          head={["Account", "Platform", "Views", "Reach", "Likes", "Comments", "Shares", "Saves", "Engagement", "ER (followers)", "Status"]}
          rows={report.posts.slice(0, postsShown).map((p) => [<PostLink key="a" p={p} />, platformName(p.platform), num(p.views), num(p.reach), num(p.likes), num(p.comments), num(p.shares), num(p.saves), `${num(p.engagement)}${p.engagementPartial ? "*" : ""}`, pct(p.erFollowers), `${p.status}${p.freshness === "cached" ? " (cached)" : ""}`])}
        />
        {report.posts.length > postsShown && <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => setPostsShown((n) => n + 200)}>Show more ({report.posts.length - postsShown} left)</button>}
        <p className="text-xs text-ink-4 mt-2">* partial: Meta didn&apos;t publish every part of likes + comments + shares for this post.</p>
      </Section>

      <Section n={3} title="Platform summary">
        <Table
          head={["Platform", "Posts", "Verified", "Views", "Avg views", "Likes", "Avg likes", "Comments", "Shares", "ER (followers)", "Top post"]}
          rows={report.platforms.map((g) => [platformName(g.platform), g.posts, g.verified, tot(g.totals.views), num(g.totals.views.avg), tot(g.totals.likes), num(g.totals.likes.avg), tot(g.totals.comments), tot(g.totals.shares), pct(g.engagement.weightedRateFollowers), g.topPost ? <PostLink key="t" p={g.topPost} /> : "—"])}
          min={900}
        />
      </Section>

      <Section n={4} title="Page-wise summary">
        <Table
          head={["Account", "Platform", "Followers", "Posts", "Views", "Avg views", "Likes", "Comments", "ER (followers)"]}
          rows={report.pages.map((g) => [g.account ?? (g.username ? `@${g.username}` : "Unknown account"), platformName(g.platform), num(g.followers), g.posts, tot(g.totals.views), num(g.totals.views.avg), tot(g.totals.likes), tot(g.totals.comments), pct(g.engagement.weightedRateFollowers)])}
          min={760}
        />
      </Section>

      <Section n={5} title="Top content">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {topList("Top 10 by views", report.top.byViews, "views")}
          {topList("Top 10 by likes", report.top.byLikes, "likes")}
          {topList("Top 10 by comments", report.top.byComments, "comments")}
          {topList("Top 10 by shares", report.top.byShares, "shares")}
          {Object.entries(report.top.perPlatform).map(([pl, ps]) => <div key={pl}>{topList(`Top ${platformName(pl)} posts`, ps, "views")}</div>)}
        </div>
      </Section>

      <Section n={6} title="Engagement analysis">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <p>Engagement actions: <b>{tot(report.engagement.summary.actions)}</b> <span className="text-ink-4">({cover(report.engagement.summary.actions)}{report.engagement.summary.partialPosts ? `, ${report.engagement.summary.partialPosts} partial` : ""})</span></p>
          <p>Weighted rate on followers: <b>{pct(report.engagement.summary.weightedRateFollowers)}</b> · average {pct(report.engagement.summary.avgRateFollowers)} <span className="text-ink-4">({report.engagement.summary.postsWithFollowers} posts)</span></p>
          <p>Weighted rate on reach: <b>{pct(report.engagement.summary.weightedRateReach)}</b> · average {pct(report.engagement.summary.avgRateReach)} <span className="text-ink-4">({report.engagement.summary.postsWithReach} posts)</span></p>
        </div>
        <h4 className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mt-4 mb-1">Formulas</h4>
        <ul className="text-xs list-disc pl-5 space-y-1 text-ink-3">{report.engagement.formulas.map((f, i) => <li key={i}>{f}</li>)}</ul>
        {report.engagement.topByRate.length > 0 && (
          <div className="mt-4">
            <Table head={["Account", "Platform", "Followers", "Engagement", "ER (followers)", "ER (reach)"]} rows={report.engagement.topByRate.map((p) => [<PostLink key="a" p={p} />, platformName(p.platform), num(p.followers), num(p.engagement), pct(p.erFollowers), pct(p.erReach)])} />
          </div>
        )}
      </Section>
    </div>
  );
}
