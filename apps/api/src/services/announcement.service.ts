import { prisma } from "@dashmani/db";
import { sendEmail, announcementEmailHtml } from "./email.service";

export async function broadcastAnnouncement(
  sentById: string,
  title: string,
  message: string,
  orgUnitId?: string
): Promise<{ recipientCount: number; announcementId: string }> {
  const employees = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      ...(orgUnitId ? { orgUnitId } : {}),
    },
    select: { id: true, name: true, email: true },
  });

  const record = await prisma.announcement.create({
    data: {
      title,
      message,
      sentById,
      recipientCount: employees.length,
      ...(orgUnitId ? { orgUnitId } : {}),
    },
  });

  if (employees.length === 0) {
    return { recipientCount: 0, announcementId: record.id };
  }

  await prisma.notification.createMany({
    data: employees.map((emp) => ({
      userId: emp.id,
      type: "ANNOUNCEMENT" as const,
      title,
      message,
    })),
  });

  const sender = await prisma.user.findUnique({
    where: { id: sentById },
    select: { name: true },
  });
  const senderName = sender?.name ?? "Admin";
  const html = announcementEmailHtml(senderName, title, message);

  await Promise.allSettled(
    employees.map((emp) =>
      sendEmail({
        to: emp.email,
        subject: `[Announcement] ${title}`,
        html,
      }).catch((err) =>
        console.error(`✉ Announcement email failed for ${emp.email}:`, err)
      )
    )
  );

  return { recipientCount: employees.length, announcementId: record.id };
}

export async function getAnnouncements(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.announcement.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        sentBy: { select: { name: true } },
        orgUnit: { select: { id: true, name: true } },
      },
    }),
    prisma.announcement.count(),
  ]);
  return { items, total, page, limit };
}
