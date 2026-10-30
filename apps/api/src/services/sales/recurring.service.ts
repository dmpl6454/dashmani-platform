import { prisma, Prisma } from "@dashmani/db";
import { computeTotals, todayIST, type CompanyKey, type RecurringFrequency, type RecurringLineInput, type RecurringUpsertInput, type TaxMode } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { assertMoneyFits, dateToDay, dayToDate, logSalesEvent } from "./common";
import { assertSameCompany, resolveDocumentTax } from "./documents.service";
import { createInvoice, issueInvoice } from "./invoices.service";
import { emailInvoice, SYSTEM_ACTOR } from "./invoice-email.service";
import { getSellerOrDefaults } from "./settings.service";
import { msUntilNextIST } from "../pipeline/jobs";

// Recurring / retainer invoices. A template bills a client every period (monthly, quarterly or
// yearly, on `dayOfMonth` ≤ 28 so every month has the day). The daily job — and "Run now" —
// bills the period at `nextRunDate` and moves it on.
//
// ⚠️ Rules:
//  • One invoice per period, never two. A run CLAIMS its period with one conditional update
//    (`WHERE status='active' AND next_run_date = <the period it read>`), so two runs (the job and a
//    "Run now", two app instances, a retry) can never bill the same period; the loser does nothing.
//  • Totals are never stored on the template: each invoice is built from the template's lines by
//    createInvoice, which recomputes GST like any other invoice, and is numbered only at issue.
//  • Never a half-issued invoice. If the draft cannot be created, the claim is undone (the period
//    is retried next run) and `lastError` says why. In "issue" mode a failed issue leaves the
//    draft for staff, with the reason in `lastError`.

const MAX_CATCH_UP = 3; // periods billed for one template in one daily run (after an outage)
const DAILY_TARGET_MIN = 390; // 06:30 IST
export const RECURRING_MARKER_KEY = "sales.recurringLastRunIST";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STEP: Record<RecurringFrequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

function ymd(y: number, m: number, d: number): string {
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The first billing day on or after the start date. */
export function firstRunDate(startDay: string, dayOfMonth: number): string {
  const [y, m, d] = startDay.split("-").map(Number);
  return d <= dayOfMonth ? ymd(y, m - 1, dayOfMonth) : ymd(y, m, dayOfMonth);
}

/** The billing day one period after `day`. */
export function nextPeriod(day: string, frequency: RecurringFrequency, dayOfMonth: number): string {
  const [y, m] = day.split("-").map(Number);
  return ymd(y, m - 1 + STEP[frequency], dayOfMonth);
}

/** "November 2026", "Nov 2026 – Jan 2027", "Nov 2026 – Oct 2027". */
export function periodLabel(day: string, frequency: RecurringFrequency): string {
  const [y, m] = day.split("-").map(Number);
  if (frequency === "monthly") return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
  const endM = m - 1 + STEP[frequency] - 1;
  const endY = y + Math.floor(endM / 12);
  return `${MONTHS[m - 1]} ${y} – ${MONTHS[endM % 12]} ${endY}`;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

type Row = Prisma.SalesRecurringInvoiceGetPayload<{ include: { client: { select: { id: true; companyName: true } } } }>;

function shape(r: Row) {
  return {
    id: r.id,
    companyKey: r.companyKey,
    client: r.client,
    title: r.title,
    kind: r.kind,
    frequency: r.frequency,
    dayOfMonth: r.dayOfMonth,
    startDate: dateToDay(r.startDate),
    endDate: dateToDay(r.endDate),
    nextRunDate: dateToDay(r.nextRunDate),
    nextPeriodLabel: periodLabel(dateToDay(r.nextRunDate)!, r.frequency as RecurringFrequency),
    mode: r.mode,
    placeOfSupplyCode: r.placeOfSupplyCode,
    taxMode: r.taxMode,
    gstRateBp: r.gstRateBp,
    sellerGstin: r.sellerGstin,
    discountPaise: r.discountPaise,
    dueDays: r.dueDays,
    notes: r.notes,
    lines: r.lines as RecurringLineInput[],
    status: r.status,
    lastInvoiceId: r.lastInvoiceId,
    lastRunAt: r.lastRunAt,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const include = { client: { select: { id: true, companyName: true } } } as const;

/** Check the template like an invoice would be: client, registration and the totals fit. Returns the taxable estimate. */
async function validate(input: RecurringUpsertInput) {
  const tax = await resolveDocumentTax(
    input.clientId,
    { placeOfSupplyCode: input.placeOfSupplyCode, taxMode: input.taxMode ?? undefined, gstRateBp: input.gstRateBp ?? undefined, sellerGstin: input.sellerGstin },
    input.companyKey,
  );
  const t = computeTotals({ lines: input.lines, discountPaise: input.discountPaise, taxMode: tax.taxMode, gstRateBp: tax.gstRateBp, roundToRupee: tax.seller.roundToRupee });
  assertMoneyFits({ subtotalPaise: t.subtotalPaise, taxablePaise: t.taxablePaise, totalPaise: t.totalPaise });
  return { sellerGstin: tax.sellerGstin, totalPaise: t.totalPaise };
}

function fields(input: RecurringUpsertInput, sellerGstin: string | null) {
  return {
    title: input.title,
    kind: input.kind,
    frequency: input.frequency,
    dayOfMonth: input.dayOfMonth,
    startDate: dayToDate(input.startDate),
    endDate: input.endDate ? dayToDate(input.endDate) : null,
    mode: input.mode,
    placeOfSupplyCode: input.placeOfSupplyCode ?? null,
    taxMode: input.taxMode ?? null,
    gstRateBp: input.gstRateBp ?? null,
    sellerGstin,
    discountPaise: input.discountPaise,
    dueDays: input.dueDays ?? null,
    notes: input.notes ?? null,
    lines: input.lines as unknown as Prisma.InputJsonValue,
  };
}

export async function listRecurring(filter: { company?: CompanyKey; clientId?: string; status?: string } = {}) {
  const rows = await prisma.salesRecurringInvoice.findMany({
    where: {
      ...(filter.company ? { companyKey: filter.company } : {}),
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
    take: 500,
    include,
  });
  const lastIds = rows.map((r) => r.lastInvoiceId).filter((x): x is string => !!x);
  const last = lastIds.length
    ? await prisma.salesInvoice.findMany({ where: { id: { in: lastIds } }, select: { id: true, number: true, status: true, totalPaise: true } })
    : [];
  const byId = new Map(last.map((i) => [i.id, i]));
  return rows.map((r) => ({ ...shape(r), lastInvoice: r.lastInvoiceId ? byId.get(r.lastInvoiceId) ?? null : null }));
}

export async function getRecurring(id: string) {
  const r = await prisma.salesRecurringInvoice.findUnique({ where: { id }, include });
  if (!r) throw new AppError(404, "NOT_FOUND", "Recurring invoice not found");
  const invoices = await prisma.salesInvoice.findMany({
    where: { recurringId: id },
    orderBy: { createdAt: "desc" },
    take: 24,
    select: { id: true, number: true, kind: true, status: true, issueDate: true, totalPaise: true, notes: true },
  });
  return { ...shape(r), invoices: invoices.map((i) => ({ ...i, issueDate: dateToDay(i.issueDate) })) };
}

export async function createRecurring(input: RecurringUpsertInput, actorId: string) {
  const { sellerGstin } = await validate(input);
  const next = firstRunDate(input.startDate, input.dayOfMonth);
  if (input.endDate && next > input.endDate) throw new AppError(400, "NO_PERIOD", `The first billing day would be ${next}, after the end date — move the end date or the day of the month`);
  const created = await prisma.salesRecurringInvoice.create({
    data: { companyKey: input.companyKey, clientId: input.clientId, ...fields(input, sellerGstin), nextRunDate: dayToDate(next), status: "active", createdById: actorId },
    select: { id: true },
  });
  await logSalesEvent(prisma, { entityType: "recurring", entityId: created.id, actorId, action: "created", toStatus: "active", note: `First invoice on ${next}` });
  return getRecurring(created.id);
}

export async function updateRecurring(id: string, input: RecurringUpsertInput, actorId: string) {
  const existing = await prisma.salesRecurringInvoice.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Recurring invoice not found");
  assertSameCompany(existing.companyKey, input.companyKey, "recurring invoice");
  if (existing.status === "ended") throw new AppError(409, "RECURRING_ENDED", "This recurring invoice has ended — create a new one");
  const { sellerGstin } = await validate(input);
  // Before the first invoice the schedule starts over from the start date; after it, the next
  // period keeps its month and only takes the new day of the month (no period is skipped or repeated).
  const curNext = dateToDay(existing.nextRunDate)!;
  const next = existing.lastRunAt ? `${curNext.slice(0, 8)}${String(input.dayOfMonth).padStart(2, "0")}` : firstRunDate(input.startDate, input.dayOfMonth);
  const ended = !!input.endDate && next > input.endDate;
  const res = await prisma.salesRecurringInvoice.updateMany({
    where: { id, nextRunDate: existing.nextRunDate },
    data: { ...fields(input, sellerGstin), nextRunDate: dayToDate(next), ...(ended ? { status: "ended" } : {}) },
  });
  if (res.count !== 1) throw new AppError(409, "RECURRING_BUSY", "This recurring invoice was just billed — reload it and try again");
  await logSalesEvent(prisma, { entityType: "recurring", entityId: id, actorId, action: "updated", note: ended ? "Ended: no billing day left before the end date" : `Next invoice on ${next}` });
  return getRecurring(id);
}

export async function setRecurringStatus(id: string, action: "pause" | "resume" | "end", actorId: string) {
  const r = await prisma.salesRecurringInvoice.findUnique({ where: { id } });
  if (!r) throw new AppError(404, "NOT_FOUND", "Recurring invoice not found");
  const from = r.status;
  const allowed: Record<typeof action, string[]> = { pause: ["active"], resume: ["paused"], end: ["active", "paused"] };
  if (!allowed[action].includes(from)) throw new AppError(409, "BAD_TRANSITION", `A recurring invoice that is ${from} cannot be ${action === "end" ? "ended" : `${action}d`}`);
  let data: Prisma.SalesRecurringInvoiceUpdateManyMutationInput = { status: action === "pause" ? "paused" : action === "end" ? "ended" : "active" };
  if (action === "resume") {
    // Resuming does not bill the periods that passed while paused: the next period is the first
    // billing day from today on.
    let next = dateToDay(r.nextRunDate)!;
    const today = todayIST();
    while (next < today) next = nextPeriod(next, r.frequency as RecurringFrequency, r.dayOfMonth);
    const end = dateToDay(r.endDate);
    data = { status: end && next > end ? "ended" : "active", nextRunDate: dayToDate(next) };
  }
  const res = await prisma.salesRecurringInvoice.updateMany({ where: { id, status: from }, data });
  if (res.count !== 1) throw new AppError(409, "RECURRING_BUSY", "This recurring invoice changed a moment ago — reload it");
  await logSalesEvent(prisma, { entityType: "recurring", entityId: id, actorId, action: action === "end" ? "ended" : `${action}d`, fromStatus: from, toStatus: String(data.status) });
  return getRecurring(id);
}

export interface RecurringRunResult {
  recurringId: string;
  period: string | null;
  invoiceId: string | null;
  issued: boolean;
  emailed: boolean;
  error: string | null;
  skipped?: string;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 480);

/**
 * Bill ONE period of a template: claim it, create the invoice (a draft, or issued and emailed in
 * "issue" mode), and record the outcome. `issueDay` is the issue date printed (today).
 */
export async function runRecurringOnce(id: string, opts: { actorId?: string; issueDay?: string; onlyIfDue?: boolean } = {}): Promise<RecurringRunResult> {
  const actorId = opts.actorId ?? SYSTEM_ACTOR;
  const issueDay = opts.issueDay ?? todayIST();
  const r = await prisma.salesRecurringInvoice.findUnique({ where: { id } });
  const base: RecurringRunResult = { recurringId: id, period: null, invoiceId: null, issued: false, emailed: false, error: null };
  if (!r) return { ...base, skipped: "not found" };
  if (r.status !== "active") return { ...base, skipped: `the recurring invoice is ${r.status}` };
  const period = dateToDay(r.nextRunDate)!;
  if (opts.onlyIfDue && period > issueDay) return { ...base, period, skipped: "not due yet" };
  const frequency = r.frequency as RecurringFrequency;
  const after = nextPeriod(period, frequency, r.dayOfMonth);
  const end = dateToDay(r.endDate);
  const now = new Date();

  // The claim: only the run that moves next_run_date off THIS period bills it.
  const claim = await prisma.salesRecurringInvoice.updateMany({
    where: { id, status: "active", nextRunDate: r.nextRunDate },
    data: { nextRunDate: dayToDate(after), status: end && after > end ? "ended" : "active", lastRunAt: now },
  });
  if (claim.count !== 1) return { ...base, period, skipped: "already billed by another run" };

  const label = periodLabel(period, frequency);
  let invoiceId: string;
  try {
    const seller = await getSellerOrDefaults(r.companyKey as CompanyKey);
    const dueDays = r.dueDays ?? seller.defaultDueDays;
    const inv = await createInvoice(
      {
        companyKey: r.companyKey as CompanyKey,
        clientId: r.clientId,
        kind: r.kind as "tax_invoice" | "proforma",
        issueDate: issueDay,
        dueDate: addDays(issueDay, dueDays),
        placeOfSupplyCode: r.placeOfSupplyCode,
        taxMode: (r.taxMode as TaxMode | null) ?? undefined,
        gstRateBp: r.gstRateBp ?? undefined,
        sellerGstin: r.sellerGstin,
        discountPaise: r.discountPaise,
        notes: `${r.title} — ${label}${r.notes ? `\n${r.notes}` : ""}`,
        items: (r.lines as RecurringLineInput[]).map((l) => ({ description: l.description, sac: l.sac ?? null, quantity: l.quantity, unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise ?? 0 })),
      },
      actorId,
      { recurringId: id },
    );
    invoiceId = inv.id;
  } catch (e) {
    // Nothing was created: give the period back so the next run tries it again.
    const msg = `Could not create the invoice for ${label}: ${errMsg(e)}`;
    await prisma.salesRecurringInvoice.updateMany({
      where: { id, nextRunDate: dayToDate(after) },
      data: { nextRunDate: r.nextRunDate, status: "active", lastError: msg.slice(0, 500) },
    });
    await logSalesEvent(prisma, { entityType: "recurring", entityId: id, actorId, action: "run_failed", note: msg.slice(0, 500) });
    return { ...base, period, error: msg };
  }

  await logSalesEvent(prisma, { entityType: "invoice", entityId: invoiceId, actorId, action: "recurring", note: `From recurring "${r.title}" for ${label}` });
  let issued = false;
  let emailed = false;
  let error: string | null = null;
  if (r.mode === "issue") {
    try {
      await issueInvoice(invoiceId, { issueDate: issueDay, dueDate: addDays(issueDay, r.dueDays ?? (await getSellerOrDefaults(r.companyKey as CompanyKey)).defaultDueDays) }, actorId);
      issued = true;
    } catch (e) {
      error = `The invoice for ${label} was left as a draft — it could not be issued: ${errMsg(e)}`;
    }
    if (issued) {
      const sent = await emailInvoice(invoiceId, { actorId, manual: true }).catch((e) => ({ sent: false, skipped: errMsg(e) }));
      emailed = sent.sent;
      if (!sent.sent) error = `Issued, but not emailed: ${"skipped" in sent && sent.skipped ? sent.skipped : "the email could not be sent"}`;
    }
  }
  await prisma.salesRecurringInvoice.update({ where: { id }, data: { lastInvoiceId: invoiceId, lastError: error ? error.slice(0, 500) : null } });
  await logSalesEvent(prisma, {
    entityType: "recurring", entityId: id, actorId, action: "billed",
    note: `${label}: ${issued ? "issued" : "draft"} invoice${emailed ? " emailed" : ""}${error ? ` — ${error}` : ""}`.slice(0, 500),
  });
  return { ...base, period, invoiceId, issued, emailed, error };
}

/** "Run now": bill the next period immediately, whatever its date. */
export async function runRecurringNow(id: string, actorId: string) {
  const r = await prisma.salesRecurringInvoice.findUnique({ where: { id }, select: { status: true } });
  if (!r) throw new AppError(404, "NOT_FOUND", "Recurring invoice not found");
  if (r.status !== "active") throw new AppError(409, "BAD_TRANSITION", `A ${r.status} recurring invoice cannot be run — resume it first`);
  const result = await runRecurringOnce(id, { actorId });
  if (result.skipped) throw new AppError(409, "RECURRING_BUSY", `Nothing was billed: ${result.skipped}`);
  return { result, recurring: await getRecurring(id) };
}

/** Every due period of every active template (up to MAX_CATCH_UP per template after an outage). */
export async function runDueRecurring(today = todayIST()): Promise<RecurringRunResult[]> {
  const due = await prisma.salesRecurringInvoice.findMany({
    where: { status: "active", nextRunDate: { lte: dayToDate(today) } },
    orderBy: { nextRunDate: "asc" },
    take: 500,
    select: { id: true },
  });
  const out: RecurringRunResult[] = [];
  for (const { id } of due) {
    for (let i = 0; i < MAX_CATCH_UP; i++) {
      const res = await runRecurringOnce(id, { issueDay: today, onlyIfDue: true });
      out.push(res);
      if (res.skipped || res.error) break;
    }
  }
  return out;
}

let running = false;

/** The daily job body: once per IST day (marker in system_settings), never overlapping. */
export async function runRecurringIfDue(now = new Date()): Promise<{ status: "ran"; results: RecurringRunResult[] } | { status: "skipped"; reason: string }> {
  if (running) return { status: "skipped", reason: "running" };
  running = true; // claimed before the first await
  try {
    const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const marker = await prisma.systemSetting.findUnique({ where: { key: RECURRING_MARKER_KEY } });
    if (marker?.value === today) return { status: "skipped", reason: "done" };
    await prisma.systemSetting.upsert({ where: { key: RECURRING_MARKER_KEY }, create: { key: RECURRING_MARKER_KEY, value: today }, update: { value: today } });
    return { status: "ran", results: await runDueRecurring(today) };
  } finally {
    running = false;
  }
}

/** Wall-clock schedule: every day at 06:30 IST, never at boot. Kill switch SALES_RECURRING_ENABLED=0. */
export function scheduleRecurringInvoices(): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = process.env.SALES_RECURRING_ENABLED === "0";
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      runRecurringIfDue()
        .then((r) => {
          if (r.status === "ran" && r.results.length) {
            const made = r.results.filter((x) => x.invoiceId).length;
            const failed = r.results.filter((x) => x.error).length;
            console.log(`[sales-recurring] ${made} invoice(s) created, ${failed} with a problem`);
          }
        })
        .catch((err) => console.warn("[sales-recurring] failed:", String(err)))
        .finally(arm);
    }, msUntilNextIST(DAILY_TARGET_MIN));
    timer.unref?.();
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
