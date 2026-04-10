import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function createExtraWorkHour(data: {
  employeeId: string;
  date: string;
  hours: number;
  description?: string;
}) {
  return prisma.extraWorkHour.create({
    data: {
      employeeId: data.employeeId,
      date: new Date(data.date),
      hours: data.hours,
      description: data.description,
      status: "PENDING",
    },
    include: { employee: { select: { id: true, name: true } } },
  });
}

export async function getEmployeeExtraHours(employeeId: string, year?: number) {
  const where: any = { employeeId };
  if (year) {
    where.date = {
      gte: new Date(`${year}-01-01`),
      lt: new Date(`${year + 1}-01-01`),
    };
  }
  return prisma.extraWorkHour.findMany({
    where,
    orderBy: { date: "desc" },
    include: { employee: { select: { id: true, name: true } } },
  });
}

export async function getPendingExtraHours() {
  return prisma.extraWorkHour.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { employee: { select: { id: true, name: true, email: true } } },
  });
}

export async function approveExtraHours(id: string, approvedBy: string) {
  const record = await prisma.extraWorkHour.findUnique({ where: { id } });
  if (!record) throw new AppError(404, "NOT_FOUND", "Extra work record not found");
  if (record.status !== "PENDING") throw new AppError(400, "ALREADY_REVIEWED", "Already reviewed");

  return prisma.extraWorkHour.update({
    where: { id },
    data: { status: "APPROVED", approvedBy, approvedAt: new Date() },
    include: { employee: { select: { id: true, name: true } } },
  });
}

export async function rejectExtraHours(id: string, approvedBy: string) {
  const record = await prisma.extraWorkHour.findUnique({ where: { id } });
  if (!record) throw new AppError(404, "NOT_FOUND", "Extra work record not found");
  if (record.status !== "PENDING") throw new AppError(400, "ALREADY_REVIEWED", "Already reviewed");

  return prisma.extraWorkHour.update({
    where: { id },
    data: { status: "REJECTED", approvedBy, approvedAt: new Date() },
    include: { employee: { select: { id: true, name: true } } },
  });
}
