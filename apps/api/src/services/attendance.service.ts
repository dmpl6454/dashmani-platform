import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function checkIn(employeeId: string, ipAddress?: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const existing = await prisma.attendance.findUnique({
    where: { employeeId_date: { employeeId, date: today } },
  });

  if (existing?.checkIn) {
    throw new AppError(400, "ALREADY_CHECKED_IN", "Already checked in today");
  }

  const now = new Date();
  // Late if after 10:00 AM (configurable later via Settings)
  const lateThreshold = new Date(today);
  lateThreshold.setHours(10, 0, 0, 0);
  const status = now > lateThreshold ? "LATE" : "PRESENT";

  if (existing) {
    return prisma.attendance.update({
      where: { id: existing.id },
      data: { checkIn: now, status, ipAddress },
    });
  }

  return prisma.attendance.create({
    data: {
      employeeId,
      date: today,
      checkIn: now,
      status,
      ipAddress,
    },
  });
}

export async function checkOut(employeeId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const record = await prisma.attendance.findUnique({
    where: { employeeId_date: { employeeId, date: today } },
  });

  if (!record?.checkIn) {
    throw new AppError(400, "NOT_CHECKED_IN", "Must check in before checking out");
  }

  if (record.checkOut) {
    throw new AppError(400, "ALREADY_CHECKED_OUT", "Already checked out today");
  }

  const now = new Date();
  const hoursWorked = (now.getTime() - record.checkIn.getTime()) / (1000 * 60 * 60);
  const overtimeHours = Math.max(0, hoursWorked - 9); // 9-hour standard day
  const status = hoursWorked < 4.5 ? "HALF_DAY" : record.status;

  return prisma.attendance.update({
    where: { id: record.id },
    data: { checkOut: now, overtimeHours, status },
  });
}

export async function getAttendanceRecords(params: {
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  cursor?: string;
  limit: number;
}) {
  const where: any = {};
  if (params.employeeId) where.employeeId = params.employeeId;
  if (params.status) where.status = params.status;
  if (params.startDate || params.endDate) {
    where.date = {};
    if (params.startDate) where.date.gte = new Date(params.startDate);
    if (params.endDate) where.date.lte = new Date(params.endDate);
  }

  const records = await prisma.attendance.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
    orderBy: { date: "desc" },
  });

  const hasMore = records.length > params.limit;
  const items = hasMore ? records.slice(0, params.limit) : records;

  return {
    items,
    meta: {
      cursor: items.length > 0 ? items[items.length - 1].id : undefined,
      has_more: hasMore,
    },
  };
}

export async function createLeaveRequest(employeeId: string, data: {
  startDate: string;
  endDate: string;
  reason: string;
  type: "CASUAL" | "SICK" | "EARNED" | "UNPAID";
}) {
  return prisma.leaveRequest.create({
    data: {
      employeeId,
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
      type: data.type,
      reason: data.reason,
    },
  });
}

export async function approveLeaveRequest(requestId: string, approverId: string, approved: boolean) {
  const leaveReq = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!leaveReq) throw new AppError(404, "NOT_FOUND", "Leave request not found");
  if (leaveReq.status !== "PENDING") throw new AppError(400, "ALREADY_PROCESSED", "Leave request already processed");

  const updated = await prisma.leaveRequest.update({
    where: { id: requestId },
    data: {
      status: approved ? "APPROVED" : "REJECTED",
      approvedBy: approverId,
      approvedAt: new Date(),
    },
  });

  // If approved, create attendance records as LEAVE for the date range
  if (approved) {
    const start = new Date(leaveReq.startDate);
    const end = new Date(leaveReq.endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const date = new Date(d);
      date.setHours(0, 0, 0, 0);
      await prisma.attendance.upsert({
        where: { employeeId_date: { employeeId: leaveReq.employeeId, date } },
        update: { status: "LEAVE" },
        create: { employeeId: leaveReq.employeeId, date, status: "LEAVE" },
      });
    }
  }

  return updated;
}
