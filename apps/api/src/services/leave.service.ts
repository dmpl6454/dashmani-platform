import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

const LEAVE_QUOTAS = {
  CASUAL: 12,
  SICK: 6,
  EARNED: 15,
} as const;

export async function createLeaveRequest(data: {
  employeeId: string;
  startDate: string;
  endDate: string;
  type: "CASUAL" | "SICK" | "EARNED" | "UNPAID" | "WFH" | "COMP_OFF";
  reason: string;
}) {
  const startDate = new Date(data.startDate);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(data.endDate);
  endDate.setHours(23, 59, 59, 999);

  if (startDate > endDate) {
    throw new AppError(400, "INVALID_DATES", "Start date must be before or equal to end date");
  }

  // Check for overlapping leave requests (excluding REJECTED ones)
  const overlapping = await prisma.leaveRequest.findFirst({
    where: {
      employeeId: data.employeeId,
      status: { not: "REJECTED" },
      OR: [
        { startDate: { lte: endDate }, endDate: { gte: startDate } },
      ],
    },
  });

  if (overlapping) {
    throw new AppError(400, "OVERLAPPING_LEAVE", "An existing leave request overlaps with the requested dates");
  }

  return prisma.leaveRequest.create({
    data: {
      employeeId: data.employeeId,
      startDate,
      endDate,
      type: data.type,
      reason: data.reason,
      status: "PENDING",
    },
  });
}

export async function getEmployeeLeaves(employeeId: string, year?: number) {
  const where: any = { employeeId };

  if (year) {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59, 999);
    where.startDate = { gte: startDate, lte: endDate };
  }

  return prisma.leaveRequest.findMany({
    where,
    orderBy: { startDate: "desc" },
  });
}

export async function getPendingLeaveRequests() {
  return prisma.leaveRequest.findMany({
    where: { status: "PENDING" },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function approveLeaveRequest(id: string, approvedBy: string) {
  const leaveReq = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leaveReq) {
    throw new AppError(404, "NOT_FOUND", "Leave request not found");
  }
  if (leaveReq.status !== "PENDING") {
    throw new AppError(400, "ALREADY_PROCESSED", "Leave request has already been processed");
  }

  return prisma.leaveRequest.update({
    where: { id },
    data: {
      status: "APPROVED",
      approvedBy,
      approvedAt: new Date(),
    },
  });
}

export async function rejectLeaveRequest(id: string, approvedBy: string) {
  const leaveReq = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leaveReq) {
    throw new AppError(404, "NOT_FOUND", "Leave request not found");
  }
  if (leaveReq.status !== "PENDING") {
    throw new AppError(400, "ALREADY_PROCESSED", "Leave request has already been processed");
  }

  return prisma.leaveRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      approvedBy,
      approvedAt: new Date(),
    },
  });
}

export async function getLeaveBalance(employeeId: string, year: number) {
  const startDate = new Date(year, 0, 1);
  const endDate = new Date(year, 11, 31, 23, 59, 59, 999);

  // Get all approved leaves for the year
  const approvedLeaves = await prisma.leaveRequest.findMany({
    where: {
      employeeId,
      status: "APPROVED",
      startDate: { gte: startDate },
      endDate: { lte: endDate },
    },
  });

  // Count used days by type
  const usedByType = { CASUAL: 0, SICK: 0, EARNED: 0, UNPAID: 0 };

  for (const leave of approvedLeaves) {
    const start = new Date(leave.startDate);
    const end = new Date(leave.endDate);
    const diffTime = end.getTime() - start.getTime();
    const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    usedByType[leave.type as keyof typeof usedByType] += days;
  }

  return {
    casual: {
      total: LEAVE_QUOTAS.CASUAL,
      used: usedByType.CASUAL,
      balance: LEAVE_QUOTAS.CASUAL - usedByType.CASUAL,
    },
    sick: {
      total: LEAVE_QUOTAS.SICK,
      used: usedByType.SICK,
      balance: LEAVE_QUOTAS.SICK - usedByType.SICK,
    },
    earned: {
      total: LEAVE_QUOTAS.EARNED,
      used: usedByType.EARNED,
      balance: LEAVE_QUOTAS.EARNED - usedByType.EARNED,
    },
    unpaid: {
      used: usedByType.UNPAID,
    },
  };
}

export async function getAllLeaveRequests(filters?: {
  status?: string;
  employeeId?: string;
  startDate?: string;
  endDate?: string;
}) {
  const where: any = {};

  if (filters?.status) {
    where.status = filters.status;
  }
  if (filters?.employeeId) {
    where.employeeId = filters.employeeId;
  }
  if (filters?.startDate || filters?.endDate) {
    where.startDate = {};
    if (filters?.startDate) where.startDate.gte = new Date(filters.startDate);
    if (filters?.endDate) where.startDate.lte = new Date(filters.endDate);
  }

  return prisma.leaveRequest.findMany({
    where,
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}
