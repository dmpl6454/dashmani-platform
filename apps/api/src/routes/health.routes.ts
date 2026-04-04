import { Router } from "express";
import { prisma } from "@dashmani/db";
import { success, error } from "../utils/response";

const router = Router();

router.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return success(res, { status: "healthy", timestamp: new Date().toISOString() });
  } catch {
    return error(res, "UNHEALTHY", "Database connection failed", 503);
  }
});

export default router;
