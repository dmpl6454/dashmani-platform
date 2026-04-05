import { prisma } from "@dashmani/db";

export async function createNotification(
  userId: string,
  type: "REPORT_REMINDER" | "REPORT_SUBMITTED" | "REPORT_MISSED" | "GROWTH_MILESTONE" | "ACCOUNT_ASSIGNED" | "GENERAL",
  title: string,
  message: string,
  metadata?: any
) {
  return prisma.notification.create({
    data: { userId, type, title, message, metadata },
  });
}

export async function getUserNotifications(userId: string, unreadOnly: boolean = false) {
  return prisma.notification.findMany({
    where: { userId, ...(unreadOnly ? { read: false } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getUnreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, read: false } });
}

export async function markAsRead(notificationId: string, userId: string) {
  return prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { read: true },
  });
}

export async function markAllAsRead(userId: string) {
  return prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

export async function sendReportReminders() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const employeesWithAssignments = await prisma.accountAssignment.findMany({
    where: { unassignedAt: null },
    select: { employeeId: true },
    distinct: ["employeeId"],
  });
  const employeeIds = employeesWithAssignments.map((e) => e.employeeId);

  const submittedToday = await prisma.dailyReport.findMany({
    where: { date: today, employeeId: { in: employeeIds } },
    select: { employeeId: true },
  });
  const submittedIds = new Set(submittedToday.map((r) => r.employeeId));
  const missingIds = employeeIds.filter((id) => !submittedIds.has(id));

  if (missingIds.length > 0) {
    await prisma.notification.createMany({
      data: missingIds.map((userId) => ({
        userId,
        type: "REPORT_REMINDER" as const,
        title: "Daily Report Reminder",
        message: "You haven't submitted today's daily report yet.",
        metadata: { date: today.toISOString().split("T")[0] },
      })),
    });
  }

  return { reminded: missingIds.length, alreadySubmitted: submittedIds.size };
}

export async function markMissedReports(date: string) {
  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);

  const employeesWithAssignments = await prisma.accountAssignment.findMany({
    where: { unassignedAt: null },
    select: { employeeId: true },
    distinct: ["employeeId"],
  });
  const employeeIds = employeesWithAssignments.map((e) => e.employeeId);

  const submitted = await prisma.dailyReport.findMany({
    where: { date: targetDate, employeeId: { in: employeeIds } },
    select: { employeeId: true },
  });
  const submittedIds = new Set(submitted.map((r) => r.employeeId));
  const missedIds = employeeIds.filter((id) => !submittedIds.has(id));

  if (missedIds.length > 0) {
    await prisma.notification.createMany({
      data: missedIds.map((userId) => ({
        userId,
        type: "REPORT_MISSED" as const,
        title: "Report Missed",
        message: `You missed submitting your daily report for ${date}.`,
        metadata: { date },
      })),
    });
  }

  return { missed: missedIds.length };
}
