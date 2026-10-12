/**
 * Creator portal — daily background work:
 *  1. token health on BOTH of Meta's clocks (token_expires_at ~60d, data_access_expires_at ~90d):
 *     ≤14 whole days left (rounded UP) → NEEDS_REAUTH_SOON, passed → NEEDS_REAUTH, and the creator
 *     is emailed exactly twice — on the day 14 days remain and the day 3 remain;
 *  2. page stats (services/creator/creator-metrics.service.ts, its own call budget);
 *  3. pruning OAuth states that expired over a day ago.
 * DB-only except the metrics step. Dark unless CREATORS_ENABLED=1; kill switch
 * CREATOR_CRONS_ENABLED=0. First run 25 min after boot (clear of every other startup burst).
 */

import { prisma } from "@dashmani/db";
import { creatorConfig } from "../services/creator/creator-config";
import { creatorMetaConfigured } from "../services/creator/creator-meta-config";
import { button, creatorLink, esc, sendCreatorEmail } from "../services/creator/creator-email";
import { refreshCreatorMetrics } from "../services/creator/creator-metrics.service";
import { pruneCreatorOauthStates } from "../services/creator/creator-oauth.service";
import { scrubSecrets } from "../utils/token-crypto";

const DAY_MS = 86_400_000;
const WARN_DAYS = 14;
/** The days on which the creator is emailed. Exactly-equal, so a daily run mails each once. */
const EMAIL_DAYS = new Set([14, 3]);

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

    if (EMAIL_DAYS.has(left)) {
      const body =
        `<p>Hi ${esc(c.creator.name)},</p>` +
        `<p>Facebook's permission for us to reach your pages ends in <b>${left} days</b>. Reconnect now so your pages stay available for bookings — it takes a minute.</p>` +
        `<p>${button(creatorLink("/connect"), "Reconnect Facebook")}</p>`;
      try {
        await sendCreatorEmail(c.creator.email, "Reconnect Facebook to keep your pages active", "Your Facebook connection expires soon", body);
        out.emailed++;
      } catch (e) {
        console.warn(`[creator-token-health] email failed for ${c.id}: ${scrubSecrets(String(e))}`);
      }
    }
  }
  return out;
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
    if (creatorMetaConfigured()) {
      try {
        await refreshCreatorMetrics();
      } catch (e) {
        console.error("[creator-metrics] failed:", scrubSecrets(String(e)));
      }
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
