"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import {
  REASON_SHORT, REASON_TEXT, ago, compactNum, day, duration, num, useBatch, useBatchItems, useReport, when,
  type Batch, type BatchItem, type LinkStatus,
} from "@/lib/links";
import { Empty, LoadError, Loading, PageHead, Stat, Toast } from "@/components/sales-ui";
import { Modal } from "@/components/ui";
import { LinkIntake, useIntakeCounts, type IntakeValue } from "@/components/links/link-intake";
import { Freshness, PostDetail, StatusBadge } from "@/components/links/post-detail";
import { ReportView } from "@/components/links/report-view";

// One batch: live progress, KPI cards, the searchable / sortable / filterable post table with a
// Status column, a detail view per post, the controls (refresh, pause/resume, retry failed,
// schedule, add links, archive) and the six reports with exports. Static export → ?id=.

type Tab = "posts" | "invalid" | "duplicate" | "report";
const SORTS: Array<[string, string]> = [["views", "Views"], ["likes", "Likes"], ["comments", "Comments"], ["shares", "Shares"], ["reach", "Reach"], ["followers", "Followers"], ["publishedAt", "Published"], ["lastCheckedAt", "Checked"]];

function Progress({ b }: { b: Batch & { worker: { throttledUntil: string | null; throttleReason: string | null; enabled: boolean } } }) {
  const p = b.progress!;
  const pctDone = p.total ? Math.round((p.processed / p.total) * 100) : 0;
  return (
    <div className="card p-4 mb-4" aria-live="polite">
      <div className="flex flex-wrap justify-between gap-2 text-sm mb-2">
        <b>{b.state === "paused" ? "Paused" : "Checking posts with Meta…"}</b>
        <span className="text-ink-3 tabular-nums">{p.processed} of {p.total} processed · {pctDone}%</span>
      </div>
      <div className="h-2 bg-muted border border-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pctDone}>
        <div className={`h-full ${b.state === "paused" ? "bg-attention" : "bg-indigo"}`} style={{ width: `${pctDone}%` }} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3 text-xs text-ink-3">
        <span>Succeeded <b className="text-success tabular-nums">{p.succeeded}</b></span>
        <span>Failed <b className="text-danger tabular-nums">{p.failed}</b></span>
        <span>Pending <b className="text-white tabular-nums">{p.pending}</b></span>
        <span>Speed <b className="text-white tabular-nums">{p.perMinute == null ? "—" : `${p.perMinute}/min`}</b></span>
        <span>Time left <b className="text-white tabular-nums">{b.state === "paused" ? "paused" : duration(p.etaSeconds)}</b></span>
      </div>
      {b.worker.throttledUntil && <p className="text-xs text-attention mt-2">Meta asked us to slow down ({b.worker.throttleReason}); checking resumes at {when(b.worker.throttledUntil).split(", ")[1]}. Nothing is lost.</p>}
      {!b.worker.enabled && <p className="text-xs text-attention mt-2">The background checker is switched off on this server.</p>}
    </div>
  );
}

function AddLinks({ b, onClose, onDone }: { b: Batch; onClose: () => void; onDone: (m: string) => void }) {
  const [v, setV] = useState<IntakeValue>({ text: "", mode: "paste", fileName: null });
  const [keep, setKeep] = useState(b.keepDuplicates);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { counts, tooMany } = useIntakeCounts(v, keep);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ counts: { valid: number; duplicate: number; invalid: number } }>(`/sales/links/batches/${b.id}/links`, { method: "POST", body: JSON.stringify({ text: v.text, mode: v.mode, keepDuplicates: keep }) });
      onDone(`Added ${r.data.counts.valid} link(s); ${r.data.counts.duplicate} duplicate and ${r.data.counts.invalid} invalid.`);
    } catch (e) {
      setErr(errorSentence(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Add links" onClose={onClose}>
      <LinkIntake value={v} onChange={setV} keepDuplicates={keep} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep duplicates</label>
      <p className="text-xs text-ink-3">Links already in this batch count as duplicates.</p>
      {err && <p className="text-sm text-danger" role="alert">{err}</p>}
      <button type="button" className="btn" disabled={busy || !counts?.valid || Boolean(tooMany)} onClick={go}>{busy ? "Adding…" : "Add links"}</button>
    </Modal>
  );
}

function UsernameFix({ batchId, item, onDone }: { batchId: string; item: BatchItem; onDone: (m: string) => void }) {
  const [u, setU] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form className="flex gap-1 mt-1" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        await apiFetch(`/sales/links/batches/${batchId}/items/${item.id}/username`, { method: "PUT", body: JSON.stringify({ username: u }) });
        onDone(`Looking up @${u.replace(/^@/, "")} with business discovery.`);
      } catch (e2) {
        onDone(errorSentence(e2));
      } finally {
        setBusy(false);
      }
    }}>
      <input className="input py-0.5 text-xs w-32" placeholder="@username" value={u} onChange={(e) => setU(e.target.value)} aria-label="Instagram username for this post" onClick={(e) => e.stopPropagation()} />
      <button type="submit" className="btn btn-ghost btn-sm" disabled={busy || !u.trim()} onClick={(e) => e.stopPropagation()}>Look up</button>
    </form>
  );
}

function BatchView() {
  const id = useSearchParams().get("id");
  const [running, setRunning] = useState(false);
  const { data: b, error, isLoading, mutate } = useBatch(id, running);
  useEffect(() => setRunning(b?.state === "running"), [b?.state]);

  const [tab, setTab] = useState<Tab>("posts");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | LinkStatus>("");
  const [platform, setPlatform] = useState("");
  const [sort, setSort] = useState("position");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setQ(typed); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [typed]);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ view: tab === "report" ? "posts" : tab, page: String(page), pageSize: "50" });
    if (q) p.set("q", q);
    if (tab === "posts" && status) p.set("status", status);
    if (platform) p.set("platform", platform);
    if (tab === "posts" && sort !== "position") { p.set("sort", sort); p.set("dir", dir); }
    return p.toString();
  }, [tab, page, q, status, platform, sort, dir]);
  const items = useBatchItems(tab === "report" ? null : id, qs, running);
  const report = useReport(id, running);

  if (!id) return <Empty title="No batch selected." action={<Link href="/links" className="btn">Back to batches</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !b) return <Loading />;

  const refreshAll = () => { void mutate(); void items.mutate(); void report.mutate(); };
  async function act(path: string, label: string, body?: unknown, method = "POST") {
    setBusy(label);
    try {
      const r = await apiFetch<{ queued?: number }>(`/sales/links/batches/${id}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      const n = r.data?.queued;
      setToast({ message: n != null ? `${label}: ${n} post(s) queued.${label === "Refresh" && n === 0 ? " Every post was checked in the last few minutes." : ""}` : `${label} done.`, tone: "ok" });
      refreshAll();
    } catch (e) {
      setToast({ message: errorSentence(e), tone: "err" });
    } finally {
      setBusy(null);
    }
  }
  async function download(format: string) {
    setBusy(`export-${format}`);
    try {
      const { blob, filename } = await apiFetchBlob(`/sales/links/batches/${id}/export?format=${format}`);
      downloadBlob(blob, filename ?? `links-report.${format}`);
    } catch (e) {
      setToast({ message: errorSentence(e), tone: "err" });
    } finally {
      setBusy(null);
    }
  }
  const sortBy = (k: string) => {
    if (sort === k) setDir(dir === "desc" ? "asc" : "desc");
    else { setSort(k); setDir("desc"); }
    setPage(1);
  };
  const k = report.data?.executive.kpis;
  const c = b.counts;
  const archived = Boolean(b.archivedAt);

  return (
    <>
      <Link href="/links" className="text-xs text-ink-3 hover:text-white">← All batches</Link>
      <PageHead kicker="Link analytics" title={b.name}>
        <div className="flex flex-wrap gap-2">
          {!archived && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>Add links</button>}
          {!archived && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => act("/refresh", "Refresh")}>Refresh all</button>}
          {b.state === "running" && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => act("/pause", "Pause")}>Pause</button>}
          {b.state === "paused" && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => act("/resume", "Resume")}>Resume</button>}
          {c.failed > 0 && !archived && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => act("/retry-failed", "Retry failed")}>Retry {c.failed} failed</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTab("report")}>Generate report</button>
        </div>
      </PageHead>
      {b.notes && <p className="text-sm text-ink-3 -mt-2 mb-4">{b.notes}</p>}
      {archived && <p className="card p-3 mb-4 text-sm text-attention">Archived {ago(b.archivedAt)} — it is deleted 30 days after archiving. <button type="button" className="underline" onClick={() => act("/restore", "Restore")}>Restore</button></p>}

      {(b.state === "running" || b.state === "paused") && b.progress && <Progress b={b} />}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-4">
        <Stat label="Verified posts" value={c.verified} sub={`${c.restricted} restricted · ${c.failed} failed · ${c.pending} pending`} tone="success" />
        <Stat label="Views" value={compactNum(k?.views.sum)} sub={k ? `${k.views.reporting} of ${k.views.of} posts` : "…"} />
        <Stat label="Likes" value={compactNum(k?.likes.sum)} sub={k ? `${k.likes.reporting} of ${k.likes.of} posts` : "…"} />
        <Stat label="Comments" value={compactNum(k?.comments.sum)} sub={k ? `${k.comments.reporting} of ${k.comments.of} posts` : "…"} />
        <Stat label="Shares" value={compactNum(k?.shares.sum)} sub={k ? `${k.shares.reporting} of ${k.shares.of} posts` : "…"} />
        <Stat label="Followers" value={compactNum(k?.followers.sum)} sub={k ? `sum of ${k.followers.accountsWithFollowers} unique accounts` : "…"} />
        <Stat label="Last checked" value={<span className="text-base">{ago(k?.lastCheckedAt ?? null)}</span>} sub={k ? `${k.live} live · ${k.cached} cached` : "…"} />
      </div>

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-center">
        <p className="text-xs text-ink-3">
          Links <b className="text-white">{c.total}</b> · valid <b className="text-white">{c.valid}</b> · invalid <b className={c.invalid ? "text-danger" : "text-white"}>{c.invalid}</b> · unique <b className="text-white">{c.unique}</b> · duplicate <b className="text-white">{c.duplicate}</b> · pending <b className="text-white">{c.pending}</b>
        </p>
        <label className="text-xs text-ink-3 flex items-center gap-2">
          Auto-refresh
          <select className="input py-1 text-xs" value={b.refreshEveryHours ?? ""} disabled={archived || Boolean(busy)} onChange={(e) => act("/schedule", "Schedule", { hours: e.target.value ? Number(e.target.value) : null }, "PUT")}>
            <option value="">Off</option><option value="6">Every 6 h</option><option value="12">Every 12 h</option><option value="24">Every 24 h</option>
          </select>
          {b.nextRefreshAt && <span>next {when(b.nextRefreshAt)}</span>}
        </label>
      </div>

      <div className="flex flex-wrap gap-1 mb-3" role="tablist" aria-label="Batch views">
        {([["posts", `Posts ${c.unique}`], ["invalid", `Invalid ${c.invalid}`], ["duplicate", `Duplicates ${c.duplicate}`], ["report", "Report"]] as Array<[Tab, string]>).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setPage(1); }} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${tab === t ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{label}</button>
        ))}
      </div>

      {tab === "report" ? (
        <>
          <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
            <span className="text-xs text-ink-3 mr-2">Download:</span>
            {[["xlsx", "Excel"], ["pdf", "PDF"], ["csv", "CSV"], ["json", "JSON"]].map(([f, label]) => (
              <button key={f} type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => download(f)}>{busy === `export-${f}` ? "Preparing…" : label}</button>
            ))}
            {c.pending > 0 && <span className="text-xs text-attention">{c.pending} post(s) are still being checked; the report says so.</span>}
          </div>
          {report.error ? <LoadError error={report.error} retry={() => report.mutate()} /> : !report.data ? <Loading label="Building the report…" /> : <ReportView report={report.data} />}
        </>
      ) : (
        <>
          <div className="card p-3 mb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] gap-2">
            <input className="input w-full" placeholder="Search link, account, @username or caption" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search posts" />
            {tab === "posts" && (
              <select className="input w-full" value={status} onChange={(e) => { setStatus(e.target.value as "" | LinkStatus); setPage(1); }} aria-label="Status">
                <option value="">All statuses</option><option value="verified">Verified</option><option value="pending">Pending</option><option value="failed">Failed</option><option value="restricted">Restricted</option>
              </select>
            )}
            <select className="input w-full" value={platform} onChange={(e) => { setPlatform(e.target.value); setPage(1); }} aria-label="Platform">
              <option value="">All platforms</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option>
            </select>
            {tab === "posts" && (
              <select className="input w-full" value={sort} onChange={(e) => { setSort(e.target.value); setDir("desc"); setPage(1); }} aria-label="Sort by">
                <option value="position">Order added</option>{SORTS.map(([kk, l]) => <option key={kk} value={kk}>Sort: {l}</option>)}
              </select>
            )}
          </div>

          {items.error ? <LoadError error={items.error} retry={() => items.mutate()} /> : !items.data ? <Loading /> : !items.data.rows.length ? (
            <Empty title={q || status || platform ? "Nothing matches these filters." : tab === "posts" ? "No posts in this batch." : tab === "invalid" ? "No invalid links." : "No duplicates."} />
          ) : tab === "posts" ? (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm min-w-[1100px]">
                <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
                  <tr className="border-b-2 border-border">
                    <th className="p-2">Post</th>
                    <th className="p-2">Status</th>
                    {SORTS.slice(0, 6).map(([kk, l]) => (
                      <th key={kk} className="p-2 text-right" aria-sort={sort === kk ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-white" onClick={() => sortBy(kk)}>{l}{sort === kk && (dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button>
                      </th>
                    ))}
                    <th className="p-2">Values</th>
                  </tr>
                </thead>
                <tbody>
                  {items.data.rows.map((r) => {
                    const p = r.post;
                    return (
                      <tr key={r.id} className="border-b border-rule hover:bg-muted/60 cursor-pointer" onClick={() => p && setOpen(p.id)}>
                        <td className="p-2 min-w-0 max-w-[280px]">
                          <button type="button" className="font-bold text-left hover:text-indigo-light truncate block max-w-full" onClick={(e) => { e.stopPropagation(); if (p) setOpen(p.id); }}>
                            {p?.accountName ?? (p?.username ? `@${p.username}` : r.normalizedUrl?.replace(/^https:\/\/(www\.)?/, "") ?? r.rawUrl)}
                          </button>
                          <div className="text-xs text-ink-4">{r.platform === "instagram" ? "Instagram" : "Facebook"} · {r.postType}{p?.publishedAt ? ` · ${day(p.publishedAt)}` : ""}</div>
                          {p?.statusReason === "ig_no_username" && !archived && <UsernameFix batchId={b.id} item={r} onDone={(m) => { setToast({ message: m, tone: "ok" }); refreshAll(); }} />}
                        </td>
                        <td className="p-2 max-w-[200px]" title={p?.statusReason ? REASON_TEXT[p.statusReason] : p?.errorMessage ?? undefined}>
                          {p ? <StatusBadge p={p} /> : "—"}
                          {p?.status === "restricted" && p.statusReason && <div className="text-[11px] text-ink-4 mt-0.5">{REASON_SHORT[p.statusReason] ?? p.statusReason}{p.access === "public" ? " · public counts only" : ""}</div>}
                          {p?.status === "restricted" && !p.statusReason && p.access === "public" && <div className="text-[11px] text-ink-4 mt-0.5">Not ours · public counts only</div>}
                          {p?.status === "failed" && p.errorMessage && <div className="text-[11px] text-danger mt-0.5 line-clamp-2">{p.errorMessage}</div>}
                        </td>
                        {(["views", "likes", "comments", "shares", "reach", "followers"] as const).map((m) => (
                          <td key={m} className="p-2 text-right tabular-nums">{p?.[m] == null ? <span className="text-ink-4" title="Unavailable — Meta doesn't publish this for this post">—</span> : num(p[m])}</td>
                        ))}
                        <td className="p-2 text-xs whitespace-nowrap">{p ? <Freshness p={p} /> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2 w-16">Line</th><th className="p-2">Link</th><th className="p-2">{tab === "invalid" ? "Why" : "Same post as"}</th></tr></thead>
                <tbody>
                  {items.data.rows.map((r) => (
                    <tr key={r.id} className="border-b border-rule">
                      <td className="p-2 tabular-nums text-ink-3">{r.position + 1}</td>
                      <td className="p-2 break-all text-xs">{r.rawUrl}</td>
                      <td className="p-2 text-xs">{tab === "invalid" ? r.invalidReason : r.post?.accountName ?? r.normalizedUrl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {items.data && items.data.total > items.data.pageSize && (
            <div className="flex items-center gap-2 mt-3 text-sm">
              <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span className="text-ink-3 tabular-nums">Page {page} of {Math.ceil(items.data.total / items.data.pageSize)} · {items.data.total} rows</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={page * items.data.pageSize >= items.data.total} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}

      <div className="mt-8 flex flex-wrap gap-2 text-xs text-ink-3">
        {!archived && (confirmArchive ? (
          <span>Archive this batch? It is deleted 30 days later. <button type="button" className="underline text-danger" onClick={() => { setConfirmArchive(false); void act("/archive", "Archive"); }}>Archive</button> · <button type="button" className="underline" onClick={() => setConfirmArchive(false)}>Keep</button></span>
        ) : <button type="button" className="underline" onClick={() => setConfirmArchive(true)}>Archive batch</button>)}
      </div>

      {open && <PostDetail postId={open} batchId={b.id} onClose={() => setOpen(null)} onChanged={refreshAll} />}
      {adding && <AddLinks b={b} onClose={() => setAdding(false)} onDone={(m) => { setAdding(false); setToast({ message: m, tone: "ok" }); refreshAll(); }} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function LinksBatchPage() {
  return (
    <Suspense fallback={<Loading />}>
      <BatchView />
    </Suspense>
  );
}
