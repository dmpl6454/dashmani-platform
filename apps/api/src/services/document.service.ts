import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function uploadDocument(data: {
  employeeId: string;
  documentType: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
}) {
  const employee = await prisma.user.findUnique({ where: { id: data.employeeId } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  return prisma.employeeDocument.create({
    data: {
      employeeId: data.employeeId,
      documentType: data.documentType as any,
      fileName: data.fileName,
      filePath: data.filePath,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
      status: "PENDING",
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getEmployeeDocuments(employeeId: string) {
  const employee = await prisma.user.findUnique({ where: { id: employeeId } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  return prisma.employeeDocument.findMany({
    where: { employeeId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getAllPendingDocuments() {
  return prisma.employeeDocument.findMany({
    where: { status: "PENDING" },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function reviewDocument(
  id: string,
  reviewedBy: string,
  status: "APPROVED" | "REJECTED",
  reviewNotes?: string,
) {
  const document = await prisma.employeeDocument.findUnique({ where: { id } });
  if (!document) throw new AppError(404, "NOT_FOUND", "Document not found");
  if (document.status !== "PENDING") throw new AppError(400, "ALREADY_REVIEWED", "This document has already been reviewed");

  return prisma.employeeDocument.update({
    where: { id },
    data: {
      status,
      reviewedBy,
      reviewedAt: new Date(),
      reviewNotes,
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function getDocumentById(id: string) {
  const document = await prisma.employeeDocument.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });
  if (!document) throw new AppError(404, "NOT_FOUND", "Document not found");

  return document;
}
