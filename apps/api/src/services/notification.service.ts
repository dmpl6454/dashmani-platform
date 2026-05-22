import { prisma } from "@dashmani/db";
import type { NotificationType } from "@dashmani/db";
import { NOTIFICATION_AUDIENCE } from "./notification-routing";

/**
 * Route a notification to the correct audience(s) based on type.
 * Replaces the old notifyAdmins() pattern — use this for all new triggers.
 */
export async function dispatchNotification(opts: {
  type: NotificationType;
  title: string;
  message: string;
  recipientUserId?: string;
  metadata?: Record<string, any>;
}) {
  const audiences = NOTIFICATION_AUDIENCE[opts.type] ?? ["ADMINS"];
  const userIds = new Set<string>();

  if (audiences.includes("ADMINS")) {
    const admins = await prisma.user.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        roles: { some: { role: { name: { in: ["Super Admin", "Admin"] } } } },
      },
      select: { id: true },
    });
    admins.forEach((a) => userIds.add(a.id));
  }

  if (audiences.includes("RECIPIENT") && opts.recipientUserId) {
    userIds.add(opts.recipientUserId);
  }

  // ALL_EMPLOYEES is handled by announcement.service.ts directly — skip here.

  if (userIds.size === 0) return;

  await prisma.notification.createMany({
    data: Array.from(userIds).map((userId) => ({
      userId,
      type: opts.type,
      title: opts.title,
      message: opts.message,
      metadata: opts.metadata ?? {},
    })),
  });
}

export async function createNotification(
  userId: string,
  type: string,
  title: string,
  message: string,
  metadata?: any
) {
  return prisma.notification.create({
    data: { userId, type: type as any, title, message, metadata },
  });
}

/**
 * @deprecated Use dispatchNotification() instead. This remains as a fallback for any caller not yet migrated.
 */
export async function notifyAdmins(
  type: string,
  title: string,
  message: string,
  metadata?: any
) {
  const admins = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      roles: { some: { role: { name: { in: ["Super Admin", "Admin", "super-admin", "admin"] } } } },
    },
    select: { id: true },
  });

  if (admins.length === 0) return [];

  await prisma.notification.createMany({
    data: admins.map((admin) => ({
      userId: admin.id,
      type: type as any,
      title,
      message,
      metadata: metadata ?? undefined,
    })),
  });

  return admins.map((a) => a.id);
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
