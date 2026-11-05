import { prisma, Prisma } from "@dashmani/db";
import { AppError } from "../../../middleware/error-handler";
import { logSalesEvent, type Tx } from "../common";

// Who a TAN is (spec-reconcile D7, §6.6). A TAN lives in EXACTLY one place: the client's first TAN
// on client_billing_profiles.tan; a client's second TAN, a client without a billing profile and
// non-sales deductors (bank interest, a tenant) in sales_tds_deductors. setTan() is the ONLY
// writer of either; "a TAN belongs to one deductor" is enforced here (and by both unique indexes).

export type TanSource = "profile" | "manual" | "auto";

export interface SetTanInput {
  tan: string;
  /** kind client: whose TAN it is. non_sales: null. */
  clientId: string | null;
  kind: "client" | "non_sales";
  label?: string | null;
  nameSeen?: string | null;
  source: TanSource;
  actorId: string;
  /** Event note for an automatic learning ("MUMF12345A from Form 26AS 2025-26 — same name, TDS fits …"). */
  note?: string | null;
}

export interface SetTanResult { changed: boolean; where: "profile" | "deductors"; skipped?: boolean }

async function lockTan(tx: Tx, tan: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${"tan:" + tan}))`);
}

const poss = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

async function clientName(tx: Tx, clientId: string | null): Promise<string> {
  if (!clientId) return "another deductor";
  const c = await tx.client.findUnique({ where: { id: clientId }, select: { companyName: true } });
  return c?.companyName ?? "another client";
}

async function taken(tx: Tx, tan: string, holder: { clientId: string | null; label?: string | null }): Promise<AppError> {
  const who = holder.clientId ? `${poss(await clientName(tx, holder.clientId))} TAN` : `marked as ${holder.label ?? "not a sales client"}`;
  return new AppError(409, "TAN_TAKEN", `${tan} is already ${who} — a TAN belongs to one deductor.`);
}

/**
 * Map a TAN. Runs in the caller's transaction under an advisory lock on the TAN.
 *  - another client's profile holds it, or a deductors row maps it elsewhere → TAN_TAKEN
 *    (source "auto": skipped silently, nothing written);
 *  - kind client, the client's profile exists with tan NULL → set it there (any deductors row of
 *    this TAN for the same client moves onto the profile);
 *  - the profile already holds this TAN → no-op;
 *  - otherwise → a deductors row (kind client: a second TAN, or no profile; kind non_sales).
 */
export async function setTan(tx: Tx, input: SetTanInput): Promise<SetTanResult> {
  const tan = input.tan.trim().toUpperCase();
  await lockTan(tx, tan);
  const holder = await tx.clientBillingProfile.findUnique({ where: { tan }, select: { clientId: true } });
  const row = await tx.salesTdsDeductor.findUnique({ where: { tan } });

  if (input.kind === "non_sales") {
    if (holder) {
      if (input.source === "auto") return { changed: false, where: "profile", skipped: true };
      throw await taken(tx, tan, { clientId: holder.clientId });
    }
    if (row && row.kind === "client") {
      if (input.source === "auto") return { changed: false, where: "deductors", skipped: true };
      throw await taken(tx, tan, { clientId: row.clientId });
    }
    const label = input.label ?? null;
    if (row && row.kind === "non_sales" && row.label === label) return { changed: false, where: "deductors" };
    await tx.salesTdsDeductor.upsert({
      where: { tan },
      create: { tan, kind: "non_sales", clientId: null, label, nameSeen: input.nameSeen ?? null, source: input.source === "auto" ? "auto" : "manual", createdById: input.actorId },
      update: { kind: "non_sales", clientId: null, label, nameSeen: input.nameSeen ?? row?.nameSeen ?? null, source: input.source === "auto" ? "auto" : "manual" },
    });
    await logSalesEvent(tx, { entityType: "tds_deductor", entityId: tan, actorId: input.actorId, action: "marked_non_sales", note: `${tan} · ${label ?? ""}`.slice(0, 500) });
    return { changed: true, where: "deductors" };
  }

  const clientId = input.clientId;
  if (!clientId) throw new AppError(400, "VALIDATION_ERROR", "Pick the client this TAN belongs to");
  if (holder && holder.clientId !== clientId) {
    if (input.source === "auto") return { changed: false, where: "profile", skipped: true };
    throw await taken(tx, tan, { clientId: holder.clientId });
  }
  if (holder && holder.clientId === clientId) return { changed: false, where: "profile" };
  if (row && (row.kind !== "client" || row.clientId !== clientId)) {
    if (input.source === "auto") return { changed: false, where: "deductors", skipped: true };
    throw await taken(tx, tan, { clientId: row.clientId, label: row.label });
  }

  const profile = await tx.clientBillingProfile.findUnique({ where: { clientId }, select: { tan: true } });
  if (profile && (profile.tan === null || input.source === "profile")) {
    // The profile's first TAN (or a billing save naming a new TAN: the old one is forgotten).
    await tx.clientBillingProfile.update({ where: { clientId }, data: { tan } });
    if (row) await tx.salesTdsDeductor.delete({ where: { tan } });
    await logTan(tx, input, tan, clientId, "profile");
    return { changed: true, where: "profile" };
  }
  if (row) return { changed: false, where: "deductors" };
  await tx.salesTdsDeductor.create({
    data: { tan, kind: "client", clientId, label: null, nameSeen: input.nameSeen ?? null, source: input.source === "auto" ? "auto" : "manual", createdById: input.actorId },
  });
  await logTan(tx, input, tan, clientId, "deductors");
  return { changed: true, where: "deductors" };
}

async function logTan(tx: Tx, input: SetTanInput, tan: string, clientId: string, where: "profile" | "deductors") {
  if (input.source === "auto") {
    await logSalesEvent(tx, { entityType: "client", entityId: clientId, actorId: input.actorId, action: "tan_learned", note: (input.note ?? `${tan} from Form 26AS`).slice(0, 500) });
  } else if (input.source === "manual") {
    await logSalesEvent(tx, { entityType: "tds_deductor", entityId: tan, actorId: input.actorId, action: "mapped", note: `${tan} → ${await clientName(tx, clientId)} (${where === "profile" ? "billing profile" : "extra TAN"})` });
  }
}

/** Clear a client's profile TAN (billing save with tan: null). The TAN is forgotten; a later upload proposes again. */
export async function clearProfileTan(tx: Tx, clientId: string): Promise<void> {
  await tx.clientBillingProfile.updateMany({ where: { clientId, tan: { not: null } }, data: { tan: null } });
}

/** Remove a deductors-table mapping. A profile TAN is changed on the client instead (TAN_FROM_PROFILE). */
export async function unmapDeductor(tanIn: string, actorId: string): Promise<{ removed: true }> {
  const tan = tanIn.trim().toUpperCase();
  return prisma.$transaction(async (tx) => {
    await lockTan(tx, tan);
    const holder = await tx.clientBillingProfile.findUnique({ where: { tan }, select: { clientId: true } });
    if (holder) throw new AppError(409, "TAN_FROM_PROFILE", `This TAN is on ${poss(await clientName(tx, holder.clientId))} billing profile — change it there.`);
    const row = await tx.salesTdsDeductor.findUnique({ where: { tan } });
    if (!row) throw new AppError(404, "NOT_FOUND", `${tan} is not mapped to anyone.`);
    await tx.salesTdsDeductor.delete({ where: { tan } });
    await logSalesEvent(tx, { entityType: "tds_deductor", entityId: tan, actorId, action: "unmapped", note: row.clientId ? `was ${await clientName(tx, row.clientId)}` : `was ${row.label ?? "not a sales client"}` });
    return { removed: true as const };
  });
}

/** PUT /sales/reconcile/tds/deductors/:tan — map a TAN by hand. */
export async function mapDeductor(tanIn: string, body: { kind: "client" | "non_sales"; clientId: string | null; label?: string | null; nameSeen?: string | null }, actorId: string): Promise<SetTanResult> {
  if (body.kind === "client" && body.clientId) {
    const c = await prisma.client.findUnique({ where: { id: body.clientId }, select: { id: true } });
    if (!c) throw new AppError(404, "NOT_FOUND", "Client not found");
  }
  return prisma.$transaction((tx) => setTan(tx, { tan: tanIn, clientId: body.kind === "client" ? body.clientId : null, kind: body.kind, label: body.label ?? null, nameSeen: body.nameSeen ?? null, source: "manual", actorId }));
}

/** Every TAN mapping that names one of these TANs: profile TANs and deductors rows. */
export async function loadTanMappings(tans: string[]) {
  if (!tans.length) return { profiles: [] as Array<{ tan: string; clientId: string }>, deductors: [] as Array<{ tan: string; kind: string; clientId: string | null; label: string | null; source: string }> };
  const [profiles, deductors] = await Promise.all([
    prisma.clientBillingProfile.findMany({ where: { tan: { in: tans } }, select: { tan: true, clientId: true } }),
    prisma.salesTdsDeductor.findMany({ where: { tan: { in: tans } }, select: { tan: true, kind: true, clientId: true, label: true, source: true } }),
  ]);
  return { profiles: profiles.map((p) => ({ tan: p.tan!, clientId: p.clientId })), deductors };
}
