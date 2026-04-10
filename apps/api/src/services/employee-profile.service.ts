import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { EmployeeProfileData } from "@dashmani/shared";

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });

  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }

  // Create profile if it doesn't exist
  let profile = user.profile;
  if (!profile) {
    profile = await prisma.employeeProfile.create({
      data: { userId },
    });
  }

  return {
    id: profile.id,
    userId: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    profileImageUrl: user.profileImageUrl,
    status: user.status,
    designation: profile.designation,
    salary: profile.salary,
    bankAccountHolderName: profile.bankAccountHolderName,
    bankAccountNumber: profile.bankAccountNumber,
    bankName: profile.bankName,
    bankBranch: profile.bankBranch,
    ifscCode: profile.ifscCode,
    mailingAddress: profile.mailingAddress,
    aadhaarNumber: profile.aadhaarNumber,
    panNumber: profile.panNumber,
    familyContact1Name: profile.familyContact1Name,
    familyContact1Phone: profile.familyContact1Phone,
    familyContact1Relation: profile.familyContact1Relation,
    familyContact2Name: profile.familyContact2Name,
    familyContact2Phone: profile.familyContact2Phone,
    familyContact2Relation: profile.familyContact2Relation,
  };
}

export async function updateProfile(userId: string, data: Partial<EmployeeProfileData>) {
  // Ensure profile exists
  let profile = await prisma.employeeProfile.findUnique({
    where: { userId },
  });

  if (!profile) {
    profile = await prisma.employeeProfile.create({
      data: { userId },
    });
  }

  // Employees can update everything EXCEPT designation (admin only)
  const { designation, salary, ...allowedFields } = data;

  const updated = await prisma.employeeProfile.update({
    where: { userId },
    data: allowedFields,
  });

  const user = await prisma.user.findUnique({ where: { id: userId } });

  return {
    id: updated.id,
    userId: user!.id,
    name: user!.name,
    email: user!.email,
    phone: user!.phone,
    profileImageUrl: user!.profileImageUrl,
    status: user!.status,
    designation: updated.designation,
    salary: updated.salary,
    bankAccountHolderName: updated.bankAccountHolderName,
    bankAccountNumber: updated.bankAccountNumber,
    bankName: updated.bankName,
    bankBranch: updated.bankBranch,
    ifscCode: updated.ifscCode,
    mailingAddress: updated.mailingAddress,
    aadhaarNumber: updated.aadhaarNumber,
    panNumber: updated.panNumber,
    familyContact1Name: updated.familyContact1Name,
    familyContact1Phone: updated.familyContact1Phone,
    familyContact1Relation: updated.familyContact1Relation,
    familyContact2Name: updated.familyContact2Name,
    familyContact2Phone: updated.familyContact2Phone,
    familyContact2Relation: updated.familyContact2Relation,
  };
}

// ===== Admin functions =====

export async function approveEmployee(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }
  if (user.status === "ACTIVE") {
    throw new AppError(400, "ALREADY_ACTIVE", "Employee is already active");
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status: "ACTIVE" },
    select: { id: true, name: true, email: true, phone: true, status: true },
  });

  return updated;
}

export async function rejectEmployee(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "NOT_FOUND", "Employee not found");
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status: "INACTIVE" },
    select: { id: true, name: true, email: true, phone: true, status: true },
  });

  return updated;
}

export async function getPendingEmployees() {
  const users = await prisma.user.findMany({
    where: { status: "ONBOARDING", deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      status: true,
      createdAt: true,
      profile: {
        select: { designation: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return users;
}

export async function adminUpdateProfile(userId: string, data: Partial<EmployeeProfileData>) {
  // Admin can update everything including designation and salary
  let profile = await prisma.employeeProfile.findUnique({ where: { userId } });
  if (!profile) {
    profile = await prisma.employeeProfile.create({
      data: { userId },
    });
  }

  const updated = await prisma.employeeProfile.update({
    where: { userId },
    data,
  });

  return updated;
}

export async function updateProfileImage(userId: string, profileImageUrl: string) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { profileImageUrl },
    select: { id: true, profileImageUrl: true },
  });
  return user;
}
