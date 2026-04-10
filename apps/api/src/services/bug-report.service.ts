import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function createBugReport(data: {
  reportedBy: string;
  title: string;
  description: string;
  page?: string;
  severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  screenshot?: string;
}) {
  return prisma.bugReport.create({
    data: {
      reportedBy: data.reportedBy,
      title: data.title,
      description: data.description,
      page: data.page,
      severity: data.severity || "MEDIUM",
      screenshot: data.screenshot,
      status: "OPEN",
    },
    include: {
      reporter: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getBugReports(filters?: {
  status?: string;
  severity?: string;
  reportedBy?: string;
}) {
  const where: any = {};
  if (filters?.status) where.status = filters.status;
  if (filters?.severity) where.severity = filters.severity;
  if (filters?.reportedBy) where.reportedBy = filters.reportedBy;

  return prisma.bugReport.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      reporter: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getMyBugReports(userId: string) {
  return prisma.bugReport.findMany({
    where: { reportedBy: userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateBugStatus(id: string, data: {
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED" | "WONT_FIX";
  resolution?: string;
}) {
  const bug = await prisma.bugReport.findUnique({ where: { id } });
  if (!bug) throw new AppError(404, "NOT_FOUND", "Bug report not found");

  const updateData: any = { status: data.status };
  if (data.resolution) updateData.resolution = data.resolution;
  if (data.status === "RESOLVED" || data.status === "CLOSED") {
    updateData.resolvedAt = new Date();
  }

  const updated = await prisma.bugReport.update({
    where: { id },
    data: updateData,
    include: { reporter: { select: { id: true, name: true } } },
  });

  // Notify reporter
  await prisma.notification.create({
    data: {
      userId: bug.reportedBy,
      type: "BUG_REPORT_UPDATE",
      title: `Bug Report Updated: ${bug.title}`,
      message: `Your bug report has been updated to "${data.status}"${data.resolution ? ` - ${data.resolution}` : ""}`,
      metadata: { bugId: id, status: data.status },
    },
  });

  return updated;
}

export async function getBugReportById(id: string) {
  return prisma.bugReport.findUnique({
    where: { id },
    include: {
      reporter: { select: { id: true, name: true, email: true } },
    },
  });
}
