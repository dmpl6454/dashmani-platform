import { prisma } from "@dashmani/db";
import { decryptToken } from "../../utils/token-crypto";
import { oauthGraphFetch, makeBudget, type OauthGraphResult } from "./oauth-graph";

interface NodesPage {
  data?: Array<{ id?: string; instagram_business_account?: { id?: string } }>;
  paging?: { next?: string };
}

/**
 * Record which Facebook Page each Instagram account hangs off (meta_assets.parent_page_id).
 *
 * The campaign publisher falls back to that Page's token — which has no timer — once the
 * connection's ~60-day login token has lapsed, so Instagram posting does not stop the day the
 * grant ages out. Discovery writes the link on every connect / "Refresh channels"; this fills
 * rows discovered before 2026-10-12 (when nothing wrote it) without anyone pressing a button.
 *
 * Cheap and idempotent: it does nothing once every Instagram account is linked. While the login
 * token is still valid it pages `me/accounts?fields=instagram_business_account` (the BARE field —
 * the nested form intermittently 500s); after it has lapsed it asks each Page with that Page's
 * own token. Bounded by a call budget either way. Never throws.
 */
export async function backfillParentPages(connectionId: string, opts: { maxCalls?: number } = {}): Promise<{ linked: number; calls: number }> {
  const out = { linked: 0, calls: 0 };
  try {
    const missing = await prisma.metaAsset.findMany({
      where: { connectionId, kind: "INSTAGRAM_ACCOUNT", parentPageId: null, disconnectedAt: null },
      select: { metaId: true },
    });
    if (missing.length === 0) return out;
    const want = new Set(missing.map((m) => m.metaId));
    const conn = await prisma.metaConnection.findUnique({
      where: { id: connectionId },
      select: { userTokenEnc: true, status: true, tokenExpiresAt: true, revokedAt: true },
    });
    if (!conn || conn.revokedAt) return out;
    const budget = makeBudget(opts.maxCalls ?? 120);
    const found = new Map<string, string>(); // igId → pageId

    const userUsable = Boolean(conn.userTokenEnc) && conn.status !== "NEEDS_REAUTH" && !(conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() <= Date.now());
    if (userUsable) {
      const token = decryptToken(conn.userTokenEnc!);
      let url: string | null = "me/accounts";
      let params: Record<string, string | number> | undefined = { fields: "instagram_business_account", limit: 50 };
      let guard = 0;
      while (url && guard++ < 200 && budget.used < budget.max && found.size < want.size) {
        const res: OauthGraphResult<NodesPage> = await oauthGraphFetch<NodesPage>(
          url, params ?? {}, token, { label: "parent-pages", budget, timeoutMs: 25_000 },
        );
        if (!res.ok || !res.data) break;
        for (const row of res.data.data ?? []) {
          const ig = row.instagram_business_account?.id;
          if (ig && row.id && want.has(ig)) found.set(ig, row.id);
        }
        url = res.data.paging?.next ?? null;
        params = undefined; // an absolute cursor carries its own params
      }
    } else {
      // The login token is gone: each Page answers for itself with its own token.
      const pages = await prisma.metaAsset.findMany({
        where: { connectionId, kind: "FACEBOOK_PAGE", disconnectedAt: null, pageTokenEnc: { not: null } },
        select: { metaId: true, pageTokenEnc: true },
        orderBy: { followerCount: "desc" },
      });
      for (const p of pages) {
        if (budget.used >= budget.max || found.size >= want.size) break;
        let token: string;
        try {
          token = decryptToken(p.pageTokenEnc!);
        } catch {
          continue;
        }
        const res = await oauthGraphFetch<{ instagram_business_account?: { id?: string } }>(
          p.metaId, { fields: "instagram_business_account" }, token, { label: "parent-pages-page", budget, timeoutMs: 10_000 },
        );
        if (res.rateLimited) break;
        const ig = res.ok ? res.data?.instagram_business_account?.id : undefined;
        if (ig && want.has(ig)) found.set(ig, p.metaId);
      }
    }
    out.calls = budget.used;
    for (const [ig, page] of found) {
      const r = await prisma.metaAsset.updateMany({
        where: { connectionId, kind: "INSTAGRAM_ACCOUNT", metaId: ig, parentPageId: null },
        data: { parentPageId: page },
      });
      out.linked += r.count;
    }
    if (out.linked) console.log(`[meta-parent-pages] ${connectionId}: linked ${out.linked} Instagram account(s) to their Page (${out.calls} calls)`);
  } catch (err) {
    console.warn("[meta-parent-pages] backfill failed:", err instanceof Error ? err.message : err);
  }
  return out;
}
