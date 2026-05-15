import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { attendanceValidators } from "@dashmani/shared";
import * as attendanceService from "../services/attendance.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";

const router = Router();

router.post("/attendance/check-in", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = await attendanceService.checkIn(req.user!.userId, req.ip);
    return success(res, record, undefined, 201);
  } catch (err) { next(err); }
});

router.post("/attendance/check-out", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = await attendanceService.checkOut(req.user!.userId);
    return success(res, record);
  } catch (err) { next(err); }
});

router.get("/attendance", authenticate, requirePermission("attendance", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as any);
    const scope = (req as any).permissionScope;

    // If scope is "own", force filter to current user
    const employeeId = scope === "own" ? req.user!.userId : (req.query.employeeId as string);

    const result = await attendanceService.getAttendanceRecords({
      ...pagination,
      employeeId,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      status: req.query.status as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.post("/attendance/leave", authenticate, validate(attendanceValidators.leaveRequestSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leave = await attendanceService.createLeaveRequest(req.user!.userId, req.body);
    return success(res, leave, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/attendance/leave/:id/approve", authenticate, requirePermission("attendance", "approve"), auditLog("attendance", "approve_leave"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await attendanceService.approveLeaveRequest(req.params.id, req.user!.userId, req.body.approved);
    return success(res, result);
  } catch (err) { next(err); }
});

// POST /attendance/manual — admin creates a manual attendance record
router.post("/attendance/manual", authenticate, requirePermission("attendance", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, date, checkIn, checkOut, status, note } = req.body;
    if (!userId || !date || !status) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "userId, date, and status are required" } });
    }
    const { prisma } = await import("@dashmani/db");
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);

    const record = await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId: userId, date: dayStart } },
      update: {
        status,
        ...(checkIn ? { checkIn: new Date(checkIn) } : {}),
        ...(checkOut ? { checkOut: new Date(checkOut) } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      create: {
        employeeId: userId,
        date: dayStart,
        status,
        ...(checkIn ? { checkIn: new Date(checkIn) } : {}),
        ...(checkOut ? { checkOut: new Date(checkOut) } : {}),
        ...(note !== undefined ? { note } : {}),
      },
    });
    return success(res, record, undefined, 201);
  } catch (err) { next(err); }
});

// PUT /attendance/:id/override — admin overrides an existing attendance record
router.put("/attendance/:id/override", authenticate, requirePermission("attendance", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { checkIn, checkOut, status, note } = req.body;
    const { prisma } = await import("@dashmani/db");
    const record = await prisma.attendance.update({
      where: { id: req.params.id },
      data: {
        ...(status ? { status } : {}),
        ...(checkIn ? { checkIn: new Date(checkIn) } : {}),
        ...(checkOut ? { checkOut: new Date(checkOut) } : {}),
        ...(note !== undefined ? { note } : {}),
      },
    });
    return success(res, record);
  } catch (err) { next(err); }
});

export default router;
