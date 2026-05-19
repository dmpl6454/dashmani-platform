import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { success } from "../utils/response";
import { hashPassword } from "../utils/password";
import { signAccessToken, signRefreshToken } from "../utils/jwt";
import crypto from "crypto";
import * as salaryService from "../services/salary-slip.service";
import * as documentService from "../services/document.service";
import * as profilePicService from "../services/profile-picture.service";
import * as offerLetterService from "../services/offer-letter.service";
import * as contractService from "../services/employment-contract.service";
import * as holidayService from "../services/holiday.service";
import * as leaveService from "../services/leave.service";
import * as bulkImportService from "../services/bulk-import.service";
import * as extraWorkService from "../services/extra-work.service";
import * as incentiveService from "../services/incentive.service";
import * as reviewService from "../services/performance-review.service";
import * as bugReportService from "../services/bug-report.service";
import * as jobListingService from "../services/job-listing.service";
import * as aiService from "../services/ai.service";
import * as announcementService from "../services/announcement.service";
import { uploadExcel } from "../middleware/upload";
import { prisma } from "@dashmani/db";
import { notifyHrByEmail, notifyAdminByEmail, sendEmail } from "../services/email.service";
import * as notificationService from "../services/notification.service";

const router = Router();

// ===== Salary Slips =====

// POST /admin/salary-slips/generate — generate a single salary slip
router.post(
  "/admin/salary-slips/generate",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await salaryService.generateSalarySlip({
        ...req.body,
        generatedBy: (req as any).user.userId,
      });
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/salary-slips/generate-bulk — generate salary slips in bulk
router.post(
  "/admin/salary-slips/generate-bulk",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { month, year } = req.body;
      const result = await salaryService.generateBulkSalarySlips(
        month,
        year,
        (req as any).user.userId,
      );
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/salary-slips — list salary slips with filters
router.get(
  "/admin/salary-slips",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employeeId, month, year, status } = req.query as {
        employeeId?: string;
        month?: string;
        year?: string;
        status?: string;
      };
      const result = await salaryService.listSalarySlips({
        employeeId,
        month: month ? Number(month) : undefined,
        year: year ? Number(year) : undefined,
        status,
      });
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/salary-slips/:id — get a single salary slip
router.get(
  "/admin/salary-slips/:id",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await salaryService.getSalarySlipById(req.params.id);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/salary-slips/:id/approve — approve a salary slip
router.post(
  "/admin/salary-slips/:id/approve",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await salaryService.approveSalarySlip(
        req.params.id,
        (req as any).user.userId,
      );
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/salary-slips/:id/reject — reject a salary slip
router.post(
  "/admin/salary-slips/:id/reject",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await salaryService.rejectSalarySlip(
        req.params.id,
        (req as any).user.userId,
        req.body.remarks,
      );
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Documents =====

// GET /admin/documents/pending — list all pending documents
router.get(
  "/admin/documents/pending",
  authenticate,
  requirePermission("employees", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await documentService.getAllPendingDocuments();
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/documents/:id — get a single document
router.get(
  "/admin/documents/:id",
  authenticate,
  requirePermission("employees", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await documentService.getDocumentById(req.params.id);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/documents/:id/review — review a document
router.post(
  "/admin/documents/:id/review",
  authenticate,
  requirePermission("employees", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, reviewNotes } = req.body;
      const result = await documentService.reviewDocument(
        req.params.id,
        (req as any).user.userId,
        status,
        reviewNotes,
      );
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Profile Pictures =====

// GET /admin/profile-pictures/pending — list pending profile pictures
router.get(
  "/admin/profile-pictures/pending",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await profilePicService.getPendingProfilePictures();
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/profile-pictures/:id/approve — approve a profile picture
router.post(
  "/admin/profile-pictures/:id/approve",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await profilePicService.approveProfilePicture(req.params.id, (req as any).user.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/profile-pictures/:id/reject — reject a profile picture
router.post(
  "/admin/profile-pictures/:id/reject",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await profilePicService.rejectProfilePicture(req.params.id, (req as any).user.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Offer Letters =====

// POST /admin/offer-letters — generate an offer letter
router.post(
  "/admin/offer-letters",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await offerLetterService.generateOfferLetter({
        ...req.body,
        generatedBy: (req as any).user.userId,
      });
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/offer-letters — list offer letters
router.get(
  "/admin/offer-letters",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employeeId } = req.query as { employeeId?: string };
      const result = await offerLetterService.getOfferLetters(employeeId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/offer-letters/:id — get a single offer letter
router.get(
  "/admin/offer-letters/:id",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await offerLetterService.getOfferLetterById(req.params.id);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/offer-letters/:id/html — get offer letter HTML content
router.get(
  "/admin/offer-letters/:id/html",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await offerLetterService.getOfferLetterHtml(req.params.id);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Employment Contracts =====

// POST /admin/contracts — create an employment contract
router.post(
  "/admin/contracts",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await contractService.createContract(req.body);
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/contracts — list employment contracts
router.get(
  "/admin/contracts",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employeeId } = req.query as { employeeId?: string };
      const result = await contractService.listContracts({ employeeId });
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/contracts/:id/html — get contract HTML content
router.get(
  "/admin/contracts/:id/html",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await contractService.getContractHtml(req.params.id);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Holidays =====

// POST /admin/holidays — create a holiday
router.post(
  "/admin/holidays",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await holidayService.createHoliday(req.body);
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/holidays — list holidays
router.get(
  "/admin/holidays",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { year } = req.query as { year?: string };
      const result = await holidayService.listHolidays(year ? Number(year) : undefined);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /admin/holidays/:id — delete a holiday
router.delete(
  "/admin/holidays/:id",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await holidayService.deleteHoliday(req.params.id);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Leave Requests =====

// GET /admin/leave-requests — list leave requests with filters
router.get(
  "/admin/leave-requests",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, employeeId, startDate, endDate } = req.query as {
        status?: string;
        employeeId?: string;
        startDate?: string;
        endDate?: string;
      };
      const result = await leaveService.getAllLeaveRequests({
        status,
        employeeId,
        startDate,
        endDate,
      });
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/leave-requests/:id/approve — approve a leave request
router.post(
  "/admin/leave-requests/:id/approve",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await leaveService.approveLeaveRequest(req.params.id, (req as any).user.userId);
      // Notify employee via email
      const leave = await prisma.leaveRequest.findUnique({ where: { id: req.params.id }, include: { employee: { select: { name: true, email: true } } } });
      if (leave?.employee?.email) {
        sendEmail({ to: leave.employee.email, subject: `[Digital Sukoon] Your leave request has been approved`, html: `<p>Hi ${leave.employee.name},</p><p>Your leave request has been <strong>approved</strong>.</p><p>— Digital Sukoon HR</p>` }).catch(() => {});
      }
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/leave-requests/:id/reject — reject a leave request
router.post(
  "/admin/leave-requests/:id/reject",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await leaveService.rejectLeaveRequest(req.params.id, (req as any).user.userId);
      const leaveReject = await prisma.leaveRequest.findUnique({ where: { id: req.params.id }, include: { employee: { select: { name: true, email: true } } } });
      if (leaveReject?.employee?.email) {
        sendEmail({ to: leaveReject.employee.email, subject: `[Digital Sukoon] Your leave request has been rejected`, html: `<p>Hi ${leaveReject.employee.name},</p><p>Your leave request has been <strong>rejected</strong>. Please contact HR for details.</p><p>— Digital Sukoon HR</p>` }).catch(() => {});
      }
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Bulk Import =====

// POST /admin/accounts/import — import accounts from Excel file
router.post(
  "/admin/accounts/import",
  authenticate,
  requirePermission("accounts", "create"),
  uploadExcel.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await bulkImportService.importAccountsFromExcel(
        (req as any).file.path,
      );
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/accounts/import/template — download Excel import template
router.get(
  "/admin/accounts/import/template",
  authenticate,
  requirePermission("accounts", "create"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const buffer = await bulkImportService.getImportTemplate();
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="accounts-import-template.xlsx"',
      );
      return res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Employee Profile Data (for admin view) =====

router.get("/admin/employees/:id/profile-data", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prisma } = require("@dashmani/db");
    const profile = await prisma.employeeProfile.findUnique({ where: { userId: req.params.id } });
    return success(res, profile);
  } catch (err) { next(err); }
});

// ===== Documents by Employee =====

router.get("/admin/documents", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prisma } = require("@dashmani/db");
    const where: any = {};
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    const docs = await prisma.employeeDocument.findMany({ where, orderBy: { createdAt: "desc" }, include: { employee: { select: { id: true, name: true } } } });
    return success(res, docs);
  } catch (err) { next(err); }
});

// ===== Extra Work Hours =====

router.get("/admin/extra-hours/pending", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await extraWorkService.getPendingExtraHours()); } catch (err) { next(err); }
});

router.get("/admin/extra-hours", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { employeeId, year } = req.query as any;
    return success(res, await extraWorkService.getEmployeeExtraHours(employeeId, year ? parseInt(year) : undefined));
  } catch (err) { next(err); }
});

router.post("/admin/extra-hours/:id/approve", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await extraWorkService.approveExtraHours(req.params.id, (req as any).user.userId)); } catch (err) { next(err); }
});

router.post("/admin/extra-hours/:id/reject", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await extraWorkService.rejectExtraHours(req.params.id, (req as any).user.userId)); } catch (err) { next(err); }
});

// ===== Incentives =====

router.post("/admin/incentives", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await incentiveService.createIncentive({ ...req.body, awardedBy: (req as any).user.userId }), undefined, 201);
  } catch (err) { next(err); }
});

router.get("/admin/incentives", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { employeeId, year } = req.query as any;
    return success(res, await incentiveService.getAllIncentives({ employeeId, year: year ? parseInt(year) : undefined }));
  } catch (err) { next(err); }
});

// ===== Performance Reviews =====

router.post("/admin/performance-reviews", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await reviewService.createReview({ ...req.body, reviewerId: (req as any).user.userId }), undefined, 201);
  } catch (err) { next(err); }
});

router.get("/admin/performance-reviews", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { employeeId } = req.query as any;
    return success(res, await reviewService.getAllReviews({ employeeId }));
  } catch (err) { next(err); }
});

router.get("/admin/performance-reviews/:id", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await reviewService.getReviewById(req.params.id)); } catch (err) { next(err); }
});

// ===== Bug Reports =====

router.get("/admin/bug-reports", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, severity } = req.query as any;
    return success(res, await bugReportService.getBugReports({ status, severity }));
  } catch (err) { next(err); }
});

router.post("/admin/bug-reports/:id/status", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await bugReportService.updateBugStatus(req.params.id, req.body)); } catch (err) { next(err); }
});

router.get("/admin/bug-reports/:id", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await bugReportService.getBugReportById(req.params.id)); } catch (err) { next(err); }
});

// ===== Job Listings =====

router.post("/admin/jobs", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await jobListingService.createJobListing({ ...req.body, createdBy: (req as any).user.userId }), undefined, 201);
  } catch (err) { next(err); }
});

router.put("/admin/jobs/:id", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await jobListingService.updateJobListing(req.params.id, req.body)); } catch (err) { next(err); }
});

router.get("/admin/jobs", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query as any;
    return success(res, await jobListingService.getJobListings({ status }));
  } catch (err) { next(err); }
});

router.get("/admin/jobs/:id", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await jobListingService.getJobListingById(req.params.id)); } catch (err) { next(err); }
});

// ===== Job Applications =====

router.get("/admin/applications", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobId, status } = req.query as any;
    return success(res, await jobListingService.getApplications({ jobId, status }));
  } catch (err) { next(err); }
});

router.get("/admin/applications/:id", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await jobListingService.getApplicationById(req.params.id)); } catch (err) { next(err); }
});

router.post("/admin/applications/:id/status", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await jobListingService.updateApplicationStatus(req.params.id, { ...req.body, reviewedBy: (req as any).user.userId }));
  } catch (err) { next(err); }
});

router.put("/admin/applications/:id/notes", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    return success(res, await jobListingService.updateApplicationNotes(req.params.id, req.body.notes, (req as any).user.userId));
  } catch (err) { next(err); }
});

router.delete("/admin/jobs/:id", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await jobListingService.deleteJobListing(req.params.id)); } catch (err) { next(err); }
});

// ===== Admin Update Job Description =====

router.put("/admin/employees/:id/job-description", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prisma } = require("@dashmani/db");
    const profile = await prisma.employeeProfile.upsert({
      where: { userId: req.params.id },
      update: { jobDescription: req.body.jobDescription },
      create: { userId: req.params.id, jobDescription: req.body.jobDescription },
    });
    return success(res, profile);
  } catch (err) { next(err); }
});

// ===== AI Assistant =====

router.post("/admin/ai/generate-job", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await aiService.generateJobDescription(req.body)); } catch (err) { next(err); }
});

router.post("/admin/ai/generate-offer-letter", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await aiService.generateOfferLetterContent(req.body)); } catch (err) { next(err); }
});

router.post("/admin/ai/generate-appointment-letter", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await aiService.generateAppointmentLetter(req.body)); } catch (err) { next(err); }
});

router.post("/admin/ai/generate-contract", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await aiService.generateContractContent(req.body)); } catch (err) { next(err); }
});

router.get("/admin/ai/salary-slip/:id/html", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const html = await aiService.generateSalarySlipHtml(req.params.id);
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  } catch (err) { next(err); }
});

router.post("/admin/ai/assist", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try { return success(res, await aiService.aiAssist(req.body)); } catch (err) { next(err); }
});

// ===== Expense Claims (Admin) =====

router.get("/admin/expenses", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, employeeId } = req.query as { status?: string; employeeId?: string };
    const where: any = {};
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;
    const expenses = await prisma.expenseClaim.findMany({
      where,
      include: { employee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
    return success(res, expenses);
  } catch (err) { next(err); }
});

router.post("/admin/expenses/:id/approve", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const expense = await prisma.expenseClaim.update({
      where: { id: req.params.id },
      data: { status: "APPROVED", reviewedBy: (req as any).user.userId, reviewedAt: new Date() },
      include: { employee: { select: { name: true, email: true } } },
    });
    if ((expense as any).employee?.email) {
      sendEmail({ to: (expense as any).employee.email, subject: `[Digital Sukoon] Expense claim approved — ₹${expense.amount}`, html: `<p>Hi ${(expense as any).employee.name},</p><p>Your expense claim "<strong>${expense.title}</strong>" of ₹${expense.amount} has been <strong>approved</strong>.</p><p>— Digital Sukoon HR</p>` }).catch(() => {});
    }
    return success(res, expense);
  } catch (err) { next(err); }
});

router.post("/admin/expenses/:id/reject", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const expense = await prisma.expenseClaim.update({
      where: { id: req.params.id },
      data: { status: "REJECTED", reviewedBy: (req as any).user.userId, reviewedAt: new Date(), reviewNotes: req.body.reason },
      include: { employee: { select: { name: true, email: true } } },
    });
    if ((expense as any).employee?.email) {
      sendEmail({ to: (expense as any).employee.email, subject: `[Digital Sukoon] Expense claim rejected`, html: `<p>Hi ${(expense as any).employee.name},</p><p>Your expense claim "<strong>${expense.title}</strong>" has been <strong>rejected</strong>. ${req.body.reason ? `Reason: ${req.body.reason}` : "Please contact HR for details."}</p><p>— Digital Sukoon HR</p>` }).catch(() => {});
    }
    return success(res, expense);
  } catch (err) { next(err); }
});

// ===== Auto-Teams (employees sharing accounts) =====

router.get("/admin/auto-teams", authenticate, requirePermission("accounts", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Find all accounts that have 2+ active assignees
    const accounts = await prisma.socialAccount.findMany({
      where: {
        assignments: { some: { unassignedAt: null } },
      },
      include: {
        platform: { select: { id: true, name: true, slug: true } },
        assignments: {
          where: { unassignedAt: null },
          include: { employee: { select: { id: true, name: true, email: true, profileImageUrl: true, orgUnit: { select: { id: true, name: true } } } } },
        },
      },
    });

    // Filter to accounts with 2+ assignees and group
    const sharedAccounts = accounts
      .filter((a) => a.assignments.length >= 2)
      .map((a) => ({
        accountId: a.id,
        handle: a.handle,
        displayName: a.displayName,
        platform: a.platform.name,
        platformSlug: a.platform.slug,
        clientName: a.clientName,
        followerCount: a.followerCount,
        members: a.assignments.map((asn) => ({
          id: asn.employee.id,
          name: asn.employee.name,
          email: asn.employee.email,
          profileImageUrl: asn.employee.profileImageUrl,
          currentTeam: asn.employee.orgUnit?.name || null,
          assignedAt: asn.assignedAt,
        })),
      }));

    return success(res, sharedAccounts);
  } catch (err) { next(err); }
});

// POST /admin/auto-teams/create — create a team from shared account members
router.post("/admin/auto-teams/create", authenticate, requirePermission("teams", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, accountId, memberIds } = req.body;
    if (!name || !memberIds || memberIds.length === 0) {
      return res.status(400).json({ error: "Team name and member IDs are required" });
    }
    // Create the team (OrgUnit)
    const team = await prisma.orgUnit.create({
      data: { name, type: "TEAM" },
    });
    // Assign members to the team
    await prisma.user.updateMany({
      where: { id: { in: memberIds } },
      data: { orgUnitId: team.id },
    });
    return success(res, { team, membersAssigned: memberIds.length }, undefined, 201);
  } catch (err) { next(err); }
});

// ===== Assigned Devices =====

router.get("/admin/devices", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { employeeId, type } = req.query as { employeeId?: string; type?: string };
    const where: any = { returnedAt: null };
    if (employeeId) where.employeeId = employeeId;
    if (type) where.type = type;
    const devices = await prisma.assignedDevice.findMany({
      where,
      include: { employee: { select: { id: true, name: true, email: true, profileImageUrl: true } } },
      orderBy: { assignedAt: "desc" },
    });
    return success(res, devices);
  } catch (err) { next(err); }
});

router.get("/admin/devices/all", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const devices = await prisma.assignedDevice.findMany({
      include: { employee: { select: { id: true, name: true, email: true } } },
      orderBy: { assignedAt: "desc" },
    });
    return success(res, devices);
  } catch (err) { next(err); }
});

router.post("/admin/devices", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const device = await prisma.assignedDevice.create({
      data: {
        employeeId: req.body.employeeId,
        type: req.body.type,
        brand: req.body.brand,
        model: req.body.model,
        serialNumber: req.body.serialNumber,
        assetTag: req.body.assetTag,
        condition: req.body.condition || "Good",
        notes: req.body.notes,
      },
      include: { employee: { select: { id: true, name: true } } },
    });
    notifyAdminByEmail("Device Assigned", [
      { label: "Employee", value: (device as any).employee.name },
      { label: "Device", value: `${device.brand} ${device.model}` },
      { label: "Type", value: device.type },
      { label: "Serial", value: device.serialNumber || "—" },
    ]).catch(() => {});
    return success(res, device, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/admin/devices/:id", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const device = await prisma.assignedDevice.update({
      where: { id: req.params.id },
      data: {
        type: req.body.type,
        brand: req.body.brand,
        model: req.body.model,
        serialNumber: req.body.serialNumber,
        assetTag: req.body.assetTag,
        condition: req.body.condition,
        notes: req.body.notes,
      },
    });
    return success(res, device);
  } catch (err) { next(err); }
});

// Mark device as returned
router.post("/admin/devices/:id/return", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const device = await prisma.assignedDevice.update({
      where: { id: req.params.id },
      data: { returnedAt: new Date() },
      include: { employee: { select: { name: true } } },
    });
    return success(res, device);
  } catch (err) { next(err); }
});

router.delete("/admin/devices/:id", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.assignedDevice.delete({ where: { id: req.params.id } });
    return success(res, { message: "Device record deleted" });
  } catch (err) { next(err); }
});

// ===== Complaints (Admin) =====

router.get("/admin/complaints", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query as { status?: string };
    const where: any = {};
    if (status) where.status = status;
    const complaints = await prisma.complaint.findMany({
      where,
      include: { employee: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });
    return success(res, complaints);
  } catch (err) { next(err); }
});

router.post("/admin/complaints/:id/respond", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { response, status } = req.body;
    const complaint = await prisma.complaint.update({
      where: { id: req.params.id },
      data: {
        adminResponse: response,
        status: status || "RESOLVED",
        resolvedAt: status === "RESOLVED" || status === "CLOSED" ? new Date() : undefined,
      },
      include: { employee: { select: { name: true, email: true } } },
    });
    if ((complaint as any).employee?.email) {
      sendEmail({ to: (complaint as any).employee.email, subject: `[Digital Sukoon] Update on your complaint: ${complaint.subject}`, html: `<p>Hi ${(complaint as any).employee.name},</p><p>Your complaint "<strong>${complaint.subject}</strong>" has been updated to <strong>${complaint.status}</strong>.</p>${response ? `<p>Response: ${response}</p>` : ""}<p>— Digital Sukoon HR</p>` }).catch(() => {});
    }
    return success(res, complaint);
  } catch (err) { next(err); }
});

// ===== Joining Date Approval =====

router.get("/admin/joining-dates", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profiles = await prisma.employeeProfile.findMany({
      where: { joiningDate: { not: null } },
      include: { user: { select: { id: true, name: true, email: true, status: true } } },
      orderBy: { joiningDate: "desc" },
    });
    return success(res, profiles);
  } catch (err) { next(err); }
});

router.post("/admin/joining-dates/:userId/approve", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await prisma.employeeProfile.update({
      where: { userId: req.params.userId },
      data: { joiningDateApproved: true },
    });
    return success(res, profile);
  } catch (err) { next(err); }
});

router.put("/admin/joining-dates/:userId", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await prisma.employeeProfile.upsert({
      where: { userId: req.params.userId },
      update: { joiningDate: new Date(req.body.joiningDate), joiningDateApproved: true },
      create: { userId: req.params.userId, joiningDate: new Date(req.body.joiningDate), joiningDateApproved: true },
    });
    return success(res, profile);
  } catch (err) { next(err); }
});

// ===== Daily POA (Admin view) =====

router.get("/admin/poa", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { employeeId, date } = req.query as { employeeId?: string; date?: string };
    const where: any = {};
    if (employeeId) where.employeeId = employeeId;
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      where.date = d;
    }
    const poas = await prisma.dailyPOA.findMany({
      where,
      include: { employee: { select: { id: true, name: true, email: true } } },
      orderBy: { date: "desc" },
      take: 100,
    });
    return success(res, poas);
  } catch (err) { next(err); }
});

// ===== Internship Applications =====

router.get("/admin/internships", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query as { status?: string };
    const where: any = {};
    if (status) where.status = status;
    const apps = await prisma.internshipApplication.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    return success(res, apps);
  } catch (err) { next(err); }
});

router.get("/admin/internships/:id", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const app = await prisma.internshipApplication.findUnique({ where: { id: req.params.id } });
    return success(res, app);
  } catch (err) { next(err); }
});

router.post("/admin/internships/:id/status", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, reviewNotes } = req.body;
    const app = await prisma.internshipApplication.update({
      where: { id: req.params.id },
      data: { status, reviewNotes, reviewedBy: (req as any).user.userId },
    });
    if (app.email) {
      const statusMessages: Record<string, string> = {
        SHORTLISTED: "You have been shortlisted! We will contact you for the next steps.",
        INTERVIEW: "We would like to schedule an interview with you. Our team will reach out shortly.",
        OFFERED: "Congratulations! We are pleased to offer you the internship position.",
        REJECTED: "Thank you for your interest. Unfortunately, we cannot proceed with your application at this time.",
      };
      if (statusMessages[status]) {
        sendEmail({ to: app.email, subject: `[Digital Sukoon] Internship Application Update`, html: `<p>Hi ${app.name},</p><p>${statusMessages[status]}</p><p>— Digital Sukoon HR Team</p>` }).catch(() => {});
      }
    }
    return success(res, app);
  } catch (err) { next(err); }
});

router.delete("/admin/internships/:id", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.internshipApplication.delete({ where: { id: req.params.id } });
    return success(res, { message: "Deleted" });
  } catch (err) { next(err); }
});

// ===== Admin User Management =====

// POST /admin/users/create — directly create a new internal admin user (Super Admin only)
router.post("/admin/users/create", authenticate, requirePermission("employees", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, password, roleIds, designation, salary } = req.body;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : req.body.email;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "name, email, and password are required" } });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, error: { code: "CONFLICT", message: "A user with this email already exists" } });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        status: "ACTIVE",
      },
    });

    if (roleIds && Array.isArray(roleIds) && roleIds.length > 0) {
      await prisma.userRole.createMany({
        data: roleIds.map((roleId: string) => ({ userId: user.id, roleId })),
        skipDuplicates: true,
      });
    }

    if (designation || salary != null) {
      await prisma.employeeProfile.upsert({
        where: { userId: user.id },
        update: { ...(designation ? { designation } : {}), ...(salary != null ? { salary } : {}) },
        create: { userId: user.id, ...(designation ? { designation } : {}), ...(salary != null ? { salary } : {}) },
      });
    }

    return success(res, { id: user.id, name: user.name, email: user.email, status: user.status }, undefined, 201);
  } catch (err) { next(err); }
});

// POST /admin/users/invite — send invite email to a new admin
router.post("/admin/users/invite", authenticate, requirePermission("employees", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { roleIds, designation } = req.body;
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : req.body.email;
    if (!email) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "email is required" } });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // If a user already exists from HR self-registration (ONBOARDING), the admin's
      // "invite" intent is really "approve + assign roles" — do that instead of 409,
      // otherwise the user is locked out (registered but can't sign in, and admin can't
      // re-invite them).
      if (existing.status === "ONBOARDING" && !existing.deletedAt) {
        if (Array.isArray(roleIds) && roleIds.length > 0) {
          await prisma.userRole.createMany({
            data: roleIds.map((roleId: string) => ({ userId: existing.id, roleId })),
            skipDuplicates: true,
          });
        }
        if (designation) {
          await prisma.employeeProfile.upsert({
            where: { userId: existing.id },
            update: { designation },
            create: { userId: existing.id, designation },
          });
        }
        await prisma.user.update({ where: { id: existing.id }, data: { status: "ACTIVE" } });
        return success(res, { message: "Existing pending account approved and activated", email, approvedExistingUserId: existing.id }, undefined, 200);
      }
      return res.status(409).json({ success: false, error: { code: "CONFLICT", message: "A user with this email already exists" } });
    }

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invite = await prisma.adminInvite.upsert({
      where: { email },
      update: { token: crypto.randomUUID(), expiresAt, usedAt: null, roleIds: roleIds || [], designation: designation || null },
      create: { email, roleIds: roleIds || [], designation: designation || null, expiresAt },
    });

    const inviteUrl = `${process.env.INTERNAL_APP_URL || "http://localhost:3000"}/admin-signup?token=${invite.token}`;
    await sendEmail({
      to: email,
      subject: "[Digital Sukoon] You've been invited to the Management Portal",
      html: `<p>Hi,</p><p>You've been invited to join the Digital Sukoon Management Portal.</p><p>Complete your registration here: <a href="${inviteUrl}">${inviteUrl}</a></p><p>This link expires in 7 days.</p><p>— Digital Sukoon Admin</p>`,
    });

    return success(res, { message: "Invite sent", email }, undefined, 201);
  } catch (err) { next(err); }
});

// POST /admin/users/accept-invite — complete signup from invite token
router.post("/admin/users/accept-invite", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, name, password } = req.body;
    if (!token || !name || !password) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "token, name, and password are required" } });
    }

    const invite = await prisma.adminInvite.findUnique({ where: { token } });
    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      return res.status(400).json({ success: false, error: { code: "INVALID_TOKEN", message: "Invalid or expired invite link" } });
    }

    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      return res.status(409).json({ success: false, error: { code: "CONFLICT", message: "Account already exists for this email" } });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { name, email: invite.email, passwordHash, status: "ACTIVE" },
    });

    let assignedRoleIds: string[] = invite.roleIds ?? [];
    if (assignedRoleIds.length === 0) {
      const employeeRole = await prisma.role.findUnique({ where: { name: "Employee" } });
      if (employeeRole) assignedRoleIds = [employeeRole.id];
    }
    if (assignedRoleIds.length > 0) {
      await prisma.userRole.createMany({
        data: assignedRoleIds.map((roleId: string) => ({ userId: user.id, roleId })),
        skipDuplicates: true,
      });
    }

    if (invite.designation) {
      await prisma.employeeProfile.create({ data: { userId: user.id, designation: invite.designation } });
    }

    await prisma.adminInvite.update({ where: { id: invite.id }, data: { usedAt: new Date() } });

    const roleNames = (await prisma.role.findMany({ where: { id: { in: assignedRoleIds } } })).map((r) => r.name);

    const payload = { userId: user.id, email: user.email, roles: roleNames, type: "employee" as const };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken({ userId: user.id });
    const hashedToken = crypto.createHash("sha256").update(refreshToken).digest("hex");
    await prisma.refreshToken.create({
      data: { userId: user.id, token: hashedToken, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });

    return success(res, {
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, roles: roleNames },
    });
  } catch (err) { next(err); }
});

// GET /admin/users/invite/:token — validate an invite token (public, for the signup page)
router.get("/admin/users/invite/:token", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invite = await prisma.adminInvite.findUnique({ where: { token: req.params.token } });
    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      return res.status(400).json({ success: false, error: { code: "INVALID_TOKEN", message: "Invalid or expired invite link" } });
    }
    return success(res, { email: invite.email, valid: true });
  } catch (err) { next(err); }
});

// ===== User & Client Deletion (Super Admin / Admin only) =====

function requireAdminRole(req: Request, res: Response, next: NextFunction) {
  const roles: string[] = (req.user as any)?.roles ?? [];
  const normalized = roles.map((r) => r.toLowerCase());
  if (normalized.includes("super admin") || normalized.includes("admin")) return next();
  return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Only admins can delete users" } });
}

// PUT /admin/users/:id/roles — replace a user's roles entirely (idempotent)
router.put("/admin/users/:id/roles", authenticate, requireAdminRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { roleIds } = req.body as { roleIds: string[] };
    if (!Array.isArray(roleIds)) return res.status(400).json({ success: false, error: { message: "roleIds must be an array" } });
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!user) return res.status(404).json({ success: false, error: { message: "User not found" } });

    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: req.params.id } }),
      ...(roleIds.length > 0
        ? [prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: req.params.id, roleId })), skipDuplicates: true })]
        : []),
    ]);

    const updated = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { roles: { include: { role: true } } },
    });
    return success(res, updated);
  } catch (err) { next(err); }
});

// DELETE /admin/users/:id — soft-delete an internal employee/admin user
router.delete("/admin/users/:id", authenticate, requireAdminRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, roles: { include: { role: true } } } });
    if (!target) return res.status(404).json({ success: false, error: { message: "User not found" } });

    // Prevent non-super-admins from deleting super admins
    const callerRoles: string[] = ((req.user as any)?.roles ?? []).map((r: string) => r.toLowerCase());
    const isSuperAdmin = callerRoles.includes("super admin");
    const targetRoleNames = target.roles.map((ur) => ur.role.name.toLowerCase());
    if (targetRoleNames.includes("super admin") && !isSuperAdmin) {
      return res.status(403).json({ success: false, error: { message: "Only Super Admins can delete other Super Admins" } });
    }
    // Prevent self-deletion
    if (target.id === (req.user as any)?.userId) {
      return res.status(400).json({ success: false, error: { message: "You cannot delete your own account" } });
    }

    await prisma.user.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), status: "INACTIVE" } });
    return success(res, { message: "User deleted" });
  } catch (err) { next(err); }
});

// DELETE /admin/clients/:id — delete a client account
router.delete("/admin/clients/:id", authenticate, requireAdminRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!client) return res.status(404).json({ success: false, error: { message: "Client not found" } });
    await prisma.client.delete({ where: { id: req.params.id } });
    return success(res, { message: "Client deleted" });
  } catch (err) { next(err); }
});

// ===== Bulk Approval Actions =====

// POST /admin/documents/bulk-review
router.post("/admin/documents/bulk-review", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids, action, note } = req.body as { ids: string[]; action: "APPROVE" | "REJECT"; note?: string };
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: { message: "ids must be a non-empty array" } });
    if (action !== "APPROVE" && action !== "REJECT") return res.status(400).json({ success: false, error: { message: "action must be APPROVE or REJECT" } });
    const status = action === "APPROVE" ? "APPROVED" : "REJECTED";
    const userId = (req as any).user.userId;
    const results = await Promise.allSettled(ids.map((id) => documentService.reviewDocument(id, userId, status, note)));
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return success(res, { succeeded, failed: ids.length - succeeded });
  } catch (err) { next(err); }
});

// POST /admin/profile-pictures/bulk-review
router.post("/admin/profile-pictures/bulk-review", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids, action } = req.body as { ids: string[]; action: "APPROVE" | "REJECT" };
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: { message: "ids must be a non-empty array" } });
    if (action !== "APPROVE" && action !== "REJECT") return res.status(400).json({ success: false, error: { message: "action must be APPROVE or REJECT" } });
    const userId = (req as any).user.userId;
    const fn = action === "APPROVE" ? profilePicService.approveProfilePicture : profilePicService.rejectProfilePicture;
    const results = await Promise.allSettled(ids.map((id) => fn(id, userId)));
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return success(res, { succeeded, failed: ids.length - succeeded });
  } catch (err) { next(err); }
});

// POST /admin/leave-requests/bulk
router.post("/admin/leave-requests/bulk", authenticate, requirePermission("employees", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids, action } = req.body as { ids: string[]; action: "APPROVE" | "REJECT"; note?: string };
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: { message: "ids must be a non-empty array" } });
    if (action !== "APPROVE" && action !== "REJECT") return res.status(400).json({ success: false, error: { message: "action must be APPROVE or REJECT" } });
    const userId = (req as any).user.userId;
    const fn = action === "APPROVE" ? leaveService.approveLeaveRequest : leaveService.rejectLeaveRequest;
    const results = await Promise.allSettled(ids.map((id) => fn(id, userId)));
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    return success(res, { succeeded, failed: ids.length - succeeded });
  } catch (err) { next(err); }
});

// ===== Announcements =====

// POST /admin/announcements — broadcast a message to all active employees
router.post("/admin/announcements", authenticate, requireAdminRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, message } = req.body as { title?: string; message?: string };
    if (!title?.trim() || !message?.trim()) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "title and message are required" } });
    }
    if (title.trim().length > 120) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "title must be 120 characters or fewer" } });
    }
    if (message.trim().length > 2000) {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "message must be 2000 characters or fewer" } });
    }
    const result = await announcementService.broadcastAnnouncement(
      (req as any).user.userId,
      title.trim(),
      message.trim()
    );
    return success(res, result, undefined, 201);
  } catch (err) { next(err); }
});

// GET /admin/announcements — paginated history of sent announcements
router.get("/admin/announcements", authenticate, requireAdminRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(String(req.query.page ?? "1")) || 1;
    const limit = parseInt(String(req.query.limit ?? "20")) || 20;
    const result = await announcementService.getAnnouncements(page, limit);
    return success(res, result);
  } catch (err) { next(err); }
});

export default router;
