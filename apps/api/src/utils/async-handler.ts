import { Request, Response, NextFunction } from "express";

/**
 * Wrap an async Express handler/middleware so a rejected promise is forwarded to
 * `next(err)` instead of becoming an unhandled rejection. Express 4 does NOT catch
 * rejections thrown by async middleware — an unguarded `await` that throws will crash
 * the whole Node process. This wrapper is the fix. (Incident 2026-07-08: an unguarded
 * `await prisma.userRole.findMany` in requirePermission turned a P2024 pool timeout
 * into a multi-hour process crash-loop.)
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Returning the promise (rather than a bare void call) is what lets tests/callers
    // that `await` the wrapped handler observe next()/res being called deterministically
    // — Express itself ignores the return value, so this is a no-op for production.
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}
