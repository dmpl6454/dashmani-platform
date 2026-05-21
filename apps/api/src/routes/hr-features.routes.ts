import { Router, Request, Response, NextFunction } from "express";
import { authenticateHr } from "../middleware/hr-auth";
import { success } from "../utils/response";
import https from "https";
import http from "http";
import * as salaryService from "../services/salary-slip.service";
import * as documentService from "../services/document.service";
import * as profilePicService from "../services/profile-picture.service";
import * as offerLetterService from "../services/offer-letter.service";
import * as contractService from "../services/employment-contract.service";
import * as holidayService from "../services/holiday.service";
import * as leaveService from "../services/leave.service";
import { uploadDocument, uploadProfilePicture, toUploadUrl } from "../middleware/upload";
import * as extraWorkService from "../services/extra-work.service";
import * as incentiveService from "../services/incentive.service";
import * as reviewService from "../services/performance-review.service";
import * as bugReportService from "../services/bug-report.service";
import * as aiService from "../services/ai.service";
import * as attendanceService from "../services/attendance.service";
import * as notificationService from "../services/notification.service";
import { notifyHrByEmail, notifyAdminByEmail } from "../services/email.service";
import * as profileService from "../services/employee-profile.service";
import * as reportService from "../services/daily-report.service";
import { getLeaderboard, getTeamDashboard } from "../services/leaderboard.service";
import { prisma } from "@dashmani/db";
import bcrypt from "bcrypt";

const router = Router();

// ===== Salary Slips =====

// GET /hr/salary-slips — list employee's salary slips
router.get("/hr/salary-slips", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slips = await salaryService.getEmployeeSalarySlips(req.user!.userId);
    return success(res, slips);
  } catch (err) {
    next(err);
  }
});

// GET /hr/salary-slips/:id — get single salary slip (must belong to user)
router.get("/hr/salary-slips/:id", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slip = await salaryService.getSalarySlipById(req.params.id);
    if (!slip || slip.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Salary slip not found" });
    }
    return success(res, slip);
  } catch (err) {
    next(err);
  }
});

// ===== Documents =====

// POST /hr/documents — upload a document
router.post(
  "/hr/documents",
  authenticateHr,
  uploadDocument.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await documentService.uploadDocument({
        employeeId: req.user!.userId,
        documentType: req.body.documentType,
        fileName: req.file!.originalname,
        filePath: toUploadUrl(req.file!.path),
        fileSize: req.file!.size,
        mimeType: req.file!.mimetype,
      });
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
      notificationService.notifyAdmins(
        "GENERAL",
        "New Document Upload",
        `${user?.name || "An employee"} uploaded a ${req.body.documentType} document for review`,
        { documentId: doc.id }
      ).catch(() => {});
      notifyHrByEmail("New Document Upload", [
        { label: "Employee", value: user?.name || "Unknown" },
        { label: "Type", value: req.body.documentType },
        { label: "File", value: req.file!.originalname },
      ], "/approvals").catch(() => {});
      return success(res, doc, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /hr/documents — list employee's documents
router.get("/hr/documents", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const docs = await documentService.getEmployeeDocuments(req.user!.userId);
    return success(res, docs);
  } catch (err) {
    next(err);
  }
});

// ===== Profile Picture =====

// POST /hr/profile-picture — request profile picture change
router.post(
  "/hr/profile-picture",
  authenticateHr,
  uploadProfilePicture.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await profilePicService.requestProfilePictureChange(req.user!.userId, toUploadUrl(req.file!.path));
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /hr/profile-picture/requests — list profile picture change requests
router.get("/hr/profile-picture/requests", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requests = await profilePicService.getEmployeeProfilePicRequests(req.user!.userId);
    return success(res, requests);
  } catch (err) {
    next(err);
  }
});

// ===== Offer Letters =====

// GET /hr/offer-letters — list employee's offer letters
router.get("/hr/offer-letters", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const letters = await offerLetterService.getOfferLetters(req.user!.userId);
    return success(res, letters);
  } catch (err) {
    next(err);
  }
});

// GET /hr/offer-letters/:id — get single offer letter (must belong to user)
router.get("/hr/offer-letters/:id", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const letter = await offerLetterService.getOfferLetterById(req.params.id);
    if (!letter || letter.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Offer letter not found" });
    }
    return success(res, letter);
  } catch (err) {
    next(err);
  }
});

// GET /hr/offer-letters/:id/html — get offer letter HTML (must belong to user)
router.get("/hr/offer-letters/:id/html", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const letter = await offerLetterService.getOfferLetterById(req.params.id);
    if (!letter || letter.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Offer letter not found" });
    }
    const html = await offerLetterService.getOfferLetterHtml(req.params.id);
    return success(res, html);
  } catch (err) {
    next(err);
  }
});

// ===== Employment Contracts =====

// GET /hr/contract — get employee's active contract
router.get("/hr/contract", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contract = await contractService.getEmployeeContract(req.user!.userId);
    return success(res, contract);
  } catch (err) {
    next(err);
  }
});

// GET /hr/contract/pending — get pending contract for employee
router.get("/hr/contract/pending", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contract = await contractService.getPendingContractForEmployee(req.user!.userId);
    return success(res, contract);
  } catch (err) {
    next(err);
  }
});

// POST /hr/contract/:id/agree — agree to a contract
router.post("/hr/contract/:id/agree", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await contractService.agreeToContract(req.params.id, req.user!.userId, req.ip);
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /hr/contract/:id/html — get contract HTML (must belong to user)
router.get("/hr/contract/:id/html", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contract = await contractService.getContractById(req.params.id);
    if (!contract || contract.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Contract not found" });
    }
    const html = await contractService.getContractHtml(req.params.id);
    return success(res, html);
  } catch (err) {
    next(err);
  }
});

// ===== Calendar & Holidays =====

// GET /hr/holidays — list holidays
router.get("/hr/holidays", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    const holidays = await holidayService.listHolidays(year);
    return success(res, holidays);
  } catch (err) {
    next(err);
  }
});

// GET /hr/calendar — get calendar data for a month
router.get("/hr/calendar", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = parseInt(req.query.year as string);
    const month = parseInt(req.query.month as string);
    const calendar = await holidayService.getCalendarData(year, month, req.user!.userId);
    return success(res, calendar);
  } catch (err) {
    next(err);
  }
});

// ===== Leave Requests =====

// POST /hr/leave-requests — create a leave request
router.post("/hr/leave-requests", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const leaveRequest = await leaveService.createLeaveRequest({
      ...req.body,
      employeeId: req.user!.userId,
    });
    // Notify admins about the new request
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
    const typeLabel = (req.body.type || "LEAVE").replace("_", " ");
    notificationService.notifyAdmins(
      "GENERAL",
      `New ${typeLabel} Request`,
      `${user?.name || "An employee"} has requested ${typeLabel} from ${req.body.startDate} to ${req.body.endDate || req.body.startDate}`,
      { leaveRequestId: leaveRequest.id, type: req.body.type }
    ).catch(() => {});
    // Email notifications
    const empName = user?.name || "An employee";
    notifyHrByEmail(`New ${typeLabel} Request`, [
      { label: "Employee", value: empName },
      { label: "Type", value: typeLabel },
      { label: "From", value: req.body.startDate },
      { label: "To", value: req.body.endDate || req.body.startDate },
      { label: "Reason", value: req.body.reason || "—" },
    ], "/approvals").catch(() => {});
    notifyAdminByEmail(`New ${typeLabel} Request`, [
      { label: "Employee", value: empName },
      { label: "Type", value: typeLabel },
      { label: "Dates", value: `${req.body.startDate} to ${req.body.endDate || req.body.startDate}` },
    ], "/approvals").catch(() => {});
    return success(res, leaveRequest, undefined, 201);
  } catch (err) {
    next(err);
  }
});

// GET /hr/leave-requests — list employee's leave requests
router.get("/hr/leave-requests", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    const leaves = await leaveService.getEmployeeLeaves(req.user!.userId, year);
    return success(res, leaves);
  } catch (err) {
    next(err);
  }
});

// GET /hr/leave-balance — get leave balance
router.get("/hr/leave-balance", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = req.query.year ? parseInt(req.query.year as string) : new Date().getFullYear();
    const balance = await leaveService.getLeaveBalance(req.user!.userId, year);
    return success(res, balance);
  } catch (err) {
    next(err);
  }
});

// ===== Attendance =====

router.get("/hr/attendance", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const result = await attendanceService.getAttendanceRecords({
      employeeId: req.user!.userId,
      startDate: startOfMonth.toISOString().slice(0, 10),
      endDate: now.toISOString().slice(0, 10),
      limit: 100,
    });

    const records = result.items;
    const totalWorkdays = (() => {
      let count = 0;
      const d = new Date(startOfMonth);
      while (d <= now) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) count++;
        d.setDate(d.getDate() + 1);
      }
      return count;
    })();

    const present = records.filter((r: any) => r.status === "PRESENT" || r.status === "LATE").length;
    const late = records.filter((r: any) => r.status === "LATE").length;
    const halfDay = records.filter((r: any) => r.status === "HALF_DAY").length;
    const absent = totalWorkdays - present - halfDay;
    const rate = totalWorkdays > 0 ? Math.round(((present + halfDay * 0.5) / totalWorkdays) * 100) : 0;

    return success(res, { totalWorkdays, present, late, halfDay, absent: Math.max(0, absent), rate, records });
  } catch (err) {
    next(err);
  }
});

// ===== Extra Work Hours =====

router.post("/hr/extra-hours", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await extraWorkService.createExtraWorkHour({ ...req.body, employeeId: req.user!.userId });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
    notificationService.notifyAdmins(
      "GENERAL",
      "Extra Hours Request",
      `${user?.name || "An employee"} logged ${req.body.hours}h extra work for approval`,
      { extraHourId: result.id }
    ).catch(() => {});
    return success(res, result, undefined, 201);
  } catch (err) { next(err); }
});

router.get("/hr/extra-hours", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    return success(res, await extraWorkService.getEmployeeExtraHours(req.user!.userId, year));
  } catch (err) { next(err); }
});

// ===== Incentives (read-only for employees) =====

router.get("/hr/incentives", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    return success(res, await incentiveService.getEmployeeIncentives(req.user!.userId, year));
  } catch (err) { next(err); }
});

// ===== Performance Reviews (read-only for employees) =====

router.get("/hr/performance-reviews", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await reviewService.getEmployeeReviews(req.user!.userId));
  } catch (err) { next(err); }
});

// ===== Bug Reports =====

router.post("/hr/bug-reports", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await bugReportService.createBugReport({ ...req.body, reportedBy: req.user!.userId }), undefined, 201);
  } catch (err) { next(err); }
});

router.get("/hr/bug-reports", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await bugReportService.getMyBugReports(req.user!.userId));
  } catch (err) { next(err); }
});

// ===== Tasks (assigned by admin, viewable by employee) =====

router.get("/hr/tasks", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { assigneeId: req.user!.userId },
      include: {
        createdBy: { select: { id: true, name: true } },
        account: { select: { id: true, displayName: true, handle: true } },
        comments: {
          include: { author: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return success(res, tasks);
  } catch (err) { next(err); }
});

router.put("/hr/tasks/:id/status", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task || task.assigneeId !== req.user!.userId) {
      return res.status(404).json({ error: "Task not found" });
    }
    const updated = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: req.body.status, completedAt: req.body.status === "DONE" ? new Date() : null },
    });
    return success(res, updated);
  } catch (err) { next(err); }
});

router.post("/hr/tasks/:id/comments", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!task || task.assigneeId !== req.user!.userId) {
      return res.status(404).json({ error: "Task not found" });
    }
    const comment = await prisma.taskComment.create({
      data: { taskId: req.params.id, authorId: req.user!.userId, body: req.body.content },
      include: { author: { select: { id: true, name: true } } },
    });
    return success(res, comment, undefined, 201);
  } catch (err) { next(err); }
});

// ===== Expense Claims =====

router.post("/hr/expenses", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const expense = await prisma.expenseClaim.create({
      data: {
        employeeId: req.user!.userId,
        title: req.body.title,
        amount: parseFloat(req.body.amount),
        category: req.body.category,
        description: req.body.description,
        receiptUrl: req.body.receiptUrl,
      },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
    notificationService.notifyAdmins(
      "GENERAL",
      "New Expense Claim",
      `${user?.name || "An employee"} submitted an expense claim of ₹${req.body.amount} for "${req.body.title}"`,
      { expenseId: expense.id }
    ).catch(() => {});
    notifyHrByEmail("New Expense Claim", [
      { label: "Employee", value: user?.name || "Unknown" },
      { label: "Title", value: req.body.title },
      { label: "Amount", value: `₹${req.body.amount}` },
      { label: "Category", value: req.body.category || "OTHER" },
    ], "/expenses").catch(() => {});
    notifyAdminByEmail("New Expense Claim", [
      { label: "Employee", value: user?.name || "Unknown" },
      { label: "Amount", value: `₹${req.body.amount}` },
      { label: "Title", value: req.body.title },
    ], "/expenses").catch(() => {});
    return success(res, expense, undefined, 201);
  } catch (err) { next(err); }
});

router.get("/hr/expenses", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const expenses = await prisma.expenseClaim.findMany({
      where: { employeeId: req.user!.userId },
      orderBy: { createdAt: "desc" },
    });
    return success(res, expenses);
  } catch (err) { next(err); }
});

// ===== Presentations (Marp) =====

router.post("/hr/presentations", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, markdown, theme } = req.body;
    if (!title || !markdown) {
      return res.status(400).json({ error: "Title and markdown are required" });
    }
    const presentation = await prisma.presentation.create({
      data: { employeeId: req.user!.userId, title, markdown, theme: theme || "default" },
    });
    return success(res, presentation, undefined, 201);
  } catch (err) { next(err); }
});

router.get("/hr/presentations", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const presentations = await prisma.presentation.findMany({
      where: { employeeId: req.user!.userId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, theme: true, createdAt: true, updatedAt: true },
    });
    return success(res, presentations);
  } catch (err) { next(err); }
});

router.get("/hr/presentations/:id", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = await prisma.presentation.findUnique({ where: { id: req.params.id } });
    if (!p || p.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Presentation not found" });
    }
    return success(res, p);
  } catch (err) { next(err); }
});

router.put("/hr/presentations/:id", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = await prisma.presentation.findUnique({ where: { id: req.params.id } });
    if (!p || p.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Presentation not found" });
    }
    const updated = await prisma.presentation.update({
      where: { id: req.params.id },
      data: { title: req.body.title, markdown: req.body.markdown, theme: req.body.theme },
    });
    return success(res, updated);
  } catch (err) { next(err); }
});

router.delete("/hr/presentations/:id", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = await prisma.presentation.findUnique({ where: { id: req.params.id } });
    if (!p || p.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Presentation not found" });
    }
    await prisma.presentation.delete({ where: { id: req.params.id } });
    return success(res, { message: "Deleted" });
  } catch (err) { next(err); }
});

router.post("/hr/presentations/:id/export", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = await prisma.presentation.findUnique({ where: { id: req.params.id } });
    if (!p || p.employeeId !== req.user!.userId) {
      return res.status(404).json({ error: "Presentation not found" });
    }
    const { execSync } = require("child_process");
    const fs = require("fs");
    const path = require("path");
    const tmpDir = path.join("/tmp", "marp-" + p.id);
    fs.mkdirSync(tmpDir, { recursive: true });
    const mdPath = path.join(tmpDir, "slides.md");
    const htmlPath = path.join(tmpDir, "slides.html");
    fs.writeFileSync(mdPath, p.markdown);
    execSync(`marp "${mdPath}" -o "${htmlPath}" --html --theme ${p.theme || "default"}`, { timeout: 30000 });
    const html = fs.readFileSync(htmlPath, "utf-8");
    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  } catch (err) { next(err); }
});

// ===== AI Presentation/Report Generator =====

router.post("/hr/presentations/ai/generate", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { topic, type, slideCount, style, audience, additionalNotes } = req.body;
    if (!topic || !type) {
      return res.status(400).json({ error: "Topic and type are required" });
    }
    if (!["presentation", "report"].includes(type)) {
      return res.status(400).json({ error: "Type must be 'presentation' or 'report'" });
    }
    const result = await aiService.generateAIPresentation({ topic, type, slideCount, style, audience, additionalNotes });
    return success(res, result);
  } catch (err) { next(err); }
});

// ===== Password Change =====

router.post("/hr/change-password", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: "User not found" });
    }
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
    return success(res, { message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
});

// ===== Daily POA (Plan of Action) =====

router.post("/hr/poa", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date, tasks, achievements, blockers, tomorrowPlan } = req.body;
    if (!tasks) return res.status(400).json({ error: "Tasks field is required" });
    const poaDate = new Date(date || new Date());
    poaDate.setHours(0, 0, 0, 0);
    // Upsert: one entry per employee per day
    const poa = await prisma.dailyPOA.upsert({
      where: { employeeId_date: { employeeId: req.user!.userId, date: poaDate } },
      update: { tasks, achievements, blockers, tomorrowPlan },
      create: { employeeId: req.user!.userId, date: poaDate, tasks, achievements, blockers, tomorrowPlan },
    });
    return success(res, poa, undefined, 201);
  } catch (err) { next(err); }
});

router.get("/hr/poa", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = req.query as { from?: string; to?: string };
    const where: any = { employeeId: req.user!.userId };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    const poas = await prisma.dailyPOA.findMany({ where, orderBy: { date: "desc" }, take: 30 });
    return success(res, poas);
  } catch (err) { next(err); }
});

router.get("/hr/poa/:date", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = new Date(req.params.date);
    d.setHours(0, 0, 0, 0);
    const poa = await prisma.dailyPOA.findUnique({
      where: { employeeId_date: { employeeId: req.user!.userId, date: d } },
    });
    return success(res, poa);
  } catch (err) { next(err); }
});

// ===== Complaints =====

router.post("/hr/complaints", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { subject, description, category } = req.body;
    if (!subject || !description) return res.status(400).json({ error: "Subject and description are required" });
    const complaint = await prisma.complaint.create({
      data: { employeeId: req.user!.userId, subject, description, category: category || "GENERAL" },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
    notificationService.notifyAdmins("GENERAL", "New Employee Complaint", `${user?.name || "An employee"} submitted a complaint: "${subject}"`, { complaintId: complaint.id }).catch(() => {});
    notifyHrByEmail("New Employee Complaint", [
      { label: "Employee", value: user?.name || "Unknown" },
      { label: "Subject", value: subject },
      { label: "Category", value: category || "GENERAL" },
    ], "/complaints").catch(() => {});
    return success(res, complaint, undefined, 201);
  } catch (err) { next(err); }
});

router.get("/hr/complaints", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const complaints = await prisma.complaint.findMany({
      where: { employeeId: req.user!.userId },
      orderBy: { createdAt: "desc" },
    });
    return success(res, complaints);
  } catch (err) { next(err); }
});

// ===== Joining Date =====

router.get("/hr/joining-date", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await prisma.employeeProfile.findUnique({
      where: { userId: req.user!.userId },
      select: { joiningDate: true, joiningDateApproved: true },
    });
    return success(res, profile || { joiningDate: null, joiningDateApproved: false });
  } catch (err) { next(err); }
});

router.post("/hr/joining-date", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { joiningDate } = req.body;
    if (!joiningDate) return res.status(400).json({ error: "Joining date is required" });
    const profile = await prisma.employeeProfile.upsert({
      where: { userId: req.user!.userId },
      update: { joiningDate: new Date(joiningDate), joiningDateApproved: false },
      create: { userId: req.user!.userId, joiningDate: new Date(joiningDate) },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
    notificationService.notifyAdmins("GENERAL", "Joining Date Submitted", `${user?.name || "An employee"} submitted their joining date: ${joiningDate}`, {}).catch(() => {});
    notifyHrByEmail("Joining Date Submitted", [
      { label: "Employee", value: user?.name || "Unknown" },
      { label: "Joining Date", value: joiningDate },
    ], "/employees").catch(() => {});
    return success(res, profile);
  } catch (err) { next(err); }
});

// ===== SOP Acceptance =====

router.post("/hr/accept-sop", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await prisma.employeeProfile.upsert({
      where: { userId: req.user!.userId },
      update: { sopAcceptedAt: new Date() },
      create: { userId: req.user!.userId, sopAcceptedAt: new Date() },
    });
    return success(res, profile);
  } catch (err) { next(err); }
});

router.get("/hr/sop-status", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await prisma.employeeProfile.findUnique({
      where: { userId: req.user!.userId },
      select: { sopAcceptedAt: true },
    });
    return success(res, { accepted: !!profile?.sopAcceptedAt, acceptedAt: profile?.sopAcceptedAt });
  } catch (err) { next(err); }
});

// ===== Profile =====

// GET /hr/profile — get own profile
router.get("/hr/profile", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await profileService.getProfile(req.user!.userId);
    return success(res, profile);
  } catch (err) { next(err); }
});

// PUT /hr/profile — update own profile
router.put("/hr/profile", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await profileService.updateProfile(req.user!.userId, req.body);
    return success(res, updated);
  } catch (err) { next(err); }
});

// ===== Daily Reports (employee-scoped) =====

// GET /hr/reports/today — get today's report for self
router.get("/hr/reports/today", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await reportService.getTodayReport(req.user!.userId);
    return success(res, report);
  } catch (err) { next(err); }
});

// GET /hr/reports — get own report history
router.get("/hr/reports", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    const reports = await reportService.getMyReports(req.user!.userId, startDate, endDate);
    return success(res, reports);
  } catch (err) { next(err); }
});

// POST /hr/reports — submit a daily report
router.post("/hr/reports", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date, links, notes, latitude, longitude } = req.body;
    const report = await reportService.submitDailyReport(
      req.user!.userId,
      date,
      links,
      notes,
      latitude,
      longitude,
    );
    return success(res, report, undefined, 201);
  } catch (err) { next(err); }
});

// GET /hr/preview — fetch Open Graph metadata for a URL (used by smart paste UI)
router.get("/hr/preview", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.query as { url?: string };
    if (!url) return success(res, null);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return success(res, null);
    }

    // Only allow http/https
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return success(res, null);

    const fetchHtml = (target: URL): Promise<string> =>
      new Promise((resolve, reject) => {
        const mod = target.protocol === "https:" ? https : http;
        const reqOptions = {
          hostname: target.hostname,
          path: target.pathname + target.search,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; DashmaniBot/1.0)",
            Accept: "text/html",
          },
          timeout: 5000,
        };
        const req = mod.get(reqOptions, (res) => {
          // Follow one redirect
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            try {
              return resolve(fetchHtml(new URL(res.headers.location, target)));
            } catch { return resolve(""); }
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { data += chunk; if (data.length > 50000) res.destroy(); });
          res.on("end", () => resolve(data));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      });

    let html = "";
    try { html = await fetchHtml(parsedUrl); } catch { return success(res, null); }

    const getMeta = (property: string): string => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, "i"));
      return m ? m[1] : "";
    };

    const title = getMeta("og:title") || getMeta("twitter:title") || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "");
    const description = getMeta("og:description") || getMeta("twitter:description") || getMeta("description");
    const image = getMeta("og:image") || getMeta("twitter:image");

    return success(res, {
      title: title.trim().slice(0, 200),
      description: description.trim().slice(0, 400),
      image: image.trim().slice(0, 500),
    });
  } catch (err) { next(err); }
});

// ===== Accounts =====

// GET /hr/accounts — get social accounts assigned to self
router.get("/hr/accounts", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await reportService.getAssignedAccounts(req.user!.userId);
    return success(res, accounts);
  } catch (err) { next(err); }
});

// ===== Leaderboard =====

// GET /hr/leaderboard
router.get("/hr/leaderboard", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    const leaderboard = await getLeaderboard(startDate, endDate);
    return success(res, leaderboard);
  } catch (err) { next(err); }
});

// ===== Team =====

// GET /hr/team — get own team dashboard (team lead only)
router.get("/hr/team", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dashboard = await getTeamDashboard(req.user!.userId);
    return success(res, dashboard);
  } catch (err) { next(err); }
});

// ===== Notifications =====

// GET /hr/notifications — list own notifications
router.get("/hr/notifications", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const unreadOnly = req.query.unread === "true";
    const notifications = await notificationService.getUserNotifications(req.user!.userId, unreadOnly);
    return success(res, notifications);
  } catch (err) { next(err); }
});

// GET /hr/notifications/count — unread count
router.get("/hr/notifications/count", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await notificationService.getUnreadCount(req.user!.userId);
    return success(res, { count });
  } catch (err) { next(err); }
});

// PUT /hr/notifications/:id/read — mark one as read
router.put("/hr/notifications/:id/read", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await notificationService.markAsRead(req.params.id, req.user!.userId);
    return success(res, { ok: true });
  } catch (err) { next(err); }
});

// PUT /hr/notifications/read-all — mark all as read
router.put("/hr/notifications/read-all", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await notificationService.markAllAsRead(req.user!.userId);
    return success(res, { ok: true });
  } catch (err) { next(err); }
});

export default router;
