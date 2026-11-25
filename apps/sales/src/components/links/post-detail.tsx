"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, ExternalLink, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { ACCESS_LABEL, REASON_TEXT, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, ago, num, usePostDetail, when, type LinkPost } from "@/lib/links";

/** A wide side panel (the shared Modal is sized for short forms). Esc and the backdrop close it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70" onClick={onClose}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl h-full bg-surface border-l-2 border-white/30 p-5 sm:p-7 overflow-y-auto outline-none">
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3 p-1.5 text-ink-3 hover:text-white"><X size={16} /></button>
        <h2 id="sheet-title" className="text-xl font-extrabold tracking-[-0.02em] pr-8 mb-4 break-words">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function StatusBadge({ p }: { p: Pick<LinkPost, "status" | "refreshing"> }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] uppercase tracking-[0.08em] whitespace-nowrap ${STATUS_TONE[p.status]}`}>
      {STATUS_LABEL[p.status]}{p.refreshing && p.status !== "pending" ? <RefreshCw size={10} className="animate-spin" aria-label="refreshing" /> : null}
    </span>
  );
}

/** "Live · 3 min ago" / "Cached · 2 h ago" — the screen never implies a value is live when it isn't. */
export function Freshness({ p }: { p: Pick<LinkPost, "freshness" | "metricsAt"> }) {
  if (!p.freshness) return <span className="text-ink-4">—</span>;
  return (
    <span className={p.freshness === "live" ? "text-success" : "text-attention"} title={p.metricsAt ? `Measured ${when(p.metricsAt)}` : undefined}>
      {p.freshness === "live" ? "Live" : "Cached"} · {ago(p.metricsAt)}
    </span>
  );
}

const METRICS: Array<[keyof LinkPost & ("views" | "reach" | "likes" | "comments" | "shares" | "saves"), string]> = [
  ["views", "Views"], ["reach", "Reach"], ["likes", "Likes"], ["comments", "Comments"], ["shares", "Shares"], ["saves", "Saves"],
];

export function PostDetail({ postId, batchId, onClose, onChanged }: { postId: string; batchId: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, mutate } = usePostDetail(postId);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const p = data?.post;

  useEffect(() => {
    if (!p?.refreshing) return;
    const t = setInterval(() => void mutate(), 4000);
    return () => clearInterval(t);
  }, [p?.refreshing, mutate]);

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ paused: boolean }>(`/sales/links/batches/${batchId}/posts/${postId}/refresh`, { method: "POST" });
      setMsg(r.data.paused ? "Queued — the batch is paused, so it runs when you resume." : "Queued — Meta is asked again within a minute.");
      await mutate();
      onChanged();
    } catch (e) {
      setMsg(errorSentence(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={p ? p.accountName ?? (p.username ? `@${p.username}` : "Post") : "Post"} onClose={onClose}>
      {error ? <p className="text-danger text-sm">{errorSentence(error)}</p> : !p ? <p className="text-ink-3 text-sm">Loading…</p> : (
        <div className="grid grid-cols-1 gap-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge p={p} />
            <span className="text-xs text-ink-3">{p.platform === "instagram" ? "Instagram" : "Facebook"} · {p.postType}</span>
            {p.access && <span className="text-xs text-ink-3">· {ACCESS_LABEL[p.access]}</span>}
            <a href={p.canonicalUrl} target="_blank" rel="noreferrer noopener" className="text-xs underline inline-flex items-center gap-1 ml-auto">Open post <ExternalLink size={12} /></a>
          </div>

          {p.status === "restricted" && p.statusReason && <p className="card p-3 text-attention">{REASON_TEXT[p.statusReason] ?? p.statusReason}</p>}
          {p.status === "failed" && p.errorMessage && <p className="card p-3 text-danger">{p.errorMessage}</p>}

          <div className="flex gap-4 min-w-0">
            {p.thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.thumbnailUrl} alt="" className="w-28 h-28 object-cover border border-border shrink-0" referrerPolicy="no-referrer" />
            )}
            <div className="min-w-0">
              {p.username && <p className="text-ink-3">@{p.username}</p>}
              <p className="text-ink-3">Followers: <b className="text-white">{num(p.followers)}</b>{p.followersAt ? <span className="text-ink-4"> · as of {ago(p.followersAt)}</span> : null}</p>
              <p className="text-ink-3">Published: {when(p.publishedAt)}</p>
              {p.caption && <p className="mt-2 whitespace-pre-wrap break-words line-clamp-6">{p.caption}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {METRICS.map(([k, label]) => (
              <div key={k} className="card p-3 min-w-0">
                <p className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{label}</p>
                <p className="text-lg font-extrabold tabular-nums">{p[k] == null ? <span className="text-ink-4" title="Meta doesn't publish this number for this post">unavailable</span> : num(p[k])}</p>
                {data.growth && data.growth[k] != null && <p className="text-xs text-success tabular-nums">{data.growth[k]! >= 0 ? "+" : ""}{num(data.growth[k])} since first check</p>}
              </div>
            ))}
          </div>

          <div className="text-xs text-ink-3 grid grid-cols-1 gap-1">
            <p>Values: <Freshness p={p} />{p.metricsAt ? ` (measured ${when(p.metricsAt)})` : ""}</p>
            <p>Data source: {p.dataSource ? SOURCE_LABEL[p.dataSource] ?? p.dataSource : "—"}</p>
            <p>Last checked: {p.lastCheckedAt ? when(p.lastCheckedAt) : "not yet"} · {p.checkCount} check{p.checkCount === 1 ? "" : "s"}</p>
            {p.refreshing && <p className="text-attention">Checking now{p.attempts ? ` (try ${p.attempts + 1}${p.nextAttemptAt ? `, next ${ago(p.nextAttemptAt).replace(" ago", "")}` : ""})` : ""}…</p>}
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy || p.refreshing}>{p.refreshing ? "Checking…" : "Refresh this post"}</button>
            {msg && <span className="text-xs text-ink-3" role="status">{msg}</span>}
          </div>

          <div>
            <h3 className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-2">Check history</h3>
            {data.snapshots.length === 0 ? <p className="text-ink-4 text-xs">No checks yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[560px]">
                  <thead className="text-ink-3 text-left"><tr className="border-b border-border"><th className="py-1 pr-2">Checked</th><th className="pr-2">Status</th><th className="pr-2">Source</th><th className="pr-2 text-right">Views</th><th className="pr-2 text-right">Reach</th><th className="pr-2 text-right">Likes</th><th className="pr-2 text-right">Comments</th><th className="text-right">Shares</th></tr></thead>
                  <tbody>
                    {[...data.snapshots].reverse().map((s, i) => (
                      <tr key={i} className="border-b border-rule">
                        <td className="py-1 pr-2 whitespace-nowrap">{when(s.checkedAt)}</td>
                        <td className="pr-2">{s.status}</td>
                        <td className="pr-2">{s.dataSource === "platform_sync" ? "cached" : s.dataSource === "none" || !s.dataSource ? "—" : "live"}</td>
                        <td className="pr-2 text-right tabular-nums">{num(s.views)}</td>
                        <td className="pr-2 text-right tabular-nums">{num(s.reach)}</td>
                        <td className="pr-2 text-right tabular-nums">{num(s.likes)}</td>
                        <td className="pr-2 text-right tabular-nums">{num(s.comments)}</td>
                        <td className="text-right tabular-nums">{num(s.shares)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {(() => {
            const others = [...new Map(data.batches.filter((b) => b.id !== batchId).map((b) => [b.id, b.name])).values()];
            return others.length ? <p className="text-xs text-ink-4">Also in: {others.join(", ")}</p> : null;
          })()}
        </div>
      )}
    </Sheet>
  );
}
