import { Router, Request, Response, NextFunction } from "express";
import { success } from "../utils/response";
import * as jobListingService from "../services/job-listing.service";
import { uploadDocument, toUploadUrl } from "../middleware/upload";
import { sendApplicationNotification, sendEmail, notifyHrByEmail } from "../services/email.service";
import { notifyAdmins } from "../services/notification.service";
import { prisma } from "@dashmani/db";

const router = Router();

// GET /jobs — list active job listings (public)
router.get("/jobs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobs = await jobListingService.getActiveJobListings();
    return success(res, jobs);
  } catch (err) {
    next(err);
  }
});

// GET /jobs/:id — get a single job listing (public)
router.get("/jobs/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await jobListingService.getPublicJobListingById(req.params.id);
    if (!job || job.status !== "ACTIVE") {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Job not found" } });
    }
    return success(res, job);
  } catch (err) {
    next(err);
  }
});

// POST /jobs/:id/apply — submit a job application (public)
router.post(
  "/jobs/:id/apply",
  uploadDocument.single("resume"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resumeUrl = req.file ? toUploadUrl(req.file.path) : undefined;
      const application = await jobListingService.submitApplication({
        jobId: req.params.id,
        applicantName: req.body.applicantName,
        applicantEmail: req.body.applicantEmail,
        applicantPhone: req.body.applicantPhone,
        resumeUrl,
        coverLetter: req.body.coverLetter,
        experience: req.body.experience,
        currentCompany: req.body.currentCompany,
        linkedinUrl: req.body.linkedinUrl,
        portfolioUrl: req.body.portfolioUrl,
      });

      // Notify admins about new application (fire and forget)
      const job = await jobListingService.getJobListingById(req.params.id);
      notifyAdmins(
        "GENERAL",
        "New Job Application",
        `${req.body.applicantName} applied for ${job?.title || "a position"}`,
        { applicationId: application.id, jobId: req.params.id, applicantName: req.body.applicantName, applicantEmail: req.body.applicantEmail }
      ).catch((err) => console.error("Admin notification failed:", err));

      // Send email notifications (don't await — fire and forget)
      sendApplicationNotification({
        applicantName: req.body.applicantName,
        applicantEmail: req.body.applicantEmail,
        applicantPhone: req.body.applicantPhone,
        experience: req.body.experience,
        currentCompany: req.body.currentCompany,
        linkedinUrl: req.body.linkedinUrl,
        portfolioUrl: req.body.portfolioUrl,
        coverLetter: req.body.coverLetter,
        resumeUrl,
        jobTitle: job?.title || "Unknown Position",
        jobDepartment: job?.department || undefined,
      }).catch((err) => console.error("Email notification failed:", err));

      return success(res, application, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// POST /internship/apply — public internship application
router.post(
  "/internship/apply",
  uploadDocument.single("resume"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, email, phone, college, course, startDate, duration, department, skills, portfolio, linkedin, coverLetter } = req.body;
      if (!name || !email) return res.status(400).json({ success: false, error: { message: "Name and email are required" } });

      const app = await prisma.internshipApplication.create({
        data: {
          name, email, phone, college, course,
          startDate: startDate ? new Date(startDate) : null,
          duration: duration || "6 months",
          department, skills, portfolio, linkedin, coverLetter,
          resumeUrl: req.file ? toUploadUrl(req.file.path) : null,
        },
      });

      // Notify HR
      notifyHrByEmail("New Internship Application", [
        { label: "Name", value: name },
        { label: "Email", value: email },
        { label: "College", value: college || "—" },
        { label: "Course", value: course || "—" },
        { label: "Duration", value: duration || "6 months" },
        { label: "Department", value: department || "—" },
      ], "/internships").catch(() => {});

      notifyAdmins("GENERAL", "New Internship Application", `${name} applied for a ${duration || "6 month"} internship${department ? ` in ${department}` : ""}`, { internshipId: app.id }).catch(() => {});

      // Confirmation email to applicant
      sendEmail({ to: email, subject: "Internship Application Received - Digital Sukoon", html: `<p>Hi ${name},</p><p>Thank you for applying for the internship at Digital Sukoon. We have received your application and will review it shortly.</p><p>— Digital Sukoon HR Team</p>` }).catch(() => {});

      return success(res, app, undefined, 201);
    } catch (err) { next(err); }
  },
);

export default router;
