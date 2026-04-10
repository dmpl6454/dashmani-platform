import { prisma } from "@dashmani/db";

export async function createIncentive(data: {
  employeeId: string;
  amount: number;
  reason: string;
  month?: number;
  year?: number;
  awardedBy: string;
}) {
  const incentive = await prisma.incentive.create({
    data,
    include: { employee: { select: { id: true, name: true } } },
  });

  // Send notification
  await prisma.notification.create({
    data: {
      userId: data.employeeId,
      type: "INCENTIVE_AWARDED",
      title: "Incentive Awarded",
      message: `You have been awarded an incentive of ₹${data.amount.toLocaleString()} - ${data.reason}`,
      metadata: { incentiveId: incentive.id, amount: data.amount },
    },
  });

  return incentive;
}

export async function getEmployeeIncentives(employeeId: string, year?: number) {
  const where: any = { employeeId };
  if (year) where.year = year;
  return prisma.incentive.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { employee: { select: { id: true, name: true } } },
  });
}

export async function getAllIncentives(filters?: { employeeId?: string; year?: number }) {
  const where: any = {};
  if (filters?.employeeId) where.employeeId = filters.employeeId;
  if (filters?.year) where.year = filters.year;
  return prisma.incentive.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { employee: { select: { id: true, name: true, email: true } } },
  });
}
