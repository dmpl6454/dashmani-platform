import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mock the prisma client BEFORE importing the middleware.
vi.mock("@dashmani/db", () => ({
  prisma: { userRole: { findMany: vi.fn() } },
}));

import { prisma } from "@dashmani/db";
import { requirePermission } from "../src/middleware/rbac";

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res as Response);
  res.json = vi.fn().mockReturnValue(res as Response);
  return res as Response;
}

describe("requirePermission — DB error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards a Prisma error to next(err) instead of throwing (no process crash)", async () => {
    const boom = new Error("P2024: Timed out fetching a connection from the pool");
    (prisma.userRole.findMany as any).mockRejectedValue(boom);

    const req = { user: { userId: "u1" } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    // Must RESOLVE (not reject) — the wrapper catches and calls next.
    await requirePermission("reports", "view")(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as any).mock.calls[0][0]).toBe(boom); // the error was forwarded
    expect(res.status).not.toHaveBeenCalled(); // handler didn't respond itself
  });

  it("still 403s when the user lacks the permission (happy-path guard intact)", async () => {
    (prisma.userRole.findMany as any).mockResolvedValue([]); // no roles → no perm
    const req = { user: { userId: "u1" } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requirePermission("reports", "view")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
