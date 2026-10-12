"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { Check, ExternalLink, RefreshCw, ShieldCheck, Unplug, X } from "lucide-react";
import { apiFetch, ApiError, fetcher } from "@/lib/api";
import { connectErrorSentence, errorSentence } from "@/lib/messages";
import { daysUntil, fmtCompact, fmtDate, fmtUntil } from "@/lib/format";
import type { ConnectionPayload, ConnectionView, CreatorAssetView } from "@/lib/types";
import { Banner, Loading, Modal, PageHead } from "@/components/ui";

// Facebook connection: what the permission lets us do, the Connect / Reconnect button, and every
// Page / Instagram account we found (GET /v1/creator/meta/connection), with whether we can
// publish to it. The flow: POST /v1/creator/meta/oauth/start → Facebook → GET …/oauth/callback →
// back here with `#state=…&code=…` (or `?error=<code>`) → THIS page, signed in, POSTs the pair to
// /oauth/complete. ⚠️ The finishing step must stay here, with the creator's own token: the API
// accepts the code only from the creator who started the flow, so a Facebook link someone else
// sent can never attach your pages to their account. The fragment is wiped from the address bar
// before anything else runs.

const SCOPE_LABELS: Record<string, string> = {
  pages_show_list: "See the list of Facebook Pages you manage",
  pages_read_engagement: "Read your Pages' follower counts and post engagement",
  pages_manage_posts: "Publish to your Pages — only campaigns you accept",
  read_insights: "Read your Pages' insights (views and reach)",
  instagram_basic: "See your Instagram professional account's profile and posts",
  instagram_content_publish: "Publish to Instagram — only campaigns you accept",
  instagram_manage_insights: "Read your Instagram account's insights",
};

const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: "Connected", tone: "text-success" },
  PARTIAL_SCOPE: { label: "Some permissions missing", tone: "text-attention" },
  NEEDS_REAUTH_SOON: { label: "Reconnect soon", tone: "text-attention" },
  NEEDS_REAUTH: { label: "Reconnect needed", tone: "text-danger" },
  REVOKED: { label: "Disconnected", tone: "text-ink-3" },
};

function ConnectInner() {
  const router = useRouter();
  const params = useSearchParams();
  const queryError = params.get("error");

  // `#state=…&code=…` from the callback → finish the connect here (once, even in dev's double
  // effect: the fragment is cleared before the request goes out).
  const [completion, setCompletion] = useState<{ state: "working" } | { state: "done" } | { state: "error"; code: string } | null>(null);
  const completing = useRef(false);
  const mutateRef = useRef<(() => Promise<unknown>) | null>(null);
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const h = new URLSearchParams(hash);
    const state = h.get("state");
    const code = h.get("code");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!state || !code || completing.current) return;
    completing.current = true;
    setCompletion({ state: "working" });
    apiFetch("/creator/meta/oauth/complete", { method: "POST", body: JSON.stringify({ state, code }) })
      .then(() => setCompletion({ state: "done" }))
      .catch((err) => setCompletion({ state: "error", code: err instanceof ApiError && err.code ? err.code.toLowerCase() : "exchange_failed" }))
      .finally(() => void mutateRef.current?.());
  }, []);
  const connected = completion?.state === "done";
  const errorCode = completion?.state === "error" ? completion.code : queryError;

  const { data, error, isLoading, mutate } = useSWR<ConnectionPayload>("/creator/meta/connection", fetcher, {
    revalidateOnFocus: true,
    // While discovery runs on the server, check back every few seconds until it settles.
    refreshInterval: (d) => (d?.connection && ["pending", "running"].includes(d.connection.discoveryState) ? 4_000 : 0),
  });

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  mutateRef.current = () => mutate();

  async function start(rerequest = false) {
    setStarting(true);
    setStartError("");
    try {
      const r = await apiFetch<{ authorizeUrl: string }>("/creator/meta/oauth/start", {
        method: "POST",
        body: JSON.stringify(rerequest ? { rerequest: true } : {}),
      });
      if (!/^https:\/\//.test(r.data.authorizeUrl)) throw new Error("Facebook's sign-in link looked wrong. Please try again.");
      window.location.assign(r.data.authorizeUrl);
    } catch (err) {
      setStartError(errorSentence(err));
      setStarting(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await apiFetch<ConnectionPayload>("/creator/meta/refresh", { method: "POST" });
      await mutate(r.data, { revalidate: false });
      setRefreshMsg({ tone: "success", text: "Your pages were checked again just now." });
    } catch (err) {
      setRefreshMsg({
        tone: "danger",
        text: err instanceof ApiError && err.status === 429
          ? "Your pages were checked a few minutes ago — try again in a few minutes."
          : errorSentence(err),
      });
    } finally {
      setRefreshing(false);
    }
  }

  const dismissQuery = () => {
    setCompletion(null);
    router.replace("/connect");
  };
  const conn = data?.connection && data.connection.status !== "REVOKED" ? data.connection : null;
  const assets = (data?.assets ?? []).filter((a) => !a.disconnected || conn);

  return (
    <div className="flex flex-col gap-8">
      <PageHead kicker="Pages" title="Connect your pages.">
        Sign in with Facebook to share the Facebook Pages and Instagram professional accounts you manage. Facebook&apos;s window
        will show the name of our Meta app, <span className="text-white font-semibold">“Post Automation 2”</span> — that&apos;s us.
      </PageHead>

      {completion?.state === "working" && (
        <Banner tone="info" role="status" title="Finishing the connection…">
          Facebook sent you back to us — we&apos;re saving the connection now.
        </Banner>
      )}
      {connected && !errorCode && (
        <Banner tone="success" role="status" title="Facebook is connected." action={<button className="btn btn-ghost btn-sm" onClick={dismissQuery}>Dismiss</button>}>
          We&apos;re checking your pages now — they appear below in a moment.
        </Banner>
      )}
      {errorCode && (
        <Banner tone="danger" role="alert" title="Not connected." action={<button className="btn btn-ghost btn-sm" onClick={dismissQuery}>Dismiss</button>}>
          {connectErrorSentence(errorCode)}
        </Banner>
      )}

      <Permissions />

      {isLoading && !data ? (
        <Loading label="Loading your connection…" />
      ) : error && !data ? (
        <Banner tone="danger" role="alert" title="We couldn't load your connection." action={<button className="btn btn-sm" onClick={() => mutate()}>Try again</button>}>
          {errorSentence(error)}
        </Banner>
      ) : !conn ? (
        <section className="card p-6 sm:p-8 flex flex-col gap-4 items-start">
          <h2 className="text-2xl font-extrabold tracking-[-0.03em]">
            {data?.connection?.status === "REVOKED" ? "Facebook is disconnected." : "Connect Facebook."}
          </h2>
          <p className="text-ink-3 text-sm leading-relaxed max-w-2xl">
            You&apos;ll need a Facebook Page you manage, or an Instagram professional (business or creator) account that is linked to a
            Facebook Page you manage. In the Facebook window, choose the Pages and Instagram accounts you want to bring.
          </p>
          <p className="text-ink-4 text-xs leading-relaxed max-w-2xl">
            Facebook keeps one list of Pages per app. If you also use Post Automation, which runs on the same Facebook app, keep the
            Pages it uses ticked too — otherwise it loses access to them.
          </p>
          <button type="button" className="btn" onClick={() => start(false)} disabled={starting || completion?.state === "working"}>
            {starting ? <><span className="spinner" aria-hidden /> Opening Facebook…</> : data?.connection ? "Reconnect Facebook" : "Connect Facebook"}
          </button>
          {startError && <p role="alert" className="text-sm text-danger">{startError}</p>}
        </section>
      ) : (
        <>
          <ConnectionCard
            conn={conn}
            starting={starting}
            refreshing={refreshing}
            onReconnect={() => start(false)}
            onGrantMissing={() => start(true)}
            onRefresh={refresh}
            onDisconnect={() => setConfirmDisconnect(true)}
          />
          {startError && <Banner tone="danger" role="alert">{startError}</Banner>}
          {refreshMsg && <Banner tone={refreshMsg.tone} role={refreshMsg.tone === "danger" ? "alert" : "status"}>{refreshMsg.text}</Banner>}
          <AssetList assets={assets} discovering={["pending", "running"].includes(conn.discoveryState)} />
        </>
      )}

      {confirmDisconnect && (
        <DisconnectModal
          onClose={() => setConfirmDisconnect(false)}
          onDone={async () => { setConfirmDisconnect(false); await mutate(); }}
        />
      )}
    </div>
  );
}

function Permissions() {
  return (
    <section className="grid gap-3 md:grid-cols-2" aria-label="What the permission allows">
      <div className="card p-5 sm:p-6">
        <h2 className="flex items-center gap-2 font-extrabold text-lg"><ShieldCheck size={18} className="text-success" aria-hidden /> What we can do</h2>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-ink-3 leading-relaxed">
          <li className="flex gap-2"><Check size={15} className="text-success mt-0.5 shrink-0" aria-hidden /> See the Pages and Instagram accounts you choose to share, with their follower counts and insights.</li>
          <li className="flex gap-2"><Check size={15} className="text-success mt-0.5 shrink-0" aria-hidden /> Publish a campaign post on your page — only a campaign you have accepted, and only the post you approved.</li>
          <li className="flex gap-2"><Check size={15} className="text-success mt-0.5 shrink-0" aria-hidden /> Read how those posts perform, so brands see real results.</li>
        </ul>
      </div>
      <div className="card p-5 sm:p-6">
        <h2 className="flex items-center gap-2 font-extrabold text-lg"><X size={18} className="text-danger" aria-hidden /> What we never do</h2>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-ink-3 leading-relaxed">
          <li className="flex gap-2"><X size={15} className="text-danger mt-0.5 shrink-0" aria-hidden /> Post anything you haven&apos;t accepted.</li>
          <li className="flex gap-2"><X size={15} className="text-danger mt-0.5 shrink-0" aria-hidden /> Comment, reply, or send messages as you.</li>
          <li className="flex gap-2"><X size={15} className="text-danger mt-0.5 shrink-0" aria-hidden /> Run ads, or touch your ad accounts or payments.</li>
          <li className="flex gap-2"><X size={15} className="text-danger mt-0.5 shrink-0" aria-hidden /> Read your personal profile, friends or private messages.</li>
        </ul>
      </div>
    </section>
  );
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function ConnectionCard({ conn, starting, refreshing, onReconnect, onGrantMissing, onRefresh, onDisconnect }: {
  conn: ConnectionView;
  starting: boolean;
  refreshing: boolean;
  onReconnect: () => void;
  onGrantMissing: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const now = useNow();
  const status = STATUS_LABELS[conn.status] ?? { label: conn.status, tone: "text-ink-3" };
  const tokenIn = fmtUntil(conn.tokenExpiresAt, now);
  const dataIn = fmtUntil(conn.dataAccessExpiresAt, now);
  const soonest = Math.min(daysUntil(conn.tokenExpiresAt, now) ?? Infinity, daysUntil(conn.dataAccessExpiresAt, now) ?? Infinity);
  const needsReconnect = conn.status === "NEEDS_REAUTH" || soonest <= 0;
  const expiringSoon = !needsReconnect && (conn.status === "NEEDS_REAUTH_SOON" || soonest < 14);
  const discovering = ["pending", "running"].includes(conn.discoveryState);

  return (
    <section className="card p-5 sm:p-7 flex flex-col gap-5" aria-labelledby="conn-title">
      <div className="flex flex-wrap items-start gap-4 justify-between">
        <div className="min-w-0">
          <p className={`text-[12px] uppercase tracking-[0.12em] font-bold ${status.tone}`}>{status.label}</p>
          <h2 id="conn-title" className="mt-1 text-2xl font-extrabold tracking-[-0.03em] break-words">
            {conn.metaUserName ? `Facebook: ${conn.metaUserName}` : "Facebook account"}
          </h2>
          <p className="mt-1 text-sm text-ink-3">Connected {fmtDate(conn.connectedAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={refreshing || discovering}>
            {refreshing ? <span className="spinner" aria-hidden /> : <RefreshCw size={14} aria-hidden />} Check pages again
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onReconnect} disabled={starting}>
            {starting ? <span className="spinner" aria-hidden /> : null} Reconnect
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={onDisconnect}>
            <Unplug size={14} aria-hidden /> Disconnect
          </button>
        </div>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 text-sm">
        <div className="card-inset p-3">
          <dt className="text-[11px] uppercase tracking-[0.1em] text-ink-4">Facebook access</dt>
          <dd className="mt-1 text-ink-2">
            {tokenIn == null ? "Doesn't expire on a fixed date" : tokenIn === "expired" ? "Expired — reconnect to renew" : <>Expires {tokenIn} <span className="text-ink-4">({fmtDate(conn.tokenExpiresAt)})</span></>}
          </dd>
        </div>
        <div className="card-inset p-3">
          <dt className="text-[11px] uppercase tracking-[0.1em] text-ink-4">Data access</dt>
          <dd className="mt-1 text-ink-2">
            {dataIn == null ? "—" : dataIn === "expired" ? "Expired — reconnect to renew" : <>Renew {dataIn} <span className="text-ink-4">({fmtDate(conn.dataAccessExpiresAt)})</span></>}
          </dd>
        </div>
      </dl>

      {needsReconnect && (
        <Banner tone="danger" title="Reconnect Facebook." action={<button className="btn btn-sm" onClick={onReconnect} disabled={starting}>Reconnect</button>}>
          Facebook no longer lets us use this connection, so we can&apos;t check or publish to your pages until you reconnect.
        </Banner>
      )}
      {expiringSoon && (
        <Banner tone="warn" title="Reconnect soon.">
          Facebook asks people to renew access every few months. Reconnect before it runs out so campaigns you accept keep publishing.
        </Banner>
      )}
      {conn.missingScopes.length > 0 && (
        <Banner
          tone="warn"
          title="Some permissions weren't granted."
          action={<button className="btn btn-sm" onClick={onGrantMissing} disabled={starting}>Grant the missing permissions</button>}
        >
          <p>Without these we can&apos;t publish the campaigns you accept:</p>
          <ul className="mt-2 flex flex-col gap-1">
            {conn.missingScopes.map((s) => <li key={s}>• {SCOPE_LABELS[s] ?? s}</li>)}
          </ul>
        </Banner>
      )}
      {conn.discoveryState === "failed" && (
        <Banner tone="danger" title="We couldn't check your pages.">
          {conn.lastError ? <p className="break-words">{conn.lastError}</p> : null}
          <p className={conn.lastError ? "mt-1" : ""}>Use “Check pages again” in a few minutes, or reconnect.</p>
        </Banner>
      )}
      {conn.discoveryState === "done" && conn.lastError && (
        <Banner tone="warn" title="Some pages aren't shown.">
          <p className="break-words">{conn.lastError}.</p>
          <p className="mt-1">If one of them is yours, email creators@digitalsukoon.com and we&apos;ll look into it.</p>
        </Banner>
      )}
    </section>
  );
}

function AssetList({ assets, discovering }: { assets: CreatorAssetView[]; discovering: boolean }) {
  return (
    <section aria-labelledby="assets-title" className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 id="assets-title" className="kicker">Your pages</h2>
        {discovering && <span className="flex items-center gap-2 text-sm text-ink-3" role="status"><span className="spinner" aria-hidden /> Checking your pages…</span>}
      </div>
      {assets.length === 0 ? (
        !discovering && (
          <div className="card p-6 text-sm text-ink-3 leading-relaxed">
            <p className="text-white font-bold">No pages found.</p>
            <p className="mt-1">
              Facebook didn&apos;t share any Pages or Instagram accounts with us. Reconnect and tick the Pages you manage in the Facebook window —
              an Instagram account appears only if it is a professional account linked to one of those Pages.
            </p>
          </div>
        )
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {assets.map((a) => <AssetCard key={a.id} a={a} />)}
        </ul>
      )}
    </section>
  );
}

function AssetCard({ a }: { a: CreatorAssetView }) {
  const [imgOk, setImgOk] = useState(true);
  const ig = a.kind === "instagram_account";
  const initials = a.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

  let state: { text: string; tone: string };
  if (a.disconnected) state = { text: "No longer shared with us", tone: "text-ink-3" };
  else if (a.networkDuplicate) state = { text: "Already on the Digital Sukoon network", tone: "text-indigo-light" };
  else if (a.canPublish) state = { text: "Ready to publish", tone: "text-success" };
  else state = { text: "Can't publish yet", tone: "text-attention" };

  return (
    <li className="card p-4 sm:p-5 flex gap-4 min-w-0">
      <div className="shrink-0 w-14 h-14 bg-muted border-2 border-border grid place-items-center overflow-hidden font-extrabold text-ink-3">
        {a.pictureUrl && imgOk ? (
          <img src={a.pictureUrl} alt="" className="w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
        ) : initials}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-[0.1em] text-ink-4">{ig ? "Instagram account" : "Facebook Page"}</p>
        <h3 className="font-extrabold text-[17px] leading-tight break-words">{a.name}</h3>
        {a.username && <p className="text-sm text-ink-3 break-all">@{a.username}</p>}
        <p className="mt-2 text-sm text-ink-2 flex flex-wrap gap-x-4 gap-y-1">
          <span><span className="font-bold text-white">{fmtCompact(a.followerCount)}</span> followers</span>
          {ig && a.mediaCount != null && <span><span className="font-bold text-white">{fmtCompact(a.mediaCount)}</span> posts</span>}
          {a.views28d != null && <span><span className="font-bold text-white">{fmtCompact(a.views28d)}</span> views · 28 days</span>}
        </p>
        <p className={`mt-2 text-sm font-bold ${state.tone}`}>{state.text}</p>
        {!a.disconnected && a.networkDuplicate && (
          <p className="mt-1 text-xs text-ink-3 leading-relaxed">This page is already part of our own network, so it can&apos;t also be booked as a creator page.</p>
        )}
        {!a.disconnected && !a.networkDuplicate && !a.canPublish && (
          <p className="mt-1 text-xs text-ink-3 leading-relaxed break-words">
            {a.publishProbeError || "Facebook didn't confirm that we can publish here. Check that you have full control of the Page and granted the publishing permission, then reconnect."}
          </p>
        )}
        {a.enabled && !a.disconnected && <p className="mt-1 text-xs text-success">Approved by our team — we&apos;ll email you when brands can book it.</p>}
        {a.profileUrl && (
          <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-indigo-light hover:text-white">
            View on {ig ? "Instagram" : "Facebook"} <ExternalLink size={13} aria-hidden />
          </a>
        )}
      </div>
    </li>
  );
}

function DisconnectModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await apiFetch("/creator/meta/connection", { method: "DELETE" });
      onDone();
    } catch (err) {
      setError(errorSentence(err));
      setBusy(false);
    }
  }
  return (
    <Modal title="Disconnect Facebook?" onClose={onClose}>
      <p className="text-sm text-ink-3 leading-relaxed">
        We&apos;ll delete our copy of your Facebook access and stop checking or publishing to your pages. Your profile can&apos;t be reviewed
        or booked until you connect again.
      </p>
      <p className="text-sm text-ink-3 leading-relaxed">
        This removes our access on our side. To also remove the app from your Facebook account, go to Facebook → Settings → Business
        integrations and remove “Post Automation 2”.
      </p>
      {error && <Banner tone="danger" role="alert">{error}</Banner>}
      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Keep connected</button>
        <button type="button" className="btn btn-danger btn-sm" onClick={disconnect} disabled={busy}>
          {busy ? <><span className="spinner" aria-hidden /> Disconnecting…</> : "Disconnect"}
        </button>
      </div>
    </Modal>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<><PageHead kicker="Pages" title="Connect your pages." /><Loading label="Loading your connection…" /></>}>
      <ConnectInner />
    </Suspense>
  );
}
