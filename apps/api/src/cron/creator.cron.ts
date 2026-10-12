/**
 * Creator portal — daily background work:
 *  1. token health on BOTH of Meta's clocks (token_expires_at ~60d, data_access_expires_at ~90d):
 *     ≤14 whole days left (rounded UP) → NEEDS_REAUTH_SOON, passed → NEEDS_REAUTH, and the creator
 *     is emailed at most twice per connection — once at ≤14 days, once at ≤3. The stage already
 *     mailed is STORED (creator_connections.expiry_warned_days, reset on reconnect), because the
 *     schedule is in-process: every API restart (every deploy) runs another pass 25 min later;
 *  2. our-network duplicate flags re-checked (syncNetworkDuplicates, DB only);
 *  3. page stats (services/creator/creator-metrics.service.ts, its own call budget);
 *  4. purge: page details of pages disconnected, and connections revoked, more than
 *     PURGE_AFTER_DAYS ago (the privacy page promises 30 days; tokens are already gone);
 *  5. pruning OAuth states that expired over a day ago.
 * DB-only except the metrics step. Dark unless CREATORS_ENABLED=1; kill switch
 * CREATOR_CRONS_ENABLED=0. First run 25 min after boot (clear of every other startup burst).
 */

import { prisma } from "@dashmani/db";
import { creatorConfig } from "../services/creator/creator-config";
import { creatorMetaConfigured } from "../services/creator/creator-meta-config";
import { button, creatorLink, esc, sendCreatorEmail } from "../services/creator/creator-email";
import { refreshCreatorMetrics } from "../services/creator/creator-metrics.service";
import { syncNetworkDuplicates } from "../services/creator/creator-discovery.service";
import { pruneCreatorOauthStates } from "../services/creator/creator-oauth.service";
import { scrubSecrets } from "../utils/token-crypto";

const DAY_MS = 86_400_000;
const WARN_DAYS = 14;
/** Reminder stages, largest first: an email goes out on reaching each one (once). */
const EMAIL_STAGES = [14, 3];
/** Promised on the privacy page: page details are deleted within 30 days of a disconnect. */
export const PURGE_AFTER_DAYS = 30;

/** Whole days left, rounded UP (1 minute left = 1 day; already passed ≤ 0). */
export function daysLeft(expiresAt: Date, now: Date): number {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS) || 0; // no -0
}

export async function runCreatorTokenHealth(now = new Date()) {
  const out = { checked: 0, soon: 0, expired: 0, emailed: 0 };
  const conns = await prisma.creatorConnection.findMany({
    where: { revokedAt: null, userTokenEnc: { not: null }, status: { not: "REVOKED" }, creator: { status: { not: "closed" } } },
    select: {
      id: true,
      status: true,
      tokenExpiresAt: true,
      dataAccessExpiresAt: true,
      expiryWarnedDays: true,
      creator: { select: { email: true, name: true } },
    },
  });

  for (const c of conns) {
    out.checked++;
    // Whichever clock runs out first decides: an expired token and lapsed data access both
    // stop every read.
    const clocks = [c.tokenExpiresAt, c.dataAccessExpiresAt].filter((d): d is Date => d != null);
    if (clocks.length === 0) continue;
    const earliest = new Date(Math.min(...clocks.map((d) => d.getTime())));
    const left = daysLeft(earliest, now);

    let next: string | null = null;
    if (left <= 0) next = "NEEDS_REAUTH";
    else if (left <= WARN_DAYS && c.status !== "NEEDS_REAUTH") next = "NEEDS_REAUTH_SOON";
    if (next && next !== c.status) {
      await prisma.creatorConnection.update({
        where: { id: c.id },
        data: {
          status: next,
          lastError:
            next === "NEEDS_REAUTH"
              ? "Your Facebook connection has expired — reconnect to keep your pages active."
              : `Your Facebook connection expires in ${left} day${left === 1 ? "" : "s"} — reconnect to keep your pages active.`,
        },
      });
    }
    if (left <= 0) out.expired++;
    else if (left <= WARN_DAYS) out.soon++;

    // The smallest stage reached (≤3 beats ≤14). A day missed (a restart, an outage) still
    // sends — at most one email per stage, and none for a stage already passed.
    const stage = left > 0 ? [...EMAIL_STAGES].reverse().find((d) => left <= d) ?? null : null;
    if (stage != null && (c.expiryWarnedDays == null || c.expiryWarnedDays > stage)) {
      // Claim the stage BEFORE sending, conditionally, so two overlapping passes mail once.
      const claimed = await prisma.creatorConnection.updateMany({
        where: { id: c.id, OR: [{ expiryWarnedDays: null }, { expiryWarnedDays: { gt: stage } }] },
        data: { expiryWarnedDays: stage },
      });
      if (claimed.count === 1) {
        const body =
          `<p>Hi ${esc(c.creator.name)},</p>` +
          `<p>Facebook's permission for us to reach your pages ends in <b>${left} day${left === 1 ? "" : "s"}</b>. Reconnect now so your pages stay available — it takes a minute.</p>` +
          `<p>${button(creatorLink("/connect"), "Reconnect Facebook")}</p>`;
        let sent = false;
        try {
          sent = (await sendCreatorEmail(c.creator.email, "Reconnect Facebook to keep your pages active", "Your Facebook connection expires soon", body)) != null;
        } catch (e) {
          console.warn(`[creator-token-health] email failed for ${c.id}: ${scrubSecrets(String(e))}`);
        }
        if (sent) out.emailed++;
        else {
          // Not delivered (no SMTP, Gmail refusing): release the stage so tomorrow tries again.
          await prisma.creatorConnection.updateMany({
            where: { id: c.id, expiryWarnedDays: stage },
            data: { expiryWarnedDays: c.expiryWarnedDays },
          });
        }
      }
    }
  }
  return out;
}

/**
 * Delete page details we no longer need: creator_assets rows disconnected, and connections
 * revoked (cascading their remaining assets), more than PURGE_AFTER_DAYS ago. Tokens were
 * nulled at the disconnect itself. The creators row is kept (see the privacy page).
 * ⚠️ Phase B: when bookings/offers reference creator_assets, keep assets with offers.
 */
export async function purgeCreatorPageData(now = new Date()) {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS);
  const assets = await prisma.creatorAsset.deleteMany({ where: { disconnectedAt: { lt: cutoff } } });
  const connections = await prisma.creatorConnection.deleteMany({ where: { revokedAt: { lt: cutoff } } });
  return { assets: assets.count, connections: connections.count };
}

let running = false;

/** One daily pass. Overlap guard claimed SYNCHRONOUSLY, before the first await. */
export async function runCreatorDaily(): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    if (!creatorConfig.enabled() || !creatorConfig.cronsEnabled()) return true;
    try {
      const h = await runCreatorTokenHealth();
      if (h.soon || h.expired || h.emailed) console.log("[creator-token-health]", JSON.stringify(h));
    } catch (e) {
      console.error("[creator-token-health] failed:", scrubSecrets(String(e)));
    }
    try {
      const d = await syncNetworkDuplicates();
      if (d.flagged || d.cleared) console.log("[creator-duplicates]", JSON.stringify(d));
    } catch (e) {
      console.error("[creator-duplicates] failed:", scrubSecrets(String(e)));
    }
    if (creatorMetaConfigured()) {
      try {
        await refreshCreatorMetrics();
      } catch (e) {
        console.error("[creator-metrics] failed:", scrubSecrets(String(e)));
      }
    }
    try {
      const p = await purgeCreatorPageData();
      if (p.assets || p.connections) console.log("[creator-purge]", JSON.stringify(p));
    } catch (e) {
      console.error("[creator-purge] failed:", scrubSecrets(String(e)));
    }
    const pruned = await pruneCreatorOauthStates();
    if (pruned) console.log(`[creator-cron] pruned ${pruned} expired oauth states`);
    return true;
  } finally {
    running = false;
  }
}

export function startCreatorCrons() {
  if (!creatorConfig.enabled() || !creatorConfig.cronsEnabled()) return;
  const tick = () => {
    runCreatorDaily().catch((e) => console.error("[creator-cron] tick failed:", scrubSecrets(String(e))));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, DAY_MS);
  }, 25 * 60_000);
}
