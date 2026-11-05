import { prisma, Prisma } from "@dashmani/db";
import { documentNumber, financialYear, MAX_PAISE, seriesSerial, shortFy } from "@dashmani/shared";
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

export type NumberKind = "invoice" | "proforma" | "quote" | "order" | "credit_note" | "receipt" | "refund";

/** GST documents: their numbers must stay within 16 characters (CGST Rules, rule 46(b)). */
const GST_NUMBERED: ReadonlySet<NumberKind> = new Set(["invoice", "credit_note"]);

/**
 * Take the next serial for `kind` in the financial year of `day` — inside the caller's
 * transaction, so the FOR UPDATE row lock holds until the document is committed and two staff
 * issuing at once can never share or skip a number.
 */
const sequenceKey = (kind: NumberKind, scope: string | null, fyLabel: string) => (scope ? `${kind}@${scope}:${fyLabel}` : `${kind}:${fyLabel}`);

export async function nextDocumentNumber(tx: Tx, kind: NumberKind, prefix: string, day: string, scope: string | null = null, digits = 4): Promise<string> {
  const fy = financialYear(day);
  // GST numbers run per GSTIN: an additional registration gets its own series (scope = its GSTIN).
  const key = sequenceKey(kind, scope, fy.label);
  await tx.$executeRaw`INSERT INTO sales_sequences ("key", "next", "updated_at") VALUES (${key}, 1, now()) ON CONFLICT ("key") DO NOTHING`;
  const rows = await tx.$queryRaw<Array<{ next: number }>>`SELECT "next" FROM sales_sequences WHERE "key" = ${key} FOR UPDATE`;
  const serial = rows[0]?.next ?? 1;
  const number = documentNumber(prefix, fy.label, serial, digits);
  if (GST_NUMBERED.has(kind) && number.length > 16) {
    // Thrown before the sequence moves, so the transaction rolls back with no serial spent.
    throw new AppError(422, "NUMBER_TOO_LONG", `${number} is longer than the 16 characters GST allows — shorten the prefix in Settings`);
  }
  await tx.$executeRaw`UPDATE sales_sequences SET "next" = ${serial + 1}, "updated_at" = now() WHERE "key" = ${key}`;
  return number;
}

/**
 * The number the next document in a series WILL get, without taking it (no lock, nothing written).
 * For showing on screen only: another invoice issued first takes it, and Issue then numbers this
 * one with the next.
 */
export async function peekDocumentNumber(kind: NumberKind, prefix: string, day: string, scope: string | null = null, digits = 4): Promise<string> {
  const fy = financialYear(day);
  const rows = await prisma.$queryRaw<Array<{ next: number }>>`SELECT "next" FROM sales_sequences WHERE "key" = ${sequenceKey(kind, scope, fy.label)}`;
  return documentNumber(prefix, fy.label, rows[0]?.next ?? 1, digits);
}

/**
 * A number typed by hand at Issue (e.g. continuing a series started in another billing app).
 * Inside the caller's transaction. When it belongs to this series — PREFIX/26-27/<serial> for the
 * document's financial year — the series moves past it, so the automatic number after it can
 * never repeat it; a number in any other format leaves the series alone. Uniqueness is the
 * caller's check (and the column's unique index).
 *
 * With `digits` (the series' zero-padded serial length) the number must be EXACTLY this series'
 * format (seriesSerial): two registrations can share a prefix — Mumbai INV with 4 digits, Gurugram
 * INV with 3 — and a typed INV/26-27/060 (Gurugram's format) on a Mumbai draft must not move
 * Mumbai's series from 16 to 61. Without `digits`, the original any-digit-count rule applies.
 */
export async function claimManualNumber(tx: Tx, kind: NumberKind, prefix: string, day: string, scope: string | null, number: string, digits?: number): Promise<string> {
  const fy = financialYear(day);
  const n = number.trim();
  if (GST_NUMBERED.has(kind) && n.length > 16) throw new AppError(422, "NUMBER_TOO_LONG", `${n} is longer than the 16 characters GST allows`);
  let serial: number | null = null;
  if (digits !== undefined) {
    serial = seriesSerial(n, prefix, fy.label, digits);
  } else {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    const m = n.match(new RegExp(`^${esc(prefix)}/${esc(shortFy(fy.label))}/(\\d+)$`, "i"));
    if (m) serial = Number(m[1]);
  }
  if (serial !== null) {
    const key = sequenceKey(kind, scope, fy.label);
    await tx.$executeRaw`INSERT INTO sales_sequences ("key", "next", "updated_at") VALUES (${key}, 1, now()) ON CONFLICT ("key") DO NOTHING`;
    await tx.$executeRaw`UPDATE sales_sequences SET "next" = GREATEST("next", ${serial + 1}), "updated_at" = now() WHERE "key" = ${key}`;
  }
  return n;
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

/**
 * A BIGINT read (a `::bigint` SUM, a BIGINT column) as a JS number — never a bare Number(v), which
 * silently rounds past 2^53. null/undefined read as 0. Throws when the value is not a safe integer.
 */
export function toSafeNumber(v: bigint | number | null | undefined, what = "amount"): number {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n)) throw new Error(`[sales] ${what} out of safe range`);
  return n;
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

/** Every sales_events.entityType. The smart-invoicing types are pre-registered by PR 0 (spec-00 §2.2); features never edit this list. */
export type SalesEntity =
  | "quote"
  | "order"
  | "invoice"
  | "payment"
  | "credit_note"
  | "settings"
  | "client"
  | "recurring"
  | "filed_year"
  | "tally_run"
  | "import"
  | "bank_account"
  | "bank_statement"
  | "bank_line";

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

// ── Background work ─────────────────────────────────────────────────────────────
// Work that runs after the response (invoice emails, billing an online payment) is tracked here so
// it is never silently lost on a rejection, and so tests can wait for it before resetting the DB.

const background = new Set<Promise<unknown>>();

export function inBackground(label: string, work: () => Promise<unknown>): void {
  const p: Promise<unknown> = Promise.resolve()
    .then(work)
    .catch((err) => console.error(`[sales] ${label} failed`, err))
    .finally(() => background.delete(p));
  background.add(p);
}

export async function flushSalesBackground(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}
