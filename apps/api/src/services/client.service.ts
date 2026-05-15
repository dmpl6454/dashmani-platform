import { prisma } from "@dashmani/db";

export async function getClientFiles(clientId: string, params: { projectId?: string; search?: string }) {
  const where: any = {
    project: { clientId },
  };
  if (params.projectId) where.projectId = params.projectId;
  if (params.search) {
    where.name = { contains: params.search, mode: "insensitive" };
  }

  const files = await prisma.projectFile.findMany({
    where,
    include: {
      project: { select: { id: true, name: true } },
      uploadedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return files.map((f) => ({
    id: f.id,
    name: f.name,
    url: f.url,
    size: f.size,
    mimeType: f.mimeType,
    createdAt: f.createdAt,
    project: f.project,
    uploadedBy: f.uploadedBy,
  }));
}
