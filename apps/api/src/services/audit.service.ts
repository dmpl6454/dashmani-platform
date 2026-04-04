import { prisma } from "@dashmani/db";

export async function createAuditLog(params: {
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  before?: any;
  after?: any;
  ipAddress?: string;
}) {
  return prisma.auditLog.create({ data: params });
}
