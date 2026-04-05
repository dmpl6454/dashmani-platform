import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { Prisma } from "@dashmani/db";

const contentInclude = {
  project: { select: { id: true, name: true, client: { select: { id: true, companyName: true } } } },
  account: { select: { id: true, handle: true, displayName: true, platform: { select: { name: true, slug: true } } } },
  createdBy: { select: { id: true, name: true, email: true } },
};

export async function listContentPosts(params: {
  cursor?: string;
  limit: number;
  projectId?: string;
  accountId?: string;
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  clientId?: string;
}) {
  const where: Prisma.ContentPostWhereInput = {};
  if (params.projectId) where.projectId = params.projectId;
  if (params.accountId) where.accountId = params.accountId;
  if (params.status) where.status = params.status as any;
  if (params.clientId) where.project = { clientId: params.clientId };
  if (params.search) {
    where.OR = [
      { title: { contains: params.search, mode: "insensitive" } },
      { caption: { contains: params.search, mode: "insensitive" } },
    ];
  }
  if (params.dateFrom || params.dateTo) {
    where.scheduledAt = {};
    if (params.dateFrom) where.scheduledAt.gte = new Date(params.dateFrom);
    if (params.dateTo) where.scheduledAt.lte = new Date(params.dateTo);
  }

  const posts = await prisma.contentPost.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: contentInclude,
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
  });

  const hasMore = posts.length > params.limit;
  const items = hasMore ? posts.slice(0, params.limit) : posts;

  return {
    items,
    meta: {
      cursor: items.length > 0 ? items[items.length - 1].id : undefined,
      has_more: hasMore,
    },
  };
}

export async function getContentPostById(id: string) {
  const post = await prisma.contentPost.findUnique({
    where: { id },
    include: contentInclude,
  });
  if (!post) throw new AppError(404, "NOT_FOUND", "Content post not found");
  return post;
}

export async function createContentPost(data: {
  title: string;
  caption?: string;
  mediaUrls?: string[];
  projectId: string;
  accountId?: string;
  scheduledAt?: string;
  createdById: string;
}) {
  const project = await prisma.project.findUnique({ where: { id: data.projectId } });
  if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");

  if (data.accountId) {
    const account = await prisma.socialAccount.findUnique({ where: { id: data.accountId } });
    if (!account) throw new AppError(404, "NOT_FOUND", "Social account not found");
  }

  return prisma.contentPost.create({
    data: {
      title: data.title,
      caption: data.caption,
      mediaUrls: data.mediaUrls || [],
      projectId: data.projectId,
      accountId: data.accountId,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      createdById: data.createdById,
    },
    include: contentInclude,
  });
}

export async function updateContentPost(id: string, data: {
  title?: string;
  caption?: string | null;
  mediaUrls?: string[];
  projectId?: string;
  accountId?: string | null;
  scheduledAt?: string | null;
}) {
  const post = await prisma.contentPost.findUnique({ where: { id } });
  if (!post) throw new AppError(404, "NOT_FOUND", "Content post not found");

  if (post.status === "PUBLISHED") {
    throw new AppError(400, "ALREADY_PUBLISHED", "Cannot edit a published content post");
  }

  const updateData: Prisma.ContentPostUpdateInput = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.caption !== undefined) updateData.caption = data.caption;
  if (data.mediaUrls !== undefined) updateData.mediaUrls = data.mediaUrls;
  if (data.scheduledAt !== undefined) {
    updateData.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  }

  if (data.projectId !== undefined) {
    const project = await prisma.project.findUnique({ where: { id: data.projectId } });
    if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
    updateData.project = { connect: { id: data.projectId } };
  }

  if (data.accountId !== undefined) {
    updateData.account = data.accountId
      ? { connect: { id: data.accountId } }
      : { disconnect: true };
  }

  return prisma.contentPost.update({
    where: { id },
    data: updateData,
    include: contentInclude,
  });
}

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING_APPROVAL", "SCHEDULED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["SCHEDULED", "DRAFT"],
  REJECTED: ["DRAFT"],
  SCHEDULED: ["PUBLISHED", "FAILED", "DRAFT"],
  FAILED: ["SCHEDULED", "DRAFT"],
  PUBLISHED: [],
};

export async function updateContentStatus(id: string, newStatus: string) {
  const post = await prisma.contentPost.findUnique({ where: { id } });
  if (!post) throw new AppError(404, "NOT_FOUND", "Content post not found");

  const allowedTransitions = VALID_STATUS_TRANSITIONS[post.status] || [];
  if (!allowedTransitions.includes(newStatus)) {
    throw new AppError(
      400,
      "INVALID_TRANSITION",
      `Cannot transition from ${post.status} to ${newStatus}. Allowed: ${allowedTransitions.join(", ") || "none"}`
    );
  }

  const updateData: Prisma.ContentPostUpdateInput = {
    status: newStatus as any,
  };

  if (newStatus === "PUBLISHED") {
    updateData.publishedAt = new Date();
  }

  return prisma.contentPost.update({
    where: { id },
    data: updateData,
    include: contentInclude,
  });
}

export async function respondToContentApproval(
  id: string,
  clientId: string,
  status: "APPROVED" | "REJECTED"
) {
  const post = await prisma.contentPost.findUnique({
    where: { id },
    include: { project: { select: { clientId: true } } },
  });
  if (!post) throw new AppError(404, "NOT_FOUND", "Content post not found");

  if (post.project.clientId !== clientId) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this content");
  }

  if (post.status !== "PENDING_APPROVAL") {
    throw new AppError(400, "NOT_PENDING", "This content is not pending approval");
  }

  return prisma.contentPost.update({
    where: { id },
    data: { status: status as any },
    include: contentInclude,
  });
}

export async function deleteContentPost(id: string) {
  const post = await prisma.contentPost.findUnique({ where: { id } });
  if (!post) throw new AppError(404, "NOT_FOUND", "Content post not found");

  if (post.status === "PUBLISHED") {
    throw new AppError(400, "ALREADY_PUBLISHED", "Cannot delete a published content post");
  }

  await prisma.contentPost.delete({ where: { id } });
}

export async function getCalendarData(params: {
  year: number;
  month: number;
  projectId?: string;
  clientId?: string;
}) {
  const startDate = new Date(params.year, params.month - 1, 1);
  const endDate = new Date(params.year, params.month, 0, 23, 59, 59, 999);

  const where: Prisma.ContentPostWhereInput = {
    scheduledAt: {
      gte: startDate,
      lte: endDate,
    },
  };
  if (params.projectId) where.projectId = params.projectId;
  if (params.clientId) where.project = { clientId: params.clientId };

  const posts = await prisma.contentPost.findMany({
    where,
    include: contentInclude,
    orderBy: { scheduledAt: "asc" },
  });

  // Group posts by date string (YYYY-MM-DD)
  const grouped: Record<string, typeof posts> = {};
  for (const post of posts) {
    if (post.scheduledAt) {
      const dateKey = post.scheduledAt.toISOString().split("T")[0];
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(post);
    }
  }

  return {
    year: params.year,
    month: params.month,
    days: grouped,
  };
}
