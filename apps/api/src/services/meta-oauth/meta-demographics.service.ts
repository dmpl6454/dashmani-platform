/**
 * WHO an Instagram audience is — the distributions behind the scalar metrics.
 *
 * ⚠️ INSTAGRAM ONLY. Facebook's whole fan-demographic family (page_fans_country,
 * page_fans_city, page_fans_locale …) was retired with the rest of the 2025/26
 * deprecation and returns (#100). There is no Facebook equivalent to add later.
 *
 * ⚠️ RUNS ON ITS OWN DAILY CADENCE, NOT WITH THE 3-HOURLY CHANNEL SYNC. A full
 * pass is 3 audiences x 4 dimensions x ~48 accounts = ~576 calls, which would
 * nearly double the channel sync's 672 and starve the headline metrics — the
 * exact failure mode the two-phase posts sync exists to prevent. Demographics
 * move slowly, so daily is ample.
 *
 * ⚠️ Within a run it processes LEAST-RECENTLY-FETCHED FIRST and stops at the
 * budget, so coverage ROTATES instead of the same first N accounts being
 * refreshed forever while the tail is never touched. That starvation bug has bitten
 * this codebase twice (the insights cursor, the IG Tier-3 slice); the fix is the
 * same shape both times.
 *
 * Meta requires `metric_type=total_value`, `period=lifetime` and a `timeframe`
 * for these, and it withholds them entirely for accounts below its privacy
 * threshold — one live account returned 0 rows across all twelve combinations.
 * That is a legitimate empty, not a failure, and is stored as "fetched, no rows".
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget } from "./oauth-graph";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";

/** Meta's own names, mapped to the short labels we store and render. */
const AUDIENCES = [
  { metric: "follower_demographics", audience: "follower" },
  { metric: "engaged_audience_demographics", audience: "engaged" },
  { metric: "reached_audience_demographics", audience: "reached" },
] as const;

const DIMENSIONS = ["country", "city", "age", "gender"] as const;

export interface DemographicsSyncOutcome {
  accountsUpdated: number;
  rowsWritten: number;
  callsUsed: number;
  rateLimited: boolean;
  errors: string[];
}

interface BreakdownResponse {
  data?: Array<{
    total_value?: {
      breakdowns?: Array<{ results?: Array<{ dimension_values?: string[]; value?: unknown }> }>;
    };
  }>;
}

/**
 * Refresh Instagram audience demographics.
 *
 * Never throws — a demographics failure must not be able to take down anything
 * that depends on the channel data.
 */
export async function runMetaDemographicsSync(opts?: {
  assetId?: string;
  budgetMax?: number;
}): Promise<DemographicsSyncOutcome> {
  const out: DemographicsSyncOutcome = {
    accountsUpdated: 0, rowsWritten: 0, callsUsed: 0, rateLimited: false, errors: [],
  };

  const connections = await prisma.metaConnection.findMany({
    where: { revokedAt: null, status: { notIn: ["REVOKED"] } },
    select: { id: true, userTokenEnc: true },
  });

  // 12 calls per account, so ~33 accounts a run — full coverage every ~1.5 days.
  const budget: CallBudget = makeBudget(opts?.budgetMax ?? 400);

  for (const conn of connections) {
    if (!conn.userTokenEnc) continue;
    let userToken: string;
    try {
      userToken = decryptToken(conn.userTokenEnc);
    } catch {
      out.errors.push(`connection ${conn.id}: token unreadable — re-authorise`);
      continue;
    }

    const assets = await prisma.metaAsset.findMany({
      where: {
        connectionId: conn.id,
        kind: "INSTAGRAM_ACCOUNT",
        selected: true,
        disconnectedAt: null,
        ...(opts?.assetId ? { id: opts.assetId } : {}),
      },
      select: { id: true, metaId: true, name: true, demographics: { select: { fetchedAt: true }, take: 1 } },
    });

    // Least-recently-fetched first — never-fetched accounts lead. Sorted here
    // rather than in SQL because the timestamp lives on the child rows.
    assets.sort((a, b) => {
      const at = a.demographics[0]?.fetchedAt?.getTime() ?? 0;
      const bt = b.demographics[0]?.fetchedAt?.getTime() ?? 0;
      return at - bt;
    });

    for (const asset of assets) {
      if (out.rateLimited || budget.used >= budget.max) break;
      const fetchedAt = new Date();
      let wroteAny = false;

      for (const { metric, audience } of AUDIENCES) {
        for (const dimension of DIMENSIONS) {
          if (budget.used >= budget.max) break;

          const res = await oauthGraphFetch<BreakdownResponse>(
            `${asset.metaId}/insights`,
            {
              metric,
              metric_type: "total_value",
              period: "lifetime",
              breakdown: dimension,
              timeframe: "this_month",
            },
            userToken,
            { label: `demographics-${audience}-${dimension}`, budget },
          );

          if (res.rateLimited) { out.rateLimited = true; break; }
          if (!res.ok) continue; // withheld or unavailable — not an error worth surfacing

          const results = res.data?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
          const rows = results
            .map((r) => ({ bucket: String(r.dimension_values?.[0] ?? ""), value: Number(r.value) }))
            .filter((r) => r.bucket !== "" && Number.isFinite(r.value) && r.value >= 0);

          // Replace, don't upsert. A bucket that drops out of Meta's set would
          // otherwise linger forever and inflate every total drawn from this table.
          try {
            await prisma.$transaction([
              prisma.metaAssetDemographic.deleteMany({
                where: { assetId: asset.id, audience, dimension },
              }),
              ...(rows.length
                ? [prisma.metaAssetDemographic.createMany({
                    data: rows.map((r) => ({
                      assetId: asset.id, audience, dimension, bucket: r.bucket, value: r.value, fetchedAt,
                    })),
                  })]
                : []),
            ]);
            out.rowsWritten += rows.length;
            wroteAny = true;
          } catch (e) {
            out.errors.push(`${asset.name}/${audience}/${dimension}: ${scrubSecrets(String(e)).slice(0, 90)}`);
          }
        }
        if (out.rateLimited) break;
      }

      if (wroteAny) out.accountsUpdated++;
    }
  }

  out.callsUsed = budget.used;
  console.log(
    `[meta-demographics] accounts=${out.accountsUpdated} rows=${out.rowsWritten} calls=${out.callsUsed}/${budget.max}` +
      (out.rateLimited ? " RATE_LIMITED" : "") +
      (out.errors.length ? ` errors=${out.errors.length}` : ""),
  );
  return out;
}
