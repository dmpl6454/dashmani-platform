import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function requestProfilePictureChange(employeeId: string, filePath: string) {
  const employee = await prisma.user.findUnique({ where: { id: employeeId } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  return prisma.profilePictureRequest.create({
    data: {
      employeeId,
      filePath,
      status: "PENDING",
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getPendingProfilePictures() {
  return prisma.profilePictureRequest.findMany({
    where: { status: "PENDING" },
    include: {
      employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function approveProfilePicture(id: string, approvedBy: string) {
  const request = await prisma.profilePictureRequest.findUnique({ where: { id } });
  if (!request) throw new AppError(404, "NOT_FOUND", "Profile picture request not found");
  if (request.status !== "PENDING") throw new AppError(400, "ALREADY_REVIEWED", "This request has already been reviewed");

  const [updatedRequest] = await prisma.$transaction([
    prisma.profilePictureRequest.update({
      where: { id },
      data: {
        status: "APPROVED",
        approvedBy,
        approvedAt: new Date(),
      },
      include: {
        employee: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.user.update({
      where: { id: request.employeeId },
      data: { profileImageUrl: request.filePath },
    }),
  ]);

  return updatedRequest;
}

export async function rejectProfilePicture(id: string, approvedBy: string) {
  const request = await prisma.profilePictureRequest.findUnique({ where: { id } });
  if (!request) throw new AppError(404, "NOT_FOUND", "Profile picture request not found");
  if (request.status !== "PENDING") throw new AppError(400, "ALREADY_REVIEWED", "This request has already been reviewed");

  return prisma.profilePictureRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      approvedBy,
      approvedAt: new Date(),
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getEmployeeProfilePicRequests(employeeId: string) {
  const employee = await prisma.user.findUnique({ where: { id: employeeId } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  return prisma.profilePictureRequest.findMany({
    where: { employeeId },
    orderBy: { createdAt: "desc" },
  });
}
