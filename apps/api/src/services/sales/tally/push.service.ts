import dns from "dns";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import { gunzipSync } from "zlib";
import { prisma, Prisma } from "@dashmani/db";
import type { CompanyKey, TallyRunCreateInput } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { inBackground, logSalesEvent, toSafeNumber } from "../common";
import { createTallyRun, getTallyRun, isStale, markSynced, pushRegistry } from "./export.service";
import { lockTallySettings, getTallySettingsRow, tallyPushEnabled, type TallySettings } from "./settings";
import { collectionRequest, importEnvelope, LEDGERS_FETCH, VOUCHERS_FETCH } from "./xml";
import { messageBlocks, parseCollection, parseImportResponse, TallyReadError, type TallyLedgerRow, type TallyVoucherRow } from "./xml-read";
import { tdsLedgerName } from "./vouchers";

// Send to Tally (spec-tally §4.13): the frozen XML POSTed one voucher per request to Tally's HTTP
// port on a private network. Off unless SALES_TALLY_PUSH_ENABLED=1. Tally is read first (company
// open, vouchers, ledgers) so nothing is created twice; NO database transaction is ever held across
// an HTTP call; a module-level registry plus the "pushing" status keep one worker per run.

// ── URL guard ─────────────────────────────────────────────────────────────────────

export interface TallyTarget { url: string; protocol: "http:" | "https:"; host: string; port: number; address: string; family: 4 | 6 }
export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const defaultResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

const refused = (reason: string) =>
  new AppError(422, "TALLY_URL_REFUSED", `That address can't be used for Tally: ${reason}. Use the Tailscale or office-network address of the computer running Tally, port 9000.`);

function v4(a: string): number[] | null {
  const p = a.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}
function classify(address: string): "private" | "loopback" | "refused" {
  const four = v4(address.startsWith("::ffff:") ? address.slice(7) : address);
  if (four) {
    const [a, b] = four;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    return "refused"; // 0/8, 169.254/16, multicast, public
  }
  const x = address.toLowerCase();
  if (x === "::1") return "loopback";
  if (/^fd[0-9a-f]{2}:/.test(x)) return "private";
  return "refused"; // ::, fe80::/10, ff00::/8, public
}
function localAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) out.add(i.address.toLowerCase());
  return out;
}

/** Validate a Tally URL and pin the address the connection will use (closes DNS rebinding). Run at test, push and retry. */
export async function assertTallyTarget(raw: string, resolver: Resolver = defaultResolver): Promise<TallyTarget> {
  let u: URL;
  try { u = new URL(raw); } catch { throw refused("it isn't a valid address"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw refused("only http:// or https://");
  if (u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) throw refused("no user names or paths in the address");
  const port = u.port ? Number(u.port) : 9000;
  if (!(port >= 9000 && port <= 9010)) throw refused("only ports 9000–9010");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: Array<{ address: string; family: number }>;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try { addrs = await resolver(host); } catch { throw refused("the name doesn't resolve"); }
    if (!addrs.length) throw refused("the name doesn't resolve");
  }
  const allowLoop = process.env.SALES_TALLY_ALLOW_LOOPBACK === "1";
  const mine = localAddresses();
  for (const a of addrs) {
    const c = classify(a.address);
    if (c === "loopback") { if (!allowLoop) throw refused("it points at this server"); continue; }
    if (mine.has(a.address.toLowerCase())) throw refused("it points at this server");
    if (c !== "private") throw refused("it is not a private-network address");
  }
  return { url: raw, protocol: u.protocol as "http:" | "https:", host, port, address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 };
}

// ── Transport ─────────────────────────────────────────────────────────────────────

export type TransportResult =
  | { ok: true; status: number; body: string }
  | { ok: false; kind: "NOT_SENT" | "NO_ANSWER" | "TOO_LARGE" | "BAD_RESPONSE"; status?: number; message: string };
export interface TallyTransport { send(t: TallyTarget, body: string | null, o: { maxBytes: number; timeoutMs: number }): Promise<TransportResult> }

const IMPORT_CAP = 1 << 20;
const COLLECTION_CAP = 8 << 20;
export const tallyTimeoutMs = () => { const n = Number(process.env.SALES_TALLY_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 20_000; };

const realTransport: TallyTransport = {
  send(t, body, o) {
    return new Promise((resolve) => {
      let flushed = false;
      let done = false;
      const finish = (r: TransportResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const mod = t.protocol === "https:" ? https : http;
      const payload = body === null ? null : Buffer.from(body, "utf8");
      const req = mod.request({
        host: t.address, family: t.family, port: t.port, path: "/", method: payload ? "POST" : "GET", agent: false,
        ...(t.protocol === "https:" ? { servername: net.isIP(t.host) ? undefined : t.host } : {}),
        headers: { Host: `${t.host}:${t.port}`, Connection: "close", ...(payload ? { "Content-Type": "text/xml; charset=utf-8", "Content-Length": String(payload.length) } : {}) },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { res.destroy(); return finish({ ok: false, kind: "BAD_RESPONSE", status, message: `HTTP ${status} redirect` }); }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) { res.destroy(); finish({ ok: false, kind: "TOO_LARGE", message: "the reply was too large" }); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) finish({ ok: false, kind: "BAD_RESPONSE", status, message: `HTTP ${status}` });
          else finish({ ok: true, status, body: text });
        });
        res.on("error", () => finish({ ok: false, kind: "NO_ANSWER", message: "the connection dropped" }));
      });
      const timer = setTimeout(() => { req.destroy(); finish({ ok: false, kind: flushed ? "NO_ANSWER" : "NOT_SENT", message: "timed out" }); }, o.timeoutMs);
      req.on("finish", () => { flushed = true; });
      req.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, kind: flushed ? "NO_ANSWER" : "NOT_SENT", message: e.code ?? e.message }));
      if (payload) req.end(payload); else req.end();
    });
  },
};
let transport: TallyTransport = realTransport;
/** Tests swap in a fake Tally (mirrors setIrpProviderForTests). undefined restores the real one. */
export function setTallyTransportForTests(t: TallyTransport | undefined) { transport = t ?? realTransport; }

function transportError(r: Extract<TransportResult, { ok: false }>, t: TallyTarget): AppError {
  if (r.kind === "NOT_SENT") return new AppError(502, "TALLY_UNREACHABLE", `Couldn't reach Tally at ${t.host}:${t.port} (${r.message}). Is Tally open with the company loaded, and is that computer online?`);
  if (r.kind === "NO_ANSWER" && r.message === "timed out") return new AppError(504, "TALLY_TIMEOUT", `Tally didn't answer within ${Math.round(tallyTimeoutMs() / 1000)} seconds.`);
  if (r.kind === "NO_ANSWER") return new AppError(502, "TALLY_UNREACHABLE", `Couldn't reach Tally at ${t.host}:${t.port} (${r.message}). Is Tally open with the company loaded, and is that computer online?`);
  return new AppError(502, "TALLY_BAD_RESPONSE", `Tally answered with something that isn't a Tally reply ("${r.message.slice(0, 120)}"). Check the address points at Tally's port.`);
}
const badReply = (body: string) => new AppError(502, "TALLY_BAD_RESPONSE", `Tally answered with something that isn't a Tally reply ("${body.slice(0, 120)}"). Check the address points at Tally's port.`);

async function collection<T extends "companies" | "ledgers" | "vouchers">(t: TallyTarget, kind: T, company: string | null, range?: { from: string; to: string }) {
  const req = kind === "companies" ? collectionRequest({ id: "DshCompanies", type: "Company", fetch: "Name" })
    : kind === "ledgers" ? collectionRequest({ id: "DshLedgers", type: "Ledger", fetch: LEDGERS_FETCH, company })
    : collectionRequest({ id: "DshVouchers", type: "Voucher", fetch: VOUCHERS_FETCH, company, from: range!.from, to: range!.to });
  const r = await transport.send(t, req, { maxBytes: COLLECTION_CAP, timeoutMs: tallyTimeoutMs() });
  if (!r.ok) throw transportError(r, t);
  if (r.body.indexOf("Could not set 'SVCurrentCompany'") >= 0 || r.body.indexOf("Could not set &apos;SVCurrentCompany&apos;") >= 0) {
    throw new AppError(409, "TALLY_COMPANY_NOT_OPEN", `Tally is running, but "${company}" isn't open in it. Open it in Tally and try again.`);
  }
  try {
    return parseCollection(r.body, kind as never) as T extends "companies" ? string[] : T extends "ledgers" ? TallyLedgerRow[] : TallyVoucherRow[];
  } catch {
    throw badReply(r.body);
  }
}

// ── Gates ─────────────────────────────────────────────────────────────────────────

export function assertPushEnabled() {
  if (!tallyPushEnabled()) throw new AppError(503, "TALLY_PUSH_OFF", "Sending straight to Tally is switched off on the server. Download the file instead.");
}
async function targetFor(company: CompanyKey): Promise<{ target: TallyTarget; settings: TallySettings }> {
  assertPushEnabled();
  const row = await getTallySettingsRow(company);
  if (!row?.settings.pushUrl) throw new AppError(409, "TALLY_URL_MISSING", "Save Tally's address (e.g. http://100.101.102.103:9000) in Tally settings first — or download the file.");
  return { target: await assertTallyTarget(row.settings.pushUrl), settings: row.settings };
}

const companiesOf = (s: TallySettings) => [...new Set(s.registrations.map((r) => r.tallyCompany))];
function accountLedgerNames(s: TallySettings, day: string) {
  const out: Array<{ role: string; name: string }> = [];
  s.salesLedgers.forEach((l) => out.push({ role: `sales ${l.sac} @ ${l.gstRateBp / 100}%`, name: l.name }));
  out.push({ role: "Output CGST", name: s.ledgers.outputCgst }, { role: "Output SGST", name: s.ledgers.outputSgst }, { role: "Output IGST", name: s.ledgers.outputIgst });
  out.push({ role: "Round off", name: s.ledgers.roundOff }, { role: "TDS", name: tdsLedgerName(s.ledgers.tdsReceivable, day) });
  for (const [role, name] of [["Bank", s.ledgers.bank], ["Cash", s.ledgers.cash], ["Razorpay", s.ledgers.gateway], ["Other receipts", s.ledgers.other], ["Export / SEZ sales", s.ledgers.zeroRatedSales]] as const) {
    if (name) out.push({ role, name });
  }
  return out;
}

export async function testTallyConnection(company: CompanyKey) {
  const { target, settings } = await targetFor(company);
  const started = Date.now();
  const hello = await transport.send(target, null, { maxBytes: 64 * 1024, timeoutMs: Math.min(5_000, tallyTimeoutMs()) });
  if (!hello.ok) throw transportError(hello, target);
  const latencyMs = Date.now() - started;
  const open = await collection(target, "companies", null);
  const configured = companiesOf(settings);
  const lower = new Set(open.map((c) => c.toLowerCase()));
  const missingCompanies = configured.filter((c) => !lower.has(c.toLowerCase()));
  const ledgers: Array<{ role: string; name: string; found: boolean }> = [];
  for (const c of configured.filter((x) => lower.has(x.toLowerCase()))) {
    const names = new Set((await collection(target, "ledgers", c)).map((l) => l.name.toLowerCase()));
    for (const l of accountLedgerNames(settings, new Date().toISOString().slice(0, 10))) ledgers.push({ ...l, found: names.has(l.name.toLowerCase()) });
  }
  return { reachable: true as const, latencyMs, server: hello.body.trim().slice(0, 200), openCompanies: open, missingCompanies, ledgers };
}

/** Tally's ledger list for "Match from Tally → Read from Tally now". */
export async function readTallyLedgers(company: CompanyKey): Promise<TallyLedgerRow[]> {
  const { target, settings } = await targetFor(company);
  const out: TallyLedgerRow[] = [];
  for (const c of companiesOf(settings)) out.push(...(await collection(target, "ledgers", c)));
  return out;
}

// ── Start / retry / close ─────────────────────────────────────────────────────────

export async function startTallyPush(body: TallyRunCreateInput, actorId: string) {
  const { target } = await targetFor(body.companyKey);
  const run = await createTallyRun(body, "push", actorId, { pushTarget: `${target.host}:${target.port}` });
  inBackground(`tally push #${run.runNo}`, () => runTallyPush(run.id));
  return run;
}

export async function retryTallyPush(id: string, actorId: string) {
  assertPushEnabled();
  await prisma.$transaction(async (tx) => {
    const owner = await tx.salesTallyRun.findUnique({ where: { id }, select: { companyKey: true } });
    if (!owner) throw new AppError(404, "NOT_FOUND", "Export not found");
    await lockTallySettings(tx, owner.companyKey as CompanyKey, false);
    await tx.$queryRaw`SELECT id FROM sales_tally_runs WHERE id = ${id} FOR UPDATE`;
    const r = (await tx.salesTallyRun.findUnique({ where: { id } }))!;
    const stale = isStale(r);
    if (r.channel !== "push" || !(r.status === "partial" || stale)) throw new AppError(409, "TALLY_RUN_STATE", `Export #${r.runNo} is ${r.status}; it can't be retried.`);
    if (stale) {
      await tx.salesTallyItem.updateMany({ where: { runId: id, outcome: "sending" }, data: { outcome: "unknown" } });
      await tx.salesTallyRun.update({ where: { id }, data: { status: "partial" } });
    }
    await logSalesEvent(tx, { entityType: "tally_run", entityId: id, actorId, action: "push_started", fromStatus: r.status, toStatus: "pushing", note: stale ? "Resumed after the server restarted" : "Retry" });
  });
  const run = await getTallyRun(id);
  inBackground(`tally push #${run.runNo} (retry)`, () => runTallyPush(id));
  return run;
}

export async function closeTallyRun(id: string, reason: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const owner = await tx.salesTallyRun.findUnique({ where: { id }, select: { companyKey: true } });
    if (!owner) throw new AppError(404, "NOT_FOUND", "Export not found");
    await lockTallySettings(tx, owner.companyKey as CompanyKey, false);
    await tx.$queryRaw`SELECT id FROM sales_tally_runs WHERE id = ${id} FOR UPDATE`;
    const r = (await tx.salesTallyRun.findUnique({ where: { id } }))!;
    if (r.channel !== "push" || !(r.status === "partial" || isStale(r))) throw new AppError(409, "TALLY_RUN_STATE", `Export #${r.runNo} is ${r.status}; it can't be closed.`);
    await tx.salesTallyItem.updateMany({ where: { runId: id, outcome: { in: ["pending", "sending", "failed", "unknown"] } }, data: { outcome: "superseded" } });
    const run = await tx.salesTallyRun.update({ where: { id }, data: { status: "closed", statusNote: reason, closedAt: new Date(), closedById: actorId } });
    await markSynced(tx, run, actorId);
    await logSalesEvent(tx, { entityType: "tally_run", entityId: id, actorId, action: "closed", fromStatus: r.status, toStatus: "closed", note: reason });
  }, { timeout: 30_000 });
  return getTallyRun(id);
}

// ── The worker ────────────────────────────────────────────────────────────────────

type PushPlan = { items: Record<string, { party: string; ledgers: string[]; dependsOn: string[]; altCreate?: string }> };
const absPaise = (n: number | null) => (n === null ? null : Math.abs(n));

async function setPartial(id: string, patch: Record<string, unknown>, note: string) {
  const r = await prisma.salesTallyRun.findUnique({ where: { id }, select: { pushResult: true } });
  const prev = (r?.pushResult ?? {}) as Record<string, unknown>;
  await prisma.salesTallyRun.update({ where: { id }, data: { status: "partial", pushResult: { ...prev, ...patch, finishedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
  await logSalesEvent(prisma, { entityType: "tally_run", entityId: id, actorId: "system", action: "push_partial", fromStatus: "pushing", toStatus: "partial", note });
}

/** One pass over a push run (spec §4.13 steps 1–6). Runs in the background; never throws. */
export async function runTallyPush(id: string): Promise<void> {
  const claimed = await prisma.salesTallyRun.updateMany({ where: { id, status: { in: ["queued", "partial"] } }, data: { status: "pushing" } });
  if (!claimed.count) return;
  pushRegistry.add(id);
  try {
    const run = (await prisma.salesTallyRun.findUnique({ where: { id } }))!;
    const company = run.companyKey as CompanyKey;
    const prev = (run.pushResult ?? {}) as Record<string, unknown>;
    const plan = (prev.plan ?? { items: {} }) as PushPlan;
    await prisma.salesTallyRun.update({ where: { id }, data: { pushResult: { ...prev, error: null, startedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
    let target: TallyTarget;
    let settings: TallySettings;
    try {
      ({ target, settings } = await targetFor(company));
    } catch (e) {
      return void (await setPartial(id, { error: (e as Error).message }, "Couldn't start the send"));
    }

    // 2. Company open?
    let open: string[];
    try { open = await collection(target, "companies", null); } catch (e) { return void (await setPartial(id, { error: (e as Error).message }, "Tally not reachable — nothing was sent")); }
    if (!open.some((c) => c.toLowerCase() === run.tallyCompany.toLowerCase())) {
      return void (await setPartial(id, { error: `Tally is running, but "${run.tallyCompany}" isn't open in it (open: ${open.join(", ") || "none"}). Open it in Tally and try again.` }, "Company not open in Tally"));
    }

    // 3. Pre-flight read: vouchers over the items' dates, and ledgers. Nothing is ever sent without it.
    const pending = await prisma.salesTallyItem.findMany({ where: { runId: id, outcome: { in: ["pending", "failed", "unknown", "sending"] } } });
    const vouchersXml = gunzipSync(Buffer.from(run.vouchersXmlGz!)).toString("ascii");
    const order = messageBlocks(vouchersXml);
    const position = new Map(order.map((b, i) => [b.key, i]));
    const keyOf = (i: { action: string; voucherType: string; docNumber: string; remoteId: string }) => (i.action === "cancel" ? `cancel:${i.voucherType}:${i.docNumber}` : i.remoteId);
    const rawOf = new Map(order.map((b) => [b.key, b.raw]));
    pending.sort((a, b) => (position.get(keyOf(a)) ?? 0) - (position.get(keyOf(b)) ?? 0));
    let tallyVouchers: TallyVoucherRow[] = [];
    let tallyLedgers: TallyLedgerRow[] = [];
    try {
      if (pending.length) {
        const days = pending.map((p) => p.docDate.toISOString().slice(0, 10)).sort();
        tallyVouchers = await collection(target, "vouchers", run.tallyCompany, { from: days[0], to: days[days.length - 1] });
      }
      tallyLedgers = await collection(target, "ledgers", run.tallyCompany);
    } catch {
      return void (await setPartial(id, { error: "Couldn't read Tally's vouchers — nothing was sent." }, "Pre-flight read failed — nothing was sent"));
    }
    const byRemote = new Map(tallyVouchers.filter((v) => v.remoteId).map((v) => [v.remoteId!, v]));
    const byNumber = new Map(tallyVouchers.map((v) => [`${v.type.toLowerCase()}|${v.number.toLowerCase()}`, v]));
    const ledgerByName = new Map(tallyLedgers.map((l) => [l.name.toLowerCase(), l]));

    // Last good party amount per document from EARLIER runs (alter / cancel guard, I5).
    const ids = pending.map((p) => p.docId);
    const lastRows = ids.length ? await prisma.$queryRaw<Array<{ doc_id: string; party_amount_paise: bigint }>>`
      SELECT DISTINCT ON (doc_id) doc_id, party_amount_paise FROM sales_tally_items
      WHERE company_key = ${company} AND doc_id = ANY(${ids}::text[]) AND run_id <> ${id} AND outcome IN ('synced', 'adopted')
      ORDER BY doc_id, resolved_at DESC NULLS LAST` : [];
    const lastAmount = new Map(lastRows.map((r) => [r.doc_id, toSafeNumber(r.party_amount_paise)]));

    // Party ledgers: adopt existing ones, refuse one that carries another GSTIN.
    const mappings = await prisma.salesTallyParty.findMany({ where: { companyKey: company } });
    const mapByName = new Map(mappings.map((m) => [m.ledgerName.toLowerCase(), m]));
    const conflicted = new Set<string>();
    for (const party of new Set(Object.values(plan.items).map((x) => x.party.toLowerCase()))) {
      const inTally = ledgerByName.get(party);
      const m = mapByName.get(party);
      if (!inTally || !m) continue;
      if (inTally.gstin && m.gstin && inTally.gstin !== m.gstin) conflicted.add(party);
      else if (!m.existsInTally) await prisma.salesTallyParty.update({ where: { id: m.id }, data: { existsInTally: true } });
    }

    // 4. Masters: every needed ledger Tally does not have yet.
    if (run.mastersXmlGz) {
      const mastersXml = gunzipSync(Buffer.from(run.mastersXmlGz)).toString("ascii");
      const missing = messageBlocks(mastersXml).filter((b) => b.key.startsWith("ledger:") && !ledgerByName.has(b.key.slice(7).toLowerCase()));
      if (missing.length) {
        const r = await transport.send(target, importEnvelope("All Masters", run.tallyCompany, missing.map((b) => b.raw)), { maxBytes: IMPORT_CAP, timeoutMs: tallyTimeoutMs() });
        let parsed: ReturnType<typeof parseImportResponse> | null = null;
        let err: string | null = null;
        if (!r.ok) err = transportError(r, target).message;
        else { try { parsed = parseImportResponse(r.body); } catch (e) { err = (e as Error).message; } }
        if (err || !parsed || parsed.errors > 0 || parsed.exceptions > 0) {
          return void (await setPartial(id, { masters: parsed, error: err ?? `Tally refused the new ledgers: ${parsed?.lineErrors.join(" · ") || "see Tally's import log"}` }, "Ledgers failed — no voucher sent"));
        }
        for (const b of missing) ledgerByName.set(b.key.slice(7).toLowerCase(), { name: b.key.slice(7), parent: null, gstin: null });
        await prisma.salesTallyRun.update({ where: { id }, data: { pushResult: { ...prev, masters: parsed, error: null } as unknown as Prisma.InputJsonValue } });
      }
    }

    // 5. One POST per voucher, in file order.
    const outcomes = new Map((await prisma.salesTallyItem.findMany({ where: { runId: id }, select: { docId: true, outcome: true } })).map((i) => [i.docId, i.outcome]));
    let consecutive = 0;
    for (const item of pending) {
      const info = plan.items[item.docId] ?? { party: "", ledgers: [], dependsOn: [] };
      const record = async (outcome: string, data: { issueCode?: string | null; error?: string | null; tallyVchId?: string | null } = {}) => {
        outcomes.set(item.docId, outcome);
        await prisma.salesTallyItem.update({
          where: { id: item.id },
          data: { outcome, issueCode: data.issueCode ?? null, error: data.error ?? null, ...(data.tallyVchId ? { tallyVchId: data.tallyVchId.slice(0, 32) } : {}), ...(outcome === "synced" || outcome === "adopted" ? { resolvedAt: new Date() } : {}) },
        });
        await prisma.salesTallyRun.update({ where: { id }, data: { updatedAt: new Date() } });
      };
      const claim = await prisma.salesTallyItem.updateMany({ where: { id: item.id, outcome: { in: ["pending", "failed", "unknown", "sending"] } }, data: { outcome: "sending", attempts: { increment: 1 } } });
      if (!claim.count) continue;
      const deps = info.dependsOn.filter((d) => !["synced", "adopted"].includes(outcomes.get(d) ?? "synced"));
      if (deps.length) { await record("failed", { issueCode: "DEPENDS_ON_UNSENT", error: `${item.docNumber} needs a voucher that didn't reach Tally — fix that one first.` }); continue; }
      if (conflicted.has(info.party.toLowerCase())) { await record("failed", { issueCode: "PARTY_LEDGER_CONFLICT", error: `Tally's ledger "${info.party}" carries another client's GSTIN — rename one of them.` }); continue; }
      if (!settings.createAccountLedgers) {
        const gone = info.ledgers.find((l) => !ledgerByName.has(l.toLowerCase()));
        if (gone) { await record("failed", { issueCode: "LEDGER_MISSING", error: `Tally has no ledger '${gone}'` }); continue; }
      }
      const found = byRemote.get(item.remoteId) ?? byNumber.get(`${item.voucherType.toLowerCase()}|${item.docNumber.toLowerCase()}`);
      const ours = toSafeNumber(item.partyAmountPaise);
      const last = lastAmount.get(item.docId) ?? null;
      let raw = rawOf.get(keyOf(item)) ?? null;
      if (item.action === "create" && found) {
        if (found.party?.toLowerCase() === info.party.toLowerCase() && absPaise(found.amountPaise) === ours) await record("adopted", { tallyVchId: found.masterId });
        else await record("failed", { issueCode: "VOUCHER_EXISTS_DIFFERENT", error: `Tally already has ${item.docNumber} with another client or amount` });
        continue;
      }
      if (item.action === "alter") {
        if (found && !(absPaise(found.amountPaise) === last || absPaise(found.amountPaise) === ours)) {
          await record("failed", { issueCode: "EDITED_IN_TALLY", error: `${item.docNumber} was changed in Tally — update it there by hand, then mark it as done` });
          continue;
        }
        if (!found && raw) raw = raw.replace(' ACTION="Alter" ', ' ACTION="Create" '); // Tally lost it: send as Create
      }
      if (item.action === "cancel") {
        if (found?.cancelled) { await record("adopted", { tallyVchId: found.masterId }); continue; }
        if (found && absPaise(found.amountPaise) !== last) { await record("failed", { issueCode: "EDITED_IN_TALLY", error: `${item.docNumber} was changed in Tally — update it there by hand, then mark it as done` }); continue; }
        if (!found) {
          if (item.docType === "receipt" || item.docType === "refund") { await record("adopted"); continue; }
          raw = info.altCreate ?? null;
        }
      }
      if (!raw) { await record("failed", { error: `${item.docNumber}: the voucher is missing from this export's file` }); continue; }
      const r = await transport.send(target, importEnvelope("Vouchers", run.tallyCompany, [raw]), { maxBytes: IMPORT_CAP, timeoutMs: tallyTimeoutMs() });
      if (!r.ok) {
        const err = transportError(r, target).message;
        if (r.kind === "NOT_SENT") { consecutive += 1; await record("failed", { error: err }); }
        else if (r.kind === "NO_ANSWER" || r.kind === "TOO_LARGE") { consecutive += 1; await record("unknown", { error: err }); }
        else { consecutive = 0; await record("failed", { issueCode: "TALLY_BAD_RESPONSE", error: err }); }
        if (consecutive >= 3) { await prisma.salesTallyItem.updateMany({ where: { runId: id, outcome: "sending" }, data: { outcome: "pending" } }); break; }
        continue;
      }
      consecutive = 0;
      let res: ReturnType<typeof parseImportResponse>;
      try { res = parseImportResponse(r.body); } catch (e) {
        await record("failed", { issueCode: e instanceof TallyReadError ? `TALLY_${e.kind}` : "TALLY_BAD_RESPONSE", error: e instanceof TallyReadError && e.kind === "COMPANY_NOT_OPEN" ? `"${run.tallyCompany}" isn't open in Tally` : badReply(r.body).message });
        continue;
      }
      if (res.errors > 0 || res.lineErrors.length) await record("failed", { error: (res.lineErrors.join(" · ") || `Tally reported ${res.errors} error(s)`).slice(0, 1000) });
      else if (res.exceptions > 0) await record("failed", { error: "Tally raised an exception — open Tally's import log" });
      else if (res.created + res.altered + res.cancelled >= 1) await record("synced", { tallyVchId: res.lastVchId });
      else await record("unknown", { error: "Tally ignored the voucher — the next send checks Tally first" });
    }

    // 6. Finish.
    const final = await prisma.salesTallyItem.groupBy({ by: ["outcome"], where: { runId: id }, _count: { _all: true } });
    const c = (o: string) => final.find((f) => f.outcome === o)?._count._all ?? 0;
    const bad = final.filter((f) => !["synced", "adopted", "blocked"].includes(f.outcome)).reduce((s, f) => s + f._count._all, 0);
    const result = { synced: c("synced"), adopted: c("adopted"), failed: c("failed"), unknown: c("unknown") + c("pending"), finishedAt: new Date().toISOString() };
    const latest = ((await prisma.salesTallyRun.findUnique({ where: { id }, select: { pushResult: true } }))?.pushResult ?? {}) as Record<string, unknown>;
    if (!bad) {
      await prisma.$transaction(async (tx) => {
        const done = await tx.salesTallyRun.update({ where: { id }, data: { status: "pushed", closedAt: new Date(), pushResult: { ...latest, ...result, error: null } as Prisma.InputJsonValue } });
        await markSynced(tx, done, "system");
        await logSalesEvent(tx, { entityType: "tally_run", entityId: id, actorId: "system", action: "pushed", fromStatus: "pushing", toStatus: "pushed", note: `${result.synced} sent · ${result.adopted} matched · 0 failed` });
      }, { timeout: 30_000 });
    } else {
      await prisma.salesTallyRun.update({ where: { id }, data: { status: "partial", pushResult: { ...latest, ...result } as Prisma.InputJsonValue } });
      await logSalesEvent(prisma, { entityType: "tally_run", entityId: id, actorId: "system", action: "push_partial", fromStatus: "pushing", toStatus: "partial", note: `${result.synced} sent · ${result.adopted} matched · ${result.failed} failed · ${result.unknown} waiting` });
    }
  } catch (e) {
    console.error(`[tally] push ${id} failed`, e);
    await setPartial(id, { error: "The send stopped on a server error — retry it; Tally is checked first, so nothing is sent twice." }, "Send stopped").catch(() => undefined);
  } finally {
    pushRegistry.delete(id);
  }
}


