/**
 * Meta token health — surface an expiring grant BEFORE it silently stops working.
 *
 * ⚠️ WHY THIS EXISTS. Meta's long-lived user token reports `expires_at` (~60d) but the
 * operative clock is `data_access_expires_at` (~90d) — and when THAT lapses, reads
 * simply start failing. Without this cron the first symptom would be a page that
 * quietly stops updating, which is exactly the class of silent decay this codebase has
 * been bitten by repeatedly (the Aug-15 sync outage, the empty FB follower map).
 *
 * ⚠️ `data_access_expires_at` is ALWAYS read from debug_token, NEVER computed as
 * now()+90d — the real value is authoritative and drifts from any assumption.
 *
 * Cheap and DB-only in the common case: one query, no Graph calls unless a grant is
 * actually near expiry (and even then it only re-reads debug_token, one call).
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget } from "../services/meta-oauth/oauth-graph";
import { metaOauthAppId, metaOauthAppSecret, metaOauthConfigured } from "../services/meta-oauth/meta-config";
import { decryptToken, scrubSecrets } from "../utils/token-crypto";

/** Warn this far ahead so there is time to act before reads break. */
const WARN_DAYS = 14;

export async function runMetaTokenHealth(): Promise<{
  checked: number;
  warned: number;
  expired: number;
  refreshedMetadata: number;
}> {
  const out = { checked: 0, warned: 0, expired: 0, refreshedMetadata: 0 };
  if (!metaOauthConfigured()) return out;

  const conns = await prisma.metaConnection.findMany({
    where: { revokedAt: null, status: { notIn: ["REVOKED"] } },
    select: {
      id: true,
      metaUserName: true,
      status: true,
      userTokenEnc: true,
      dataAccessExpiresAt: true,
    },
  });

  const now = Date.now();
  const budget = makeBudget(Math.max(2, conns.length));

  for (const c of conns) {
    out.checked++;

    // Re-read debug_token so the stored expiry cannot silently go stale (a reconnect
    // performed elsewhere, or Meta shortening the window, both show up here).
    if (c.userTokenEnc) {
      try {
        const token = decryptToken(c.userTokenEnc);
        const res = await oauthGraphFetch<{
          data?: { is_valid?: boolean; data_access_expires_at?: number; expires_at?: number };
        }>(
          "debug_token",
          { input_token: token },
          `${metaOauthAppId()}|${metaOauthAppSecret()}`,
          { label: "token-health", budget, timeoutMs: 10_000 },
        );
        const d = res.data?.data;
        if (res.ok && d) {
          const dae = typeof d.data_access_expires_at === "number" && d.data_access_expires_at > 0
            ? new Date(d.data_access_expires_at * 1000)
            : null;
          if (d.is_valid === false) {
            await prisma.metaConnection.update({
              where: { id: c.id },
              data: {
                status: "NEEDS_REAUTH",
                lastError: "Meta reports this grant is no longer valid — reconnect to resume.",
                lastVerifiedAt: new Date(),
              },
            });
            out.expired++;
            console.warn(`[meta-token-health] ${c.metaUserName ?? c.id}: grant INVALID — needs reauth`);
            continue;
          }
          if (dae && dae.getTime() !== (c.dataAccessExpiresAt?.getTime() ?? 0)) {
            await prisma.metaConnection.update({
              where: { id: c.id },
              data: { dataAccessExpiresAt: dae, lastVerifiedAt: new Date() },
            });
            out.refreshedMetadata++;
          }
          c.dataAccessExpiresAt = dae ?? c.dataAccessExpiresAt;
        } else if (res.authInvalid) {
          await prisma.metaConnection.update({
            where: { id: c.id },
            data: {
              status: "NEEDS_REAUTH",
              lastError: scrubSecrets(res.error ?? "token rejected by Meta"),
              lastVerifiedAt: new Date(),
            },
          });
          out.expired++;
          continue;
        }
      } catch (e) {
        // A decrypt failure means the key changed — recoverable only by reconnecting.
        await prisma.metaConnection.update({
          where: { id: c.id },
          data: {
            status: "NEEDS_REAUTH",
            lastError: `Stored token could not be read (re-authorise): ${scrubSecrets(String(e))}`,
          },
        });
        out.expired++;
        continue;
      }
    }

    if (!c.dataAccessExpiresAt) continue;
    const daysLeft = Math.floor((c.dataAccessExpiresAt.getTime() - now) / 86_400_000);

    if (daysLeft <= 0) {
      await prisma.metaConnection.update({
        where: { id: c.id },
        data: {
          status: "NEEDS_REAUTH",
          lastError: "Meta data access has expired — reconnect to resume reading posts.",
        },
      });
      out.expired++;
      console.warn(`[meta-token-health] ${c.metaUserName ?? c.id}: data access EXPIRED`);
    } else if (daysLeft <= WARN_DAYS) {
      // Don't clobber a more severe status (NEEDS_REAUTH / PARTIAL_SCOPE).
      if (c.status === "ACTIVE" || c.status === "NEEDS_REAUTH_SOON") {
        await prisma.metaConnection.update({
          where: { id: c.id },
          data: {
            status: "NEEDS_REAUTH_SOON",
            lastError: `Meta data access expires in ${daysLeft} day(s) — reconnect to extend it.`,
          },
        });
      }
      out.warned++;
      console.warn(
        `[meta-token-health] ${c.metaUserName ?? c.id}: data access expires in ${daysLeft}d`,
      );
    } else if (c.status === "NEEDS_REAUTH_SOON") {
      // A reconnect happened — clear the warning rather than leaving it stuck on.
      await prisma.metaConnection.update({
        where: { id: c.id },
        data: { status: "ACTIVE", lastError: null },
      });
    }
  }

  console.log(
    `[meta-token-health] checked=${out.checked} warned=${out.warned} expired=${out.expired} ` +
      `metadataRefreshed=${out.refreshedMetadata}`,
  );
  return out;
}
