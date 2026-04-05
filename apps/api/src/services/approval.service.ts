import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function createApproval(projectId: string, requestedById: string, data: {
  title: string;
  description?: string;
  fileUrl?: string;
}) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");

  return prisma.approval.create({
    data: { projectId, requestedById, ...data },
    include: { requestedBy: { select: { id: true, name: true } }, project: { select: { id: true, name: true } } },
  });
}

export async function respondToApproval(approvalId: string, status: string, clientNote?: string) {
  const approval = await prisma.approval.findUnique({ where: { id: approvalId } });
  if (!approval) throw new AppError(404, "NOT_FOUND", "Approval not found");
  if (approval.status !== "PENDING") throw new AppError(400, "ALREADY_RESPONDED", "This approval has already been responded to");

  return prisma.approval.update({
    where: { id: approvalId },
    data: { status: status as any, clientNote, respondedAt: new Date() },
    include: { requestedBy: { select: { id: true, name: true } }, project: { select: { id: true, name: true } } },
  });
}

export async function listApprovals(params: { projectId?: string; clientId?: string; status?: string; limit: number; cursor?: string }) {
  const where: any = {};
  if (params.projectId) where.projectId = params.projectId;
  if (params.clientId) where.project = { clientId: params.clientId };
  if (params.status) where.status = params.status;

  const approvals = await prisma.approval.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      requestedBy: { select: { id: true, name: true } },
      project: { select: { id: true, name: true, client: { select: { id: true, companyName: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  const hasMore = approvals.length > params.limit;
  const items = hasMore ? approvals.slice(0, params.limit) : approvals;

  return {
    items,
    meta: { cursor: items.length > 0 ? items[items.length - 1].id : undefined, has_more: hasMore },
  };
}
