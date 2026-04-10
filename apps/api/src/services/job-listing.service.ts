import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function createJobListing(data: {
  title: string;
  department?: string;
  location?: string;
  type?: "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERNSHIP" | "FREELANCE";
  experience?: string;
  salary?: string;
  description: string;
  requirements?: string;
  responsibilities?: string;
  benefits?: string;
  createdBy: string;
}) {
  return prisma.jobListing.create({ data });
}

export async function updateJobListing(id: string, data: any) {
  const job = await prisma.jobListing.findUnique({ where: { id } });
  if (!job) throw new AppError(404, "NOT_FOUND", "Job listing not found");
  return prisma.jobListing.update({ where: { id }, data });
}

export async function getJobListings(filters?: { status?: string }) {
  const where: any = {};
  if (filters?.status) where.status = filters.status;
  return prisma.jobListing.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { applications: true } } },
  });
}

export async function getActiveJobListings() {
  return prisma.jobListing.findMany({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
}

export async function getJobListingById(id: string) {
  return prisma.jobListing.findUnique({
    where: { id },
    include: { _count: { select: { applications: true } } },
  });
}

export async function submitApplication(data: {
  jobId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone?: string;
  resumeUrl?: string;
  coverLetter?: string;
  experience?: string;
  currentCompany?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
}) {
  const job = await prisma.jobListing.findUnique({ where: { id: data.jobId } });
  if (!job || job.status !== "ACTIVE") {
    throw new AppError(400, "JOB_NOT_AVAILABLE", "This job listing is not active");
  }
  return prisma.jobApplication.create({ data });
}

export async function getApplications(filters?: { jobId?: string; status?: string }) {
  const where: any = {};
  if (filters?.jobId) where.jobId = filters.jobId;
  if (filters?.status) where.status = filters.status;
  return prisma.jobApplication.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { job: { select: { title: true, department: true } } },
  });
}

export async function getApplicationById(id: string) {
  const app = await prisma.jobApplication.findUnique({
    where: { id },
    include: { job: true },
  });
  if (!app) throw new AppError(404, "NOT_FOUND", "Application not found");
  return app;
}

export async function updateApplicationNotes(id: string, notes: string, reviewedBy: string) {
  const app = await prisma.jobApplication.findUnique({ where: { id } });
  if (!app) throw new AppError(404, "NOT_FOUND", "Application not found");
  return prisma.jobApplication.update({
    where: { id },
    data: { notes, reviewedBy },
    include: { job: { select: { title: true } } },
  });
}

export async function deleteJobListing(id: string) {
  const job = await prisma.jobListing.findUnique({ where: { id }, include: { _count: { select: { applications: true } } } });
  if (!job) throw new AppError(404, "NOT_FOUND", "Job listing not found");
  if (job._count.applications > 0) {
    throw new AppError(400, "HAS_APPLICATIONS", "Cannot delete job with existing applications. Close it instead.");
  }
  return prisma.jobListing.delete({ where: { id } });
}

export async function updateApplicationStatus(id: string, data: {
  status: string;
  notes?: string;
  reviewedBy?: string;
}) {
  const app = await prisma.jobApplication.findUnique({ where: { id } });
  if (!app) throw new AppError(404, "NOT_FOUND", "Application not found");
  return prisma.jobApplication.update({
    where: { id },
    data: { status: data.status as any, notes: data.notes, reviewedBy: data.reviewedBy },
    include: { job: { select: { title: true } } },
  });
}
