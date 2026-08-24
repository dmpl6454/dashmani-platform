"use client";

/**
 * Connected Meta channels — the primary Account Growth surface.
 *
 * ⚠️ THIS IS A CHANNEL MONITOR, NOT A POST FEED. An earlier version led with a
 * flat list of individual posts across 120 channels, which answered a question
 * nobody asked ("what was posted?") instead of the one they did ("how is each
 * channel doing?"). Posts are now a per-channel drill-down only.
 *
 * ⚠️ A metric Meta does not publish renders as an em-dash, never 0 — and the
 * footnote names which ones those are per platform, so a dash is never mistaken
 * for missing data or a real zero.
 */

import { Fragment, useState } from "react";
import {
  RefreshCw, Link2, Unlink, AlertTriangle, ExternalLink, Loader2, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  useMetaConnections, useMetaChannels, useMetaPosts,
  startMetaConnect, triggerMetaDiscovery, triggerMetaSync, disconnectMeta,
  fmtMetric, type MetaChannel,
} from "@/lib/hooks/use-meta";

type SortKey = "followers" | "views" | "engagements" | "name";

function StatusChip({ status, daysLeft }: { status: string; daysLeft: number | null }) {
  const map: Record<string, { cls: string; label: string; title: string }> = {
    ACTIVE: { cls: "text-[#3E9B4F] border-[#C6E8CB] bg-[#F2FAF3]", label: "Connected",
      title: "Reading live data through your Meta authorisation." },
    PARTIAL_SCOPE: { cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]", label: "Partial permissions",
      title: "A required permission was declined. Reconnect to grant it." },
    NEEDS_REAUTH_SOON: { cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]",
      label: daysLeft != null ? `Expires in ${daysLeft}d` : "Expiring soon",
      title: "Meta data access lapses ~90 days after authorising. Reconnect to extend." },
    NEEDS_REAUTH: { cls: "text-[#C0504D] border-[#F3C7C6] bg-[#FDF1F1]", label: "Reconnect needed",
      title: "The grant is no longer valid — reconnect to resume." },
    RATE_LIMITED: { cls: "text-[#C2861D] border-[#F3D9A4] bg-[#FDF8EC]", label: "Rate limited",
      title: "Meta is throttling us; this clears itself on the next run." },
    REVOKED: { cls: "text-[#7A7A7A] border-[#DCDCDC] bg-[#F7F7F7]", label: "Disconnected", title: "Revoked." },
  };
  const m = map[status] ?? map.REVOKED;
  return (
    <span title={m.title}
      className={`inline-flex items-center text-[11px] font-medium border rounded-full px-2 py-0.5 leading-none whitespace-nowrap ${m.cls}`}>
      {m.label}
    </span>
  );
}

/** Recent posts for ONE channel — a drill-down, never the headline. */
function ChannelPosts({ assetId }: { assetId: string }) {
  const { data, isLoading } = useMetaPosts({ assetId });
  if (isLoading) return <p className="px-6 py-3 text-[11px] text-[#B0B0B0]">Loading posts…</p>;
  const items = data?.items ?? [];
  if (items.length === 0)
    return <p className="px-6 py-3 text-[11px] text-[#B0B0B0]">No posts stored for this channel yet.</p>;
  return (
    <div className="px-6 py-2 bg-[#FCFBF8]">
      <table className="w-full">
        <thead>
          <tr className="text-[10px] text-[#B0B0B0]">
            <th className="text-left font-medium py-1">Recent post</th>
            <th className="text-right font-medium py-1 w-16">Views</th>
            <th className="text-right font-medium py-1 w-16">Likes</th>
            <th className="text-right font-medium py-1 w-20">Comments</th>
            <th className="text-right font-medium py-1 w-20">Posted</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 8).map((p) => (
            <tr key={p.id} className="border-t border-[#F0EAE0]">
              <td className="py-1 pr-2 max-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-[11px] text-[#1A1A1A] truncate">
                    {p.caption?.trim() || <span className="text-[#B0B0B0]">(no caption)</span>}
                  </span>
                  {p.permalink && (
                    <a href={p.permalink} target="_blank" rel="noopener noreferrer"
                      className="shrink-0 text-[#B0B0B0] hover:text-[#1A1A1A]">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </td>
              <td className="py-1 text-right text-[11px]">
                {p.metricsStatus === "pending" && p.views === null
                  ? <span className="italic text-[#B0B0B0]">measuring</span>
                  : fmtMetric(p.views)}
              </td>
              <td className="py-1 text-right text-[11px]">{fmtMetric(p.likes)}</td>
              <td className="py-1 text-right text-[11px]">{fmtMetric(p.comments)}</td>
              <td className="py-1 text-right text-[10px] text-[#7A7A7A] whitespace-nowrap">
                {p.postedAt ? new Date(p.postedAt).toLocaleDateString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetaPanel() {
  const { data: conns, isLoading: connLoading, mutate: mutateConns } = useMetaConnections();
  const [platform, setPlatform] = useState<"all" | "facebook" | "instagram">("all");
  const [sort, setSort] = useState<SortKey>("followers");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data: ch, mutate: mutateCh } = useMetaChannels({
    platform: platform === "all" ? undefined : platform,
    q: q.trim() || undefined,
    sort,
  });

  const connections = conns?.connections ?? [];
  const live = connections.filter((c) => c.status !== "REVOKED");
  const configured = conns?.configured ?? false;
  const channels = ch?.items ?? [];

  async function connect(mode: "connect" | "reconnect", connectionId?: string) {
    setErr(null); setBusy("connect");
    try {
      const { authorizeUrl } = await startMetaConnect({ mode, connectionId, rerequest: mode === "reconnect" });
      window.location.href = authorizeUrl; // Meta refuses to render consent in an iframe
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the Meta connection.");
      setBusy(null);
    }
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setErr(null); setBusy(label);
    try {
      await fn();
      await new Promise((r) => setTimeout(r, 3000)); // fire-and-forget job needs a beat
      await Promise.all([mutateConns(), mutateCh()]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That action failed.");
    } finally { setBusy(null); }
  }

  if (!connLoading && !configured) {
    return (
      <section className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-2">
        <h2 className="font-serif text-lg text-[#1A1A1A]">Facebook &amp; Instagram</h2>
        <p className="text-sm text-[#7A7A7A]">
          Meta connection isn&apos;t configured on the server, so no Facebook or Instagram data can be shown.
        </p>
        {(conns?.missingEnv?.length ?? 0) > 0 && (
          <p className="text-[11px] text-[#B0B0B0]">Missing: {conns!.missingEnv.join(", ")}</p>
        )}
      </section>
    );
  }

  const t = ch?.totals;
  const contrib = ch?.contributing;

  return (
    <section className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#F0EAE0] flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="font-serif text-lg text-[#1A1A1A]">Connected channels</h2>
          <p className="text-xs text-[#7A7A7A] mt-0.5">
            Facebook Pages &amp; Instagram accounts, read directly from Meta — no scraping.
          </p>
        </div>
        <div className="flex items-center gap-1.5 sm:ml-auto">
          {live.length > 0 && (
            <button onClick={() => run("sync", () => triggerMetaSync())} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-xs font-medium border border-[#DCDCDC] rounded-full px-3 py-1.5 hover:bg-[#FAFAFA] disabled:opacity-50">
              {busy === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          )}
          <button onClick={() => connect(live.length > 0 ? "reconnect" : "connect", live[0]?.id)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1.5 bg-[#1877F2] text-white hover:bg-[#166FE5] disabled:opacity-50">
            <Link2 className="h-3.5 w-3.5" />
            {live.length > 0 ? "Reconnect" : "Connect with Facebook"}
          </button>
        </div>
      </div>

      {err && (
        <div className="mx-5 mt-4 flex items-start gap-2 text-xs text-[#C0504D] bg-[#FDF1F1] border border-[#F3C7C6] rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span className="min-w-0">{err}</span>
        </div>
      )}

      {!connLoading && live.length === 0 && (
        <div className="px-5 py-8 text-center space-y-2">
          <p className="text-sm text-[#1A1A1A] font-medium">No Meta account connected yet</p>
          <p className="text-xs text-[#7A7A7A] max-w-md mx-auto leading-relaxed">
            Connect the Facebook account that manages your Pages. We&apos;ll list every Page and
            Instagram account it administers, with each channel&apos;s followers, views and
            engagement. Read-only — we never post anything.
          </p>
        </div>
      )}

      {live.map((c) => (
        <div key={c.id} className="px-5 py-2.5 border-b border-[#F6F2EA] flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-sm font-medium text-[#1A1A1A] truncate">
              {c.metaUserName ?? `Meta user ${c.metaUserId}`}
            </span>
            <StatusChip status={c.status} daysLeft={c.dataAccessDaysLeft} />
          </div>
          <div className="text-[11px] text-[#7A7A7A] flex items-center gap-2 sm:ml-auto">
            {c.discoveryState !== "done" && <span className="italic">finding channels…</span>}
            <span>{c.assetCount ?? 0} channels</span>
            <button onClick={() => run(`disc-${c.id}`, () => triggerMetaDiscovery(c.id))}
              disabled={busy !== null} className="underline hover:text-[#1A1A1A] disabled:opacity-50">
              {busy === `disc-${c.id}` ? "refreshing…" : "refresh channels"}
            </button>
            <button
              onClick={() => {
                if (window.confirm("Disconnect this Meta account? Stored data is kept, but nothing new will be fetched."))
                  void run(`del-${c.id}`, () => disconnectMeta(c.id));
              }}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 text-[#C0504D] underline hover:opacity-80 disabled:opacity-50">
              <Unlink className="h-3 w-3" />disconnect
            </button>
          </div>
          {c.missingScopes.length > 0 && (
            <p className="basis-full text-[11px] text-[#C2861D]">
              Declined permissions: {c.missingScopes.join(", ")} — reconnect to grant them.
            </p>
          )}
          {c.lastError && <p className="basis-full text-[11px] text-[#C0504D] break-words">{c.lastError}</p>}
        </div>
      ))}

      {live.length > 0 && t && (
        <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-[#F0EAE0]">
          {[
            { label: "Channels", value: ch!.channelCount, raw: true, note: null as string | null },
            { label: "Followers", value: t.followers, raw: false, note: null },
            { label: "Views · 28d", value: t.views, raw: false,
              note: contrib && contrib.views < ch!.channelCount ? `${contrib.views}/${ch!.channelCount} channels reporting` : null },
            { label: "Engagements · 28d", value: t.engagements, raw: false,
              note: contrib && contrib.engagements < ch!.channelCount ? `${contrib.engagements}/${ch!.channelCount} reporting` : null },
          ].map((s) => (
            <div key={s.label} className="min-w-0">
              <p className="font-num text-xl font-semibold text-[#1A1A1A] truncate">
                {s.raw ? s.value.toLocaleString() : fmtMetric(s.value)}
              </p>
              <p className="text-xs text-[#7A7A7A]">{s.label}</p>
              {/* Say what a total does NOT cover, rather than implying completeness. */}
              {s.note && <p className="text-[10px] text-[#B0B0B0] leading-tight">{s.note}</p>}
            </div>
          ))}
        </div>
      )}

      {live.length > 0 && (
        <div className="px-5 py-2.5 border-b border-[#F0EAE0] flex flex-wrap items-center gap-2">
          {(["all", "facebook", "instagram"] as const).map((p) => (
            <button key={p} onClick={() => setPlatform(p)}
              className={`text-[11px] rounded-full px-2.5 py-1 border ${
                platform === p ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}>
              {p === "all" ? "All" : p === "facebook" ? "Facebook" : "Instagram"}
            </button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search channels…"
            className="text-[11px] border border-[#DCDCDC] rounded-full px-3 py-1 w-40 focus:outline-none focus:border-[#B0B0B0]" />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
            className="text-[11px] border border-[#DCDCDC] rounded-full px-2 py-1 bg-white">
            <option value="followers">Sort: Followers</option>
            <option value="views">Sort: Views 28d</option>
            <option value="engagements">Sort: Engagements 28d</option>
            <option value="name">Sort: Name</option>
          </select>
          <span className="text-[11px] text-[#B0B0B0] ml-auto">{channels.length} channel(s)</span>
        </div>
      )}

      {live.length > 0 && (
        <div className="overflow-x-auto">
          {channels.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[#7A7A7A]">
              {ch ? "No channels match that filter." : "Waiting for your channels to be discovered…"}
            </p>
          ) : (
            <table className="w-full min-w-[820px]">
              <thead>
                <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
                  <th className="text-left font-medium px-5 py-2">Channel</th>
                  <th className="text-right font-medium px-2 py-2">Followers</th>
                  <th className="text-right font-medium px-2 py-2">Views 28d</th>
                  <th className="text-right font-medium px-2 py-2">Engagements 28d</th>
                  <th className="text-right font-medium px-2 py-2">Reach 28d</th>
                  <th className="text-right font-medium px-2 py-2">Profile views</th>
                  <th className="text-right font-medium px-5 py-2">Posts</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c: MetaChannel) => {
                  const open = expanded === c.id;
                  return (
                    <Fragment key={c.id}>
                      <tr onClick={() => setExpanded(open ? null : c.id)}
                        className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8] cursor-pointer">
                        <td className="px-5 py-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {open ? <ChevronDown className="h-3 w-3 text-[#B0B0B0] shrink-0" />
                                  : <ChevronRight className="h-3 w-3 text-[#B0B0B0] shrink-0" />}
                            <span className={`text-[10px] shrink-0 ${c.platform === "facebook" ? "text-[#1877F2]" : "text-[#C13584]"}`}>
                              {c.platform === "facebook" ? "f" : "ig"}
                            </span>
                            <span className="text-xs font-medium text-[#1A1A1A] truncate max-w-[220px]">{c.name}</span>
                            {c.username && <span className="text-[10px] text-[#B0B0B0] truncate">@{c.username}</span>}
                            {c.metricsError && (
                              <span title={c.metricsError}><AlertTriangle className="h-3 w-3 text-[#C2861D] shrink-0" /></span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]">{fmtMetric(c.followers)}</td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.views28d)}</td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.engagements28d)}</td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.reach28d)}</td>
                        <td className="px-2 py-2 text-right text-xs">{fmtMetric(c.profileViews28d)}</td>
                        <td className="px-5 py-2 text-right text-xs text-[#7A7A7A]">{fmtMetric(c.posts)}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7} className="p-0"><ChannelPosts assetId={c.id} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {live.length > 0 && (
        <p className="px-5 py-3 text-[11px] text-[#B0B0B0] leading-snug border-t border-[#F0EAE0]">
          Figures cover the last 28 days and come straight from Meta. A dash means Meta
          publishes no value for that metric on that platform — not a zero and not missing
          data: Facebook exposes no whole-Page reach, and profile views mean Page views on
          Facebook and profile visits on Instagram. Click a channel to see its recent posts.
        </p>
      )}
    </section>
  );
}
