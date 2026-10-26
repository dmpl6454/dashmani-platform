import { prisma } from "@dashmani/db";
import { financialYear, todayIST } from "@dashmani/shared";
import { dateToDay, dayToDate, istDayOf, istMidnight } from "./common";
import { deriveInvoice, invoiceSummarySelect } from "./invoices.service";

// The sales dashboard: this financial year and this month, from the sales tables only. Every
// figure is a sum over documents that exist — nothing projected, nothing estimated.

function monthRange(day: string): { from: string; to: string } {
  const [y, m] = day.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, to: next };
}

export async function getSalesDashboard() {
  const today = todayIST();
  const fy = financialYear(today);
  const month = monthRange(today);
  const fyStart = dayToDate(fy.startDay);
  const fyEndExclusive = dayToDate(`${Number(fy.endDay.slice(0, 4))}-04-01`);
  const monthStart = dayToDate(month.from);
  const monthEnd = dayToDate(month.to);

  const [issuedFy, openInvoices, paymentsFy, paymentsMonth, quotes, orders, topClientRows, platformRows, recent, allOrders, refundsFy, refundsMonth] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: { kind: "tax_invoice", status: { in: ["issued", "paid"] }, issueDate: { gte: fyStart, lt: fyEndExclusive } },
      select: { totalPaise: true, taxablePaise: true, issueDate: true, clientId: true },
    }),
    prisma.salesInvoice.findMany({ where: { status: "issued" }, select: invoiceSummarySelect }),
    prisma.salesPayment.aggregate({ where: { status: "recorded", paidOn: { gte: fyStart, lt: fyEndExclusive } }, _sum: { amountPaise: true, tdsPaise: true }, _count: true }),
    prisma.salesPayment.aggregate({ where: { status: "recorded", paidOn: { gte: monthStart, lt: monthEnd } }, _sum: { amountPaise: true }, _count: true }),
    prisma.salesQuote.groupBy({ by: ["status"], _count: true, _sum: { totalPaise: true } }),
    prisma.salesOrder.groupBy({ by: ["status"], _count: true, _sum: { totalPaise: true } }),
    prisma.salesInvoice.groupBy({
      by: ["clientId"],
      where: { kind: "tax_invoice", status: { in: ["issued", "paid"] }, issueDate: { gte: fyStart, lt: fyEndExclusive } },
      _sum: { totalPaise: true },
      orderBy: { _sum: { totalPaise: "desc" } },
      take: 5,
    }),
    prisma.salesOrderItem.groupBy({
      by: ["platform"],
      // createdAt is a TIMESTAMP: the financial year starts at 00:00 IST, not 00:00 UTC.
      where: { status: { not: "cancelled" }, order: { status: { in: ["confirmed", "in_progress", "delivered", "closed"] }, createdAt: { gte: istMidnight(fy.startDay), lt: istMidnight(`${Number(fy.endDay.slice(0, 4))}-04-01`) } } },
      _sum: { amountPaise: true },
      _count: true,
    }),
    prisma.salesEvent.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    // Every non-cancelled, non-draft order with its deal day: the "sales by financial year" table.
    prisma.salesOrder.findMany({ where: { status: { in: ["confirmed", "in_progress", "delivered", "closed"] } }, select: { totalPaise: true, startDate: true, createdAt: true, status: true } }),
    prisma.salesRefund.aggregate({ where: { status: "issued", payment: { status: "recorded" }, refundedOn: { gte: fyStart, lt: fyEndExclusive } }, _sum: { amountPaise: true } }),
    prisma.salesRefund.aggregate({ where: { status: "issued", payment: { status: "recorded" }, refundedOn: { gte: monthStart, lt: monthEnd } }, _sum: { amountPaise: true } }),
  ]);

  const clients = topClientRows.length
    ? await prisma.client.findMany({ where: { id: { in: topClientRows.map((r) => r.clientId) } }, select: { id: true, companyName: true, billingProfile: { select: { legalName: true } } } })
    : [];
  const derivedOpen = openInvoices.map((i) => deriveInvoice(i, today));
  const outstanding = derivedOpen.filter((i) => i.kind === "tax_invoice" && ["issued", "partially_paid", "overdue"].includes(i.derivedStatus));
  const overdue = outstanding.filter((i) => i.derivedStatus === "overdue");
  const inMonth = (d: Date | null) => !!d && d >= monthStart && d < monthEnd;
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const quoteOf = (statuses: string[]) => {
    const rows = quotes.filter((q) => statuses.includes(q.status));
    return { count: sum(rows.map((r) => r._count)), totalPaise: sum(rows.map((r) => r._sum.totalPaise ?? 0)) };
  };
  const orderOf = (statuses: string[]) => {
    const rows = orders.filter((o) => statuses.includes(o.status));
    return { count: sum(rows.map((r) => r._count)), totalPaise: sum(rows.map((r) => r._sum.totalPaise ?? 0)) };
  };

  // Labels for the activity feed: the document numbers behind the event rows, in one query per kind.
  const ids = (t: string) => recent.filter((e) => e.entityType === t).map((e) => e.entityId);
  const [qn, on, inn, pn] = await Promise.all([
    ids("quote").length ? prisma.salesQuote.findMany({ where: { id: { in: ids("quote") } }, select: { id: true, number: true, title: true } }) : [],
    ids("order").length ? prisma.salesOrder.findMany({ where: { id: { in: ids("order") } }, select: { id: true, number: true, title: true } }) : [],
    ids("invoice").length ? prisma.salesInvoice.findMany({ where: { id: { in: ids("invoice") } }, select: { id: true, number: true } }) : [],
    ids("payment").length ? prisma.salesPayment.findMany({ where: { id: { in: ids("payment") } }, select: { id: true, number: true } }) : [],
  ]);
  const label = new Map<string, string>();
  for (const r of qn) label.set(`quote:${r.id}`, `${r.number} · ${r.title}`);
  for (const r of on) label.set(`order:${r.id}`, `${r.number} · ${r.title}`);
  for (const r of inn) label.set(`invoice:${r.id}`, r.number ?? "Draft invoice");
  for (const r of pn) label.set(`payment:${r.id}`, r.number);

  const byFyMap = new Map<string, { count: number; totalPaise: number; closedPaise: number }>();
  for (const o of allOrders) {
    // startDate is a DATE (already the IST day); createdAt is a timestamp, read in IST so an order
    // made between 00:00 and 05:30 IST on 1 April counts in the new financial year.
    const day = o.startDate ? dateToDay(o.startDate)! : istDayOf(o.createdAt);
    const label = financialYear(day).label;
    const e = byFyMap.get(label) ?? { count: 0, totalPaise: 0, closedPaise: 0 };
    e.count++; e.totalPaise += o.totalPaise; if (o.status === "closed") e.closedPaise += o.totalPaise;
    byFyMap.set(label, e);
  }
  const ordersByFy = [...byFyMap.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([financialYear, v]) => ({ financialYear, ...v }));

  return {
    today,
    financialYear: fy.label,
    ordersByFy,
    invoicedFyPaise: sum(issuedFy.map((i) => i.totalPaise)),
    invoicedFyCount: issuedFy.length,
    invoicedMonthPaise: sum(issuedFy.filter((i) => inMonth(i.issueDate)).map((i) => i.totalPaise)),
    // Voided receipts never count; refunds paid back in the period come off what was collected.
    collectedFyPaise: (paymentsFy._sum.amountPaise ?? 0) - (refundsFy._sum.amountPaise ?? 0),
    tdsFyPaise: paymentsFy._sum.tdsPaise ?? 0,
    collectedMonthPaise: (paymentsMonth._sum.amountPaise ?? 0) - (refundsMonth._sum.amountPaise ?? 0),
    outstandingPaise: sum(outstanding.map((i) => i.balancePaise)),
    outstandingCount: outstanding.length,
    overduePaise: sum(overdue.map((i) => i.balancePaise)),
    overdueCount: overdue.length,
    openQuotes: quoteOf(["draft", "sent"]),
    acceptedQuotes: quoteOf(["accepted"]),
    activeOrders: orderOf(["confirmed", "in_progress"]),
    deliveredOrders: orderOf(["delivered"]),
    topClients: topClientRows.map((r) => {
      const c = clients.find((x) => x.id === r.clientId);
      return { clientId: r.clientId, name: c?.billingProfile?.legalName ?? c?.companyName ?? "—", invoicedPaise: r._sum.totalPaise ?? 0 };
    }),
    byPlatform: platformRows
      .map((r) => ({ platform: r.platform ?? "custom", lines: r._count, amountPaise: r._sum.amountPaise ?? 0 }))
      .sort((a, b) => b.amountPaise - a.amountPaise),
    recent: recent.map((e) => ({ ...e, label: label.get(`${e.entityType}:${e.entityId}`) ?? null })),
  };
}
