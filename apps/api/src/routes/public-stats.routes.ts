import { Router } from "express";
import { prisma } from "@dashmani/db";
import { success } from "../utils/response";
import rateLimit from "express-rate-limit";

const router = Router();

const publicStatsLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });

// In-memory cache — refreshed every hour
let cachedStats: { employeeCount: number; activeProjects: number; postsPublishedThisMonth: number } | null = null;
let cacheExpiresAt = 0;

const employeeWhere = {
  status: "ACTIVE" as const,
  deletedAt: null,
  roles: { some: { role: { name: { notIn: ["Super Admin", "Admin"] } } } },
};

async function refreshPublicStats() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [employeeCount, activeProjects] = await Promise.all([
    prisma.user.count({ where: employeeWhere }),
    prisma.project.count({ where: { status: "ACTIVE" } }),
  ]);
  // ContentPost may not exist — defensive try/catch
  let postsPublishedThisMonth = 0;
  try {
    postsPublishedThisMonth = await (prisma as any).contentPost.count({
      where: { status: "PUBLISHED", publishedAt: { gte: monthStart } },
    });
  } catch {}
  cachedStats = { employeeCount, activeProjects, postsPublishedThisMonth };
  cacheExpiresAt = Date.now() + 60 * 60 * 1000; // 1 hour TTL
  return cachedStats;
}

// GET /public/stats — no auth required
router.get("/public/stats", publicStatsLimiter, async (_req, res) => {
  try {
    if (!cachedStats || Date.now() > cacheExpiresAt) {
      await refreshPublicStats();
    }
    return success(res, cachedStats);
  } catch {
    // Fallback — don't 500 the login page
    return success(res, { employeeCount: 0, activeProjects: 0, postsPublishedThisMonth: 0 });
  }
});

export { refreshPublicStats };
export default router;
