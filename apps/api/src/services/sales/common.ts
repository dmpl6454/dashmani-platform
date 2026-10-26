import { prisma, Prisma } from "@dashmani/db";
import { documentNumber, financialYear, MAX_PAISE } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";

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

const IST_OFFSET_MS = 330 * 60_000;

/** The IST calendar day of a TIMESTAMP (createdAt…): 00:00–05:30 IST is still the previous UTC day. */
export function istDayOf(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant an IST day starts, for comparing TIMESTAMP columns against a day boundary. */
export function istMidnight(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS);
}

export type NumberKind = "invoice" | "proforma" | "quote" | "order" | "credit_note" | "receipt";

/** GST documents: their numbers must stay within 16 characters (CGST Rules, rule 46(b)). */
const GST_NUMBERED: ReadonlySet<NumberKind> = new Set(["invoice", "credit_note"]);

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
  const number = documentNumber(prefix, fy.label, serial);
  if (GST_NUMBERED.has(kind) && number.length > 16) {
    // Thrown before the sequence moves, so the transaction rolls back with no serial spent.
    throw new AppError(422, "NUMBER_TOO_LONG", `${number} is longer than the 16 characters GST allows — shorten the prefix in Settings`);
  }
  await tx.$executeRaw`UPDATE sales_sequences SET "next" = ${serial + 1}, "updated_at" = now() WHERE "key" = ${key}`;
  return number;
}

/**
 * Lock invoice rows for the rest of the transaction (sorted, so two transactions locking the
 * same set never deadlock). Every check-then-write on an invoice's state or balance — issuing,
 * cancelling, allocating a payment, crediting — takes this lock first and re-reads after it:
 * without it, two staff acting at once both pass the check (READ COMMITTED) and the invoice is
 * over-paid, over-credited, double-issued or cancelled with money on it.
 */
export async function lockInvoices(tx: Tx, ids: string[]): Promise<void> {
  const sorted = [...new Set(ids)].sort();
  if (!sorted.length) return;
  await tx.$queryRaw`SELECT id FROM sales_invoices WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`;
}

/** Money columns are Postgres INT (max ₹2,14,74,836.47): refuse a document that would not fit. */
export function assertMoneyFits(values: Record<string, number>): void {
  for (const [field, v] of Object.entries(values)) {
    if (!Number.isSafeInteger(v) || Math.abs(v) > MAX_PAISE) {
      // No `details`: the portal shows an error's first detail INSTEAD of its message.
      throw new AppError(422, "AMOUNT_TOO_LARGE", `This document's ${field.replace(/Paise$/, "")} is larger than ₹2,14,74,836 — split it into two documents`);
    }
  }
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
