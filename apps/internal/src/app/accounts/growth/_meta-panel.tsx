"use client";

/**
 * Meta-connected panel for /accounts/growth.
 *
 * Replaces scraper-derived Meta reporting with data read through an admin's own
 * Meta OAuth grant. Every state is named and rendered explicitly — not-configured,
 * not-connected, discovering, connected-with-posts, partial-scope, needs-reauth —
 * because a blank panel is indistinguishable from a broken one.
 *
 * ⚠️ A metric Meta does not publish renders as an em-dash via fmtMetric(), never 0.
 * ⚠️ "Measuring" (stored, not yet polled) is shown DIFFERENTLY from "—" (measured,
 *    Meta publishes nothing). Collapsing those two is what makes a page lie.
 */

import { useState } from "react";
import { RefreshCw, Link2, Unlink, AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import {
  useMetaConnections,
  useMetaAssets,
  useMetaPosts,
  useMetaPostsSummary,
  startMetaConnect,
  triggerMetaDiscovery,
  triggerMetaSync,
  disconnectMeta,
  fmtMetric,
  type MetaPost,
} from "@/lib/hooks/use-meta";

function StatusChip({ status, daysLeft }: { status: string; daysLeft: number | null }) {
  const map: Record<string, { cls: string; label: string; title: string }> = {
    ACTIVE: {
      cls: "text-[#3E9B4F] border-[#C6E8CB] bg-[#F2FAF3]",
      label: "Connected",
      title: "Reading live data through your Meta grant.",
    },
    PARTIAL_SCOPE: {
      cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]",
      label: "Partial permissions",
      title: "A required permission was declined. Reconnect to grant it.",
    },
    NEEDS_REAUTH_SOON: {
      cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]",
      label: daysLeft != null ? `Expires in ${daysLeft}d` : "Expiring soon",
      title: "Meta data access lapses ~90 days after authorising. Reconnect to extend.",
    },
    NEEDS_REAUTH: {
      cls: "text-[#C0504D] border-[#F3C7C6] bg-[#FDF1F1]",
      label: "Reconnect needed",
      title: "The grant is no longer valid — reconnect to resume.",
    },
    RATE_LIMITED: {
      cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]",
      label: "Rate limited",
      title: "Meta is throttling us. This clears itself on the next run.",
    },
    REVOKED: {
      cls: "text-[#7A7A7A] border-[#DCDCDC] bg-[#F7F7F7]",
      label: "Disconnected",
      title: "This connection was revoked.",
    },
  };
  const m = map[status] ?? map.REVOKED;
  return (
    <span
      title={m.title}
      className={`inline-flex items-center text-[11px] font-medium border rounded-full px-2 py-0.5 leading-none whitespace-nowrap ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

/** One metric cell. Distinguishes not-yet-measured from genuinely-absent. */
function MetricCell({ value, pending }: { value: number | null; pending: boolean }) {
  if (value === null && pending) {
    return (
      <span
        className="text-[11px] text-[#B0B0B0] italic"
        title="Stored, but its engagement numbers have not been fetched yet. They appear after the next sync."
      >
        measuring
      </span>
    );
  }
  return (
    <span
      className="text-xs font-semibold text-[#1A1A1A]"
      title={value === null ? "Meta publishes no value for this metric on this post type." : undefined}
    >
      {fmtMetric(value)}
    </span>
  );
}

export function MetaPanel() {
  const { data: conns, isLoading: connLoading, mutate: mutateConns } = useMetaConnections();
  const [platform, setPlatform] = useState<"all" | "facebook" | "instagram">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const kind = platform === "all" ? undefined : platform;
  const { data: assets, mutate: mutateAssets } = useMetaAssets({ kind });
  const { data: posts, mutate: mutatePosts } = useMetaPosts({ kind });
  const { data: summary, mutate: mutateSummary } = useMetaPostsSummary();

  const connections = conns?.connections ?? [];
  const live = connections.filter((c) => c.status !== "REVOKED");
  const configured = conns?.configured ?? false;

  async function connect(mode: "connect" | "reconnect", connectionId?: string) {
    setErr(null);
    setBusy("connect");
    try {
      const { authorizeUrl } = await startMetaConnect({
        mode,
        connectionId,
        rerequest: mode === "reconnect",
      });
      // Full-page navigation: Meta refuses to render its consent dialog in an iframe.
      window.location.href = authorizeUrl;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the Meta connection.");
      setBusy(null);
    }
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setErr(null);
    setBusy(label);
    try {
      await fn();
      // Give the fire-and-forget background job a moment before re-reading.
      await new Promise((r) => setTimeout(r, 2500));
      await Promise.all([mutateConns(), mutateAssets(), mutatePosts(), mutateSummary()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That action failed.");
    } finally {
      setBusy(null);
    }
  }

  // ── State: server not configured ───────────────────────────────────────────
  if (!connLoading && !configured) {
    return (
      <section className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-2">
        <h2 className="font-serif text-lg text-[#1A1A1A]">Facebook &amp; Instagram</h2>
        <p className="text-sm text-[#7A7A7A]">
          Meta connection isn&apos;t configured on the server yet, so no Facebook or Instagram
          data can be shown here.
        </p>
        {(conns?.missingEnv?.length ?? 0) > 0 && (
          <p className="text-[11px] text-[#B0B0B0]">
            Missing configuration: {conns!.missingEnv.join(", ")}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#F0EAE0] flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="font-serif text-lg text-[#1A1A1A]">Facebook &amp; Instagram</h2>
          <p className="text-xs text-[#7A7A7A] mt-0.5">
            Read directly from Meta through your own authorisation — no scraping.
          </p>
        </div>
        <div className="flex items-center gap-1.5 sm:ml-auto">
          {live.length > 0 && (
            <button
              onClick={() => run("sync", () => triggerMetaSync())}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-xs font-medium border border-[#DCDCDC] rounded-full px-3 py-1.5 hover:bg-[#FAFAFA] disabled:opacity-50"
            >
              {busy === "sync" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh posts
            </button>
          )}
          <button
            onClick={() => connect(live.length > 0 ? "reconnect" : "connect", live[0]?.id)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1.5 bg-[#1877F2] text-white hover:bg-[#166FE5] disabled:opacity-50"
          >
            <Link2 className="h-3.5 w-3.5" />
            {live.length > 0 ? "Reconnect" : "Connect with Facebook"}
          </button>
        </div>
      </div>

      {err && (
        <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-[#C0504D] bg-[#FDF1F1] border border-[#F3C7C6] rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span className="min-w-0">{err}</span>
        </div>
      )}

      {/* ── State: not connected ─────────────────────────────────────────── */}
      {!connLoading && live.length === 0 && (
        <div className="px-5 py-8 text-center space-y-2">
          <p className="text-sm text-[#1A1A1A] font-medium">No Meta account connected yet</p>
          <p className="text-xs text-[#7A7A7A] max-w-md mx-auto leading-relaxed">
            Connect the Facebook account that manages your Pages. We&apos;ll read the Pages and
            Instagram accounts it administers, then show each post&apos;s views, likes and
            comments here. Read-only — we never post anything.
          </p>
        </div>
      )}

      {/* ── Connections ──────────────────────────────────────────────────── */}
      {live.map((c) => (
        <div key={c.id} className="px-5 py-3 border-b border-[#F6F2EA] flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-sm font-medium text-[#1A1A1A] truncate">
              {c.metaUserName ?? `Meta user ${c.metaUserId}`}
            </span>
            <StatusChip status={c.status} daysLeft={c.dataAccessDaysLeft} />
          </div>
          <div className="text-[11px] text-[#7A7A7A] flex items-center gap-2 sm:ml-auto">
            {c.discoveryState !== "done" && (
              <span className="italic" title="Finding the Pages and Instagram accounts you administer.">
                finding channels…
              </span>
            )}
            <span>{c.assetCount ?? 0} channel(s)</span>
            <button
              onClick={() => run(`disc-${c.id}`, () => triggerMetaDiscovery(c.id))}
              disabled={busy !== null}
              className="underline hover:text-[#1A1A1A] disabled:opacity-50"
            >
              {busy === `disc-${c.id}` ? "refreshing…" : "refresh channels"}
            </button>
            <button
              onClick={() => {
                if (window.confirm("Disconnect this Meta account? Stored posts are kept, but no new data will be fetched.")) {
                  void run(`del-${c.id}`, () => disconnectMeta(c.id));
                }
              }}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 text-[#C0504D] underline hover:opacity-80 disabled:opacity-50"
            >
              <Unlink className="h-3 w-3" />
              disconnect
            </button>
          </div>
          {c.missingScopes.length > 0 && (
            <p className="basis-full text-[11px] text-[#C2861D]">
              Declined permissions: {c.missingScopes.join(", ")} — reconnect to grant them.
            </p>
          )}
          {c.lastError && (
            <p className="basis-full text-[11px] text-[#C0504D] break-words">{c.lastError}</p>
          )}
        </div>
      ))}

      {/* ── Totals ───────────────────────────────────────────────────────── */}
      {live.length > 0 && summary && (
        <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-[#F0EAE0]">
          {[
            { label: "Posts", value: summary.postCount, raw: true },
            { label: "Views", value: summary.totals.views },
            { label: "Likes", value: summary.totals.likes },
            { label: "Comments", value: summary.totals.comments },
          ].map((s) => (
            <div key={s.label} className="min-w-0">
              <p className="font-num text-xl font-semibold text-[#1A1A1A] truncate">
                {s.raw ? s.value.toLocaleString() : fmtMetric(s.value)}
              </p>
              <p className="text-xs text-[#7A7A7A]">{s.label}</p>
            </div>
          ))}
          {(summary.nullCounts.views > 0 || summary.pendingCount > 0) && (
            <p className="col-span-2 sm:col-span-4 text-[11px] text-[#B0B0B0] leading-snug">
              {/* Honesty about what the totals do and don't cover. */}
              {summary.nullCounts.views > 0 && (
                <>
                  {summary.nullCounts.views.toLocaleString()} post(s) have no view count published
                  by Meta, so they contribute nothing to the Views total.
                </>
              )}
              {summary.pendingCount > 0 && (
                <> {summary.pendingCount.toLocaleString()} post(s) are still being measured.</>
              )}
            </p>
          )}
        </div>
      )}

      {/* ── Channels ─────────────────────────────────────────────────────── */}
      {live.length > 0 && (assets?.items?.length ?? 0) > 0 && (
        <div className="px-5 py-3 border-b border-[#F0EAE0]">
          <div className="flex items-center gap-1.5 mb-2">
            {(["all", "facebook", "instagram"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`text-[11px] rounded-full px-2.5 py-1 border ${
                  platform === p
                    ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                    : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"
                }`}
              >
                {p === "all" ? "All" : p === "facebook" ? "Facebook" : "Instagram"}
              </button>
            ))}
            <span className="text-[11px] text-[#B0B0B0] ml-auto">
              {assets!.items.length} of {assets!.total} channel(s)
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {assets!.items.slice(0, 40).map((a) => (
              <span
                key={a.id}
                title={`${a.platform} · ${fmtMetric(a.followerCount)} followers · ${a.postCountStored} stored post(s)`}
                className="inline-flex items-center gap-1 text-[11px] border border-[#E8E0D0] rounded-full px-2 py-0.5 bg-[#FCFBF8]"
              >
                <span className={a.platform === "facebook" ? "text-[#1877F2]" : "text-[#C13584]"}>
                  {a.platform === "facebook" ? "f" : "ig"}
                </span>
                <span className="truncate max-w-[160px] text-[#1A1A1A]">
                  {a.username ?? a.name}
                </span>
                <span className="text-[#B0B0B0]">{fmtMetric(a.followerCount)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Posts table ──────────────────────────────────────────────────── */}
      {live.length > 0 && (
        <div className="overflow-x-auto">
          {(posts?.items?.length ?? 0) === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[#7A7A7A]">
              {assets?.items?.length
                ? "No posts fetched yet. Use “Refresh posts” — the first run can take a minute."
                : "Waiting for your channels to be discovered…"}
            </p>
          ) : (
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
                  <th className="text-left font-medium px-5 py-2">Post</th>
                  <th className="text-left font-medium px-2 py-2">Channel</th>
                  <th className="text-right font-medium px-2 py-2">Views</th>
                  <th className="text-right font-medium px-2 py-2">Likes</th>
                  <th className="text-right font-medium px-2 py-2">Comments</th>
                  <th className="text-right font-medium px-2 py-2">Shares</th>
                  <th className="text-right font-medium px-5 py-2">Posted</th>
                </tr>
              </thead>
              <tbody>
                {posts!.items.map((p: MetaPost) => {
                  const pending = p.metricsStatus === "pending";
                  return (
                    <tr key={p.id} className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8]">
                      <td className="px-5 py-2 max-w-[280px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`text-[10px] shrink-0 ${
                              p.platform === "facebook" ? "text-[#1877F2]" : "text-[#C13584]"
                            }`}
                          >
                            {p.platform === "facebook" ? "f" : "ig"}
                          </span>
                          <span className="text-xs text-[#1A1A1A] truncate">
                            {p.caption?.trim() || <span className="text-[#B0B0B0]">(no caption)</span>}
                          </span>
                          {p.permalink && (
                            <a
                              href={p.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 text-[#7A7A7A] hover:text-[#1A1A1A]"
                              title="Open on Meta"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-[11px] text-[#7A7A7A] truncate max-w-[120px]">
                        {p.asset.username ?? p.asset.name}
                      </td>
                      <td className="px-2 py-2 text-right"><MetricCell value={p.views} pending={pending} /></td>
                      <td className="px-2 py-2 text-right"><MetricCell value={p.likes} pending={pending} /></td>
                      <td className="px-2 py-2 text-right"><MetricCell value={p.comments} pending={pending} /></td>
                      <td className="px-2 py-2 text-right"><MetricCell value={p.shares} pending={pending} /></td>
                      <td className="px-5 py-2 text-right text-[11px] text-[#7A7A7A] whitespace-nowrap">
                        {p.postedAt ? new Date(p.postedAt).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {live.length > 0 && (
        <p className="px-5 py-3 text-[11px] text-[#B0B0B0] leading-snug border-t border-[#F0EAE0]">
          A dash means Meta publishes no value for that metric on that post type — it is not a
          zero and not missing data. Instagram does not expose a public share count for every
          format, and Facebook only reports views on video posts.
        </p>
      )}
    </section>
  );
}
