import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function createReview(data: {
  employeeId: string;
  reviewerId: string;
  period: string;
  rating: number;
  strengths?: string;
  improvements?: string;
  comments?: string;
  goals?: string;
}) {
  if (data.rating < 1 || data.rating > 5) {
    throw new AppError(400, "INVALID_RATING", "Rating must be between 1 and 5");
  }

  const review = await prisma.performanceReview.create({
    data,
    include: {
      employee: { select: { id: true, name: true, email: true } },
      reviewer: { select: { id: true, name: true } },
    },
  });

  // Notify employee
  await prisma.notification.create({
    data: {
      userId: data.employeeId,
      type: "PERFORMANCE_REVIEW",
      title: "Performance Review Submitted",
      message: `A performance review for "${data.period}" has been submitted. Rating: ${data.rating}/5`,
      metadata: { reviewId: review.id, rating: data.rating, period: data.period },
    },
  });

  return review;
}

export async function getEmployeeReviews(employeeId: string) {
  return prisma.performanceReview.findMany({
    where: { employeeId },
    orderBy: { createdAt: "desc" },
    include: {
      reviewer: { select: { id: true, name: true } },
    },
  });
}

export async function getAllReviews(filters?: { employeeId?: string }) {
  const where: any = {};
  if (filters?.employeeId) where.employeeId = filters.employeeId;
  return prisma.performanceReview.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      employee: { select: { id: true, name: true, email: true } },
      reviewer: { select: { id: true, name: true } },
    },
  });
}

export async function getReviewById(id: string) {
  return prisma.performanceReview.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, name: true, email: true } },
      reviewer: { select: { id: true, name: true } },
    },
  });
}
