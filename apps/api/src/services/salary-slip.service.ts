import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

interface GenerateSalarySlipInput {
  employeeId: string;
  month: number;
  year: number;
  basicSalary: number;
  hra: number;
  conveyance: number;
  medicalAllowance: number;
  specialAllowance: number;
  otherEarnings: number;
  pf: number;
  esi: number;
  tax: number;
  otherDeductions: number;
  generatedBy: string;
  remarks?: string;
}

interface ListSalarySlipsFilters {
  employeeId?: string;
  month?: number;
  year?: number;
  status?: string;
  search?: string;
}

export async function generateSalarySlip(data: GenerateSalarySlipInput) {
  const existing = await prisma.salarySlip.findUnique({
    where: {
      employeeId_month_year: {
        employeeId: data.employeeId,
        month: data.month,
        year: data.year,
      },
    },
  });

  if (existing) {
    throw new AppError(
      409,
      "CONFLICT",
      `Salary slip already exists for employee ${data.employeeId} for ${data.month}/${data.year}`,
    );
  }

  const employee = await prisma.user.findFirst({
    where: { id: data.employeeId, deletedAt: null },
  });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const grossSalary =
    data.basicSalary +
    data.hra +
    data.conveyance +
    data.medicalAllowance +
    data.specialAllowance +
    data.otherEarnings;

  const totalDeductions = data.pf + data.esi + data.tax + data.otherDeductions;
  const netSalary = grossSalary - totalDeductions;

  const salarySlip = await prisma.salarySlip.create({
    data: {
      employeeId: data.employeeId,
      month: data.month,
      year: data.year,
      basicSalary: data.basicSalary,
      hra: data.hra,
      conveyance: data.conveyance,
      medicalAllowance: data.medicalAllowance,
      specialAllowance: data.specialAllowance,
      otherEarnings: data.otherEarnings,
      pf: data.pf,
      esi: data.esi,
      tax: data.tax,
      otherDeductions: data.otherDeductions,
      netSalary,
      status: "PENDING_APPROVAL",
      generatedBy: data.generatedBy,
      remarks: data.remarks,
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });

  return salarySlip;
}

export async function generateBulkSalarySlips(
  month: number,
  year: number,
  generatedBy: string,
) {
  const activeEmployees = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    include: { profile: true },
  });

  let generated = 0;
  let skipped = 0;

  for (const employee of activeEmployees) {
    if (!employee.profile?.salary) {
      skipped++;
      continue;
    }

    const existing = await prisma.salarySlip.findUnique({
      where: {
        employeeId_month_year: {
          employeeId: employee.id,
          month,
          year,
        },
      },
    });

    if (existing) {
      skipped++;
      continue;
    }

    const grossSalary = employee.profile.salary;
    const basicSalary = grossSalary * 0.4;
    const hra = grossSalary * 0.2;
    const conveyance = grossSalary * 0.05;
    const medicalAllowance = grossSalary * 0.05;
    const specialAllowance = grossSalary * 0.2;
    const otherEarnings = grossSalary * 0.1;

    const pf = Math.round(basicSalary * 0.12 * 100) / 100;
    const esi = Math.round(grossSalary * 0.0075 * 100) / 100;
    const tax = 0;
    const otherDeductions = 0;

    const netSalary = grossSalary - pf - esi - tax - otherDeductions;

    await prisma.salarySlip.create({
      data: {
        employeeId: employee.id,
        month,
        year,
        basicSalary: Math.round(basicSalary * 100) / 100,
        hra: Math.round(hra * 100) / 100,
        conveyance: Math.round(conveyance * 100) / 100,
        medicalAllowance: Math.round(medicalAllowance * 100) / 100,
        specialAllowance: Math.round(specialAllowance * 100) / 100,
        otherEarnings: Math.round(otherEarnings * 100) / 100,
        pf,
        esi,
        tax,
        otherDeductions,
        netSalary: Math.round(netSalary * 100) / 100,
        status: "PENDING_APPROVAL",
        generatedBy,
      },
    });

    generated++;
  }

  return { generated, skipped };
}

export async function approveSalarySlip(id: string, approvedBy: string) {
  const slip = await prisma.salarySlip.findUnique({ where: { id } });
  if (!slip) throw new AppError(404, "NOT_FOUND", "Salary slip not found");

  if (slip.status !== "PENDING_APPROVAL") {
    throw new AppError(
      400,
      "BAD_REQUEST",
      `Cannot approve salary slip with status ${slip.status}`,
    );
  }

  const updated = await prisma.salarySlip.update({
    where: { id },
    data: {
      status: "APPROVED",
      approvedBy,
      approvedAt: new Date(),
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });

  return updated;
}

export async function rejectSalarySlip(
  id: string,
  approvedBy: string,
  remarks?: string,
) {
  const slip = await prisma.salarySlip.findUnique({ where: { id } });
  if (!slip) throw new AppError(404, "NOT_FOUND", "Salary slip not found");

  if (slip.status !== "PENDING_APPROVAL") {
    throw new AppError(
      400,
      "BAD_REQUEST",
      `Cannot reject salary slip with status ${slip.status}`,
    );
  }

  const updated = await prisma.salarySlip.update({
    where: { id },
    data: {
      status: "REJECTED",
      approvedBy,
      approvedAt: new Date(),
      ...(remarks ? { remarks } : {}),
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });

  return updated;
}

export async function updateSalarySlip(
  id: string,
  data: {
    basicSalary?: number;
    hra?: number;
    conveyance?: number;
    medicalAllowance?: number;
    specialAllowance?: number;
    otherEarnings?: number;
    pf?: number;
    esi?: number;
    tax?: number;
    otherDeductions?: number;
    remarks?: string;
  },
) {
  const existing = await prisma.salarySlip.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Salary slip not found");
  if (existing.status === "APPROVED")
    throw new AppError(400, "ALREADY_APPROVED", "Cannot edit an approved salary slip");

  const merged = { ...existing, ...data };
  const totalEarnings =
    (merged.basicSalary || 0) +
    (merged.hra || 0) +
    (merged.conveyance || 0) +
    (merged.medicalAllowance || 0) +
    (merged.specialAllowance || 0) +
    (merged.otherEarnings || 0);
  const totalDeductions =
    (merged.pf || 0) + (merged.esi || 0) + (merged.tax || 0) + (merged.otherDeductions || 0);
  const netSalary = totalEarnings - totalDeductions;

  return prisma.salarySlip.update({
    where: { id },
    data: { ...data, netSalary },
    include: { employee: { select: { id: true, name: true, email: true } } },
  });
}

export async function listSalarySlips(filters: ListSalarySlipsFilters) {
  const where: Record<string, unknown> = {};

  if (filters.employeeId) where.employeeId = filters.employeeId;
  if (filters.month) where.month = filters.month;
  if (filters.year) where.year = filters.year;
  if (filters.status) where.status = filters.status;
  if (filters.search && filters.search.trim()) {
    const s = filters.search.trim();
    where.employee = {
      OR: [
        { name: { contains: s, mode: "insensitive" } },
        { email: { contains: s, mode: "insensitive" } },
      ],
    };
  }

  const slips = await prisma.salarySlip.findMany({
    where,
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }],
  });

  return slips;
}

export async function getEmployeeSalarySlips(employeeId: string) {
  const employee = await prisma.user.findFirst({
    where: { id: employeeId, deletedAt: null },
  });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const slips = await prisma.salarySlip.findMany({
    where: { employeeId },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });

  return slips;
}

export async function getSalarySlipById(id: string) {
  const slip = await prisma.salarySlip.findUnique({
    where: { id },
    include: {
      employee: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          profile: {
            select: {
              designation: true,
              bankAccountHolderName: true,
              bankAccountNumber: true,
              bankName: true,
              bankBranch: true,
              ifscCode: true,
              panNumber: true,
            },
          },
        },
      },
    },
  });

  if (!slip) throw new AppError(404, "NOT_FOUND", "Salary slip not found");

  return slip;
}
