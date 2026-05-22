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

  // Fetch leave requests for the employee — APPROVED, PENDING, REJECTED all shown with status
  let leaveRequests: any[] = [];
  if (employeeId) {
    leaveRequests = await prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: { in: ["APPROVED", "PENDING", "REJECTED"] },
        OR: [
          { startDate: { gte: startDate, lte: endDate } },
          { endDate: { gte: startDate, lte: endDate } },
          { startDate: { lte: startDate }, endDate: { gte: endDate } },
        ],
      },
      orderBy: { startDate: "asc" },
    });
  }

  // Build a lookup map: date (YYYY-MM-DD) -> holiday
  const holidayMap = new Map<string, { name: string; type?: string }>();
  for (const h of holidays) {
    const key = new Date(h.date).toISOString().split("T")[0];
    holidayMap.set(key, { name: h.name, type: h.type });
  }

  // Build a lookup map: date (YYYY-MM-DD) -> { leaveType, leaveStatus }
  const leaveMap = new Map<string, { leaveType: string; leaveStatus: string }>();
  for (const lr of leaveRequests) {
    const lStart = new Date(lr.startDate);
    const lEnd = new Date(lr.endDate);
    for (let d = new Date(lStart); d <= lEnd; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().split("T")[0];
      // APPROVED wins if same day has multiple overlapping requests
      if (!leaveMap.has(key) || lr.status === "APPROVED") {
        leaveMap.set(key, { leaveType: lr.type, leaveStatus: lr.status });
      }
    }
  }

  // Build days array
  const totalDays = endDate.getDate();
  const days: Array<{
    date: string;
    isWeekend: boolean;
    isHoliday: boolean;
    holidayName?: string;
    isLeave: boolean;
    leaveType?: string;
    leaveStatus?: string;
  }> = [];

  let weekends = 0;
  let holidaysOnWeekdays = 0;

  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month - 1, day);
    const dayOfWeek = date.getDay();
    const isWeekend = dayOfWeek === 0; // Sunday only — Saturday is a working day
    const dateKey = date.toISOString().split("T")[0];
    const holiday = holidayMap.get(dateKey);
    const leave = leaveMap.get(dateKey);

    if (isWeekend) weekends++;
    if (holiday && !isWeekend) holidaysOnWeekdays++;

    days.push({
      date: date.toISOString(),
      isWeekend,
      isHoliday: !!holiday,
      holidayName: holiday?.name,
      isLeave: !!leave,
      leaveType: leave?.leaveType,
      leaveStatus: leave?.leaveStatus,
    });
  }

  const workingDays = totalDays - weekends - holidaysOnWeekdays;

  return {
    year,
    month,
    days,
    holidays,
    leaveRequests,
    workingDays,
    totalDays,
    weekends,
    holidaysOnWeekdays,
  };
}
