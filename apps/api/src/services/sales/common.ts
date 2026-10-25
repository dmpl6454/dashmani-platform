import { prisma, Prisma } from "@dashmani/db";
import { documentNumber, financialYear } from "@dashmani/shared";

// Shared plumbing for the sales services: the transaction client type, IST day <-> DATE column
// conversion, the per-financial-year number sequences and the append-only audit log.

export type Tx = Prisma.TransactionClient;

/** YYYY-MM-DD (IST calendar day) -> the Date Prisma stores in a @db.Date column. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A @db.Date column value back to YYYY-MM-DD. */
export function dateToDay(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export type NumberKind = "invoice" | "quote" | "order" | "credit_note" | "receipt";

/**
 * Take the next serial for `kind` in the financial year of `day` — inside the caller's
 * transaction, so the FOR UPDATE row lock holds until the document is committed and two staff
 * issuing at once can never share or skip a number.
 */
export async function nextDocumentNumber(tx: Tx, kind: NumberKind, prefix: string, day: string): Promise<string> {
  const fy = financialYear(day);
  const key = `${kind}:${fy.label}`;
  await tx.$executeRaw`INSERT INTO sales_sequences ("key", "next", "updated_at") VALUES (${key}, 1, now()) ON CONFLICT ("key") DO NOTHING`;
  const rows = await tx.$queryRaw<Array<{ next: number }>>`SELECT "next" FROM sales_sequences WHERE "key" = ${key} FOR UPDATE`;
  const serial = rows[0]?.next ?? 1;
  await tx.$executeRaw`UPDATE sales_sequences SET "next" = ${serial + 1}, "updated_at" = now() WHERE "key" = ${key}`;
  return documentNumber(prefix, fy.label, serial);
}

export type SalesEntity = "quote" | "order" | "invoice" | "payment" | "credit_note" | "settings" | "client";

export async function logSalesEvent(
  tx: Tx | typeof prisma,
  e: { entityType: SalesEntity; entityId: string; actorId?: string | null; action: string; fromStatus?: string | null; toStatus?: string | null; note?: string | null },
): Promise<void> {
  await tx.salesEvent.create({
    data: {
      entityType: e.entityType,
      entityId: e.entityId,
      actorId: e.actorId ?? null,
      action: e.action,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      note: e.note ?? null,
    },
  });
}

export async function listSalesEvents(entityType: SalesEntity, entityId: string) {
  return prisma.salesEvent.findMany({ where: { entityType, entityId }, orderBy: { createdAt: "desc" }, take: 100 });
}
