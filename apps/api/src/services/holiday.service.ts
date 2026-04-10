import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function createHoliday(data: {
  name: string;
  date: string;
  type?: "PUBLIC" | "RESTRICTED" | "COMPANY";
  description?: string;
}) {
  const holidayDate = new Date(data.date);
  holidayDate.setHours(0, 0, 0, 0);

  const existing = await prisma.holiday.findFirst({
    where: { date: holidayDate },
  });

  if (existing) {
    throw new AppError(400, "DUPLICATE_HOLIDAY", "A holiday already exists on this date");
  }

  return prisma.holiday.create({
    data: {
      name: data.name,
      date: holidayDate,
      type: data.type || "PUBLIC",
      description: data.description,
    },
  });
}

export async function listHolidays(year?: number) {
  const targetYear = year || new Date().getFullYear();
  const startDate = new Date(targetYear, 0, 1);
  const endDate = new Date(targetYear, 11, 31, 23, 59, 59, 999);

  return prisma.holiday.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
    },
    orderBy: { date: "asc" },
  });
}

export async function deleteHoliday(id: string) {
  const holiday = await prisma.holiday.findUnique({ where: { id } });
  if (!holiday) {
    throw new AppError(404, "NOT_FOUND", "Holiday not found");
  }

  return prisma.holiday.delete({ where: { id } });
}

export async function getCalendarData(year: number, month: number, employeeId?: string) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);

  // Fetch holidays for the month
  const holidays = await prisma.holiday.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
    },
    orderBy: { date: "asc" },
  });

  // Fetch leave requests for the employee if provided
  let leaveRequests: any[] = [];
  if (employeeId) {
    leaveRequests = await prisma.leaveRequest.findMany({
      where: {
        employeeId,
        OR: [
          { startDate: { gte: startDate, lte: endDate } },
          { endDate: { gte: startDate, lte: endDate } },
          { startDate: { lte: startDate }, endDate: { gte: endDate } },
        ],
      },
      orderBy: { startDate: "asc" },
    });
  }

  // Calculate working days
  const totalDays = endDate.getDate();
  let weekends = 0;
  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month - 1, day);
    const dayOfWeek = date.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      weekends++;
    }
  }

  // Count holidays that don't fall on weekends
  let holidaysOnWeekdays = 0;
  for (const holiday of holidays) {
    const dayOfWeek = new Date(holiday.date).getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      holidaysOnWeekdays++;
    }
  }

  const workingDays = totalDays - weekends - holidaysOnWeekdays;

  return {
    holidays,
    leaveRequests,
    workingDays,
    totalDays,
    weekends,
    holidaysOnWeekdays,
  };
}
