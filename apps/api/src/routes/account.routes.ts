import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { accountValidators } from "@dashmani/shared";
import * as accountService from "../services/account.service";
import { syncAllFollowerCounts, syncSingleAccountFollowers } from "../services/follower-sync.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";

const router = Router();

router.get("/platforms", authenticate, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const platforms = await accountService.listPlatforms();
    return success(res, platforms);
  } catch (err) { next(err); }
});

router.get("/accounts", authenticate, requirePermission("accounts", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as any);
    const result = await accountService.listAccounts({
      ...pagination,
      platformId: req.query.platformId as string,
      status: req.query.status as string,
      search: req.query.search as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.get("/accounts/:id", authenticate, requirePermission("accounts", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await accountService.getAccountById(req.params.id);
    return success(res, account);
  } catch (err) { next(err); }
});

router.post("/accounts", authenticate, requirePermission("accounts", "create"), validate(accountValidators.createAccountSchema), auditLog("accounts", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await accountService.createAccount(req.body);
    return success(res, account, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/accounts/:id", authenticate, requirePermission("accounts", "edit"), validate(accountValidators.updateAccountSchema), auditLog("accounts", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await accountService.updateAccount(req.params.id, req.body);
    return success(res, account);
  } catch (err) { next(err); }
});

router.post("/accounts/:id/assign", authenticate, requirePermission("accounts", "edit"), validate(accountValidators.assignAccountSchema), auditLog("accounts", "assign"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const assignment = await accountService.assignEmployee(req.params.id, req.body.employeeId, req.user!.userId, req.body.reason);
    return success(res, assignment, undefined, 201);
  } catch (err) { next(err); }
});

router.delete("/accounts/:id/assign/:employeeId", authenticate, requirePermission("accounts", "edit"), auditLog("accounts", "unassign"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await accountService.unassignEmployee(req.params.id, req.params.employeeId);
    return success(res, { message: "Employee unassigned" });
  } catch (err) { next(err); }
});

// POST /accounts/sync-followers — trigger sync for all Instagram + YouTube accounts
router.post("/accounts/sync-followers", authenticate, requirePermission("accounts", "edit"), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Run in background, return immediately
    syncAllFollowerCounts()
      .then((results) => console.log("[follower-sync] Completed:", results))
      .catch((err) => console.error("[follower-sync] Error:", err));
    return success(res, { message: "Follower sync started in background. Instagram & YouTube accounts will be updated." });
  } catch (err) { next(err); }
});

// POST /accounts/:id/sync-followers — sync a single account
router.post("/accounts/:id/sync-followers", authenticate, requirePermission("accounts", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await syncSingleAccountFollowers(req.params.id);
    return success(res, result);
  } catch (err) { next(err); }
});

router.get("/workload", authenticate, requirePermission("accounts", "view"), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const matrix = await accountService.getWorkloadMatrix();
    return success(res, matrix);
  } catch (err) { next(err); }
});

export default router;
