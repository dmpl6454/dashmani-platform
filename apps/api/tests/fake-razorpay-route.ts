/**
 * A fake of Razorpay's Route linked-account API for the payout tests (no network).
 *
 * It keeps REAL state, so the properties the production code relies on are exercised rather than
 * assumed: one account per email (a second create answers "Merchant email already exists for account
 * - X" [R5]), one stakeholder per account, one Route product per account. And it ECHOES what it was
 * given back, the way Razorpay does (the PAN on the stakeholder, the account number and IFSC on the
 * product, the name and address on the account), so a test can prove none of it survives parsing.
 *
 * Failures are scripted per call with intercept(): an answer that is refused outright (nothing
 * changed), one that was APPLIED but whose answer was lost (a dropped connection, a 502, an unreadable
 * 2xx), one that NEVER reached Razorpay ("drop"), or one held open until a test lets it go (to overlap
 * two requests deterministically).
 *
 * ── The money leg (Phase 4) ─────────────────────────────────────────────────────
 * The /v1 side is a faithful STATEFUL model of payments, transfers, holds, reversals, settlements and
 * disputes, so the engine's properties are exercised against behaviour, not against canned answers:
 *   • a transfer is created on a captured payment only, never once a refund exists on it [R4], and never
 *     for more than the payment captured; its status after creation is `createStatus` (the docs' sample
 *     says pending);
 *   • PATCH on_hold flips the hold; re-holding a transfer that already settled is refused unless
 *     allowRehold (plan question d is UNVERIFIED, so both worlds are testable);
 *   • reversal amount arithmetic is Razorpay's: more than what is left is refused, an omitted amount
 *     reverses everything left (a test asserts our client never sends that), and a reversal of money that
 *     already settled to the linked account's bank needs a floating balance;
 *   • a settlement is driven by the test (settleTransfer) and shows up on the transfer, expanded or not,
 *     with its UTR; one settlement can batch several transfers (its amount is the batch amount, as in
 *     the docs);
 *   • the transfer list can hide a just-created transfer for the first N listings (an unknown create
 *     result whose transfer only appears later), and its paging can be dishonest (default page size, or
 *     skip ignored) to prove the client does not trust a short page.
 * Every call, with its query string, is recorded in `calls`.
 */
import { razorpayHttp } from "../src/services/campaign/razorpay";

export interface FakeCall {
  method: string;
  /** The path after /v2, e.g. /accounts/acc_X/products/acc_prd_Y. A /v1 path keeps its prefix: /v1/transfers/trf_X. */
  path: string;
  body: any;
  /** The query string, decoded (`expand[]` keeps its brackets). */
  query: Record<string, string>;
  /** The request headers the client sent (the refund idempotency key is one). Never a credential: the client keeps those out of init.headers. */
  headers: Record<string, string>;
}

export interface FakeAccount {
  id: string;
  email: string;
  stakeholder: { id: string; pan: string } | null;
  product: { id: string; status: string; settlements: { account_number: string; ifsc_code: string; beneficiary_name: string } | null; requirements: any[] } | null;
}

export type Mode = "reject" | "lose" | "drop" | "garbage" | "badgateway" | "hold" | "pass";
export interface Rule {
  match: (c: FakeCall) => boolean;
  mode: Mode;
  /** reject only. */
  status?: number;
  body?: unknown;
  times: number;
  /** hold only: the call waits for this before it is applied. */
  gate?: Promise<void>;
  /** A transfer created by this call stays out of the next N transfer listings (it "appears later"). */
  hideFromListings?: number;
  /** A transfer created by this call is changed right after creation (for example created NOT on hold). */
  afterCreate?: (t: FakeTransfer) => void;
  /** Runs when the rule matches, before the call is applied or answered (a test can land something at exactly this point). */
  before?: () => void | Promise<void>;
  /** Let this many matching calls through untouched before the rule starts to apply. */
  skip?: number;
}

export interface FakePayment {
  id: string;
  amount: number;
  status: string;
  refunds: Array<{ id: string; amount: number; status: string }>;
  createdAt: number;
}

export interface FakeTransfer {
  id: string;
  source: string;
  recipient: string;
  amount: number;
  status: string;
  amountReversed: number;
  onHold: boolean;
  onHoldUntil: number | null;
  notes: Record<string, string>;
  settlementId: string | null;
  createdAt: number;
  /** The next N transfer listings do not show it. */
  hidden: number;
}

export interface FakeSettlement {
  id: string;
  status: string;
  utr: string | null;
  fee: number;
  tax: number;
  /** The whole settlement batch, as in Razorpay's own sample (more than one transfer's amount). */
  amount: number;
}

export interface FakeDispute {
  id: string;
  paymentId: string;
  status: string;
  phase: string;
  amount: number;
  createdAt: number;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (description: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ error: { code: "BAD_REQUEST_ERROR", description, source: "business", step: "NA", reason: "input_validation_failed", metadata: {}, ...extra } }, status);

export const is = {
  createAccount: (c: FakeCall) => c.method === "POST" && c.path === "/accounts",
  createStakeholder: (c: FakeCall) => c.method === "POST" && /^\/accounts\/[^/]+\/stakeholders$/.test(c.path),
  createProduct: (c: FakeCall) => c.method === "POST" && /^\/accounts\/[^/]+\/products$/.test(c.path),
  patchSettlement: (c: FakeCall) => c.method === "PATCH" && /^\/accounts\/[^/]+\/products\/[^/]+$/.test(c.path),
  fetchProduct: (c: FakeCall) => c.method === "GET" && /^\/accounts\/[^/]+\/products\/[^/]+$/.test(c.path),
  fetchAccount: (c: FakeCall) => c.method === "GET" && /^\/accounts\/[^/]+$/.test(c.path),
  createTransfer: (c: FakeCall) => c.method === "POST" && /^\/v1\/payments\/[^/]+\/transfers$/.test(c.path),
  listTransfers: (c: FakeCall) => c.method === "GET" && /^\/v1\/payments\/[^/]+\/transfers$/.test(c.path),
  fetchTransfer: (c: FakeCall) => c.method === "GET" && /^\/v1\/transfers\/[^/]+$/.test(c.path),
  patchTransfer: (c: FakeCall) => c.method === "PATCH" && /^\/v1\/transfers\/[^/]+$/.test(c.path),
  setHold: (c: FakeCall, onHold?: boolean) => c.method === "PATCH" && /^\/v1\/transfers\/[^/]+$/.test(c.path) && (onHold === undefined || c.body?.on_hold === onHold),
  createReversal: (c: FakeCall) => c.method === "POST" && /^\/v1\/transfers\/[^/]+\/reversals$/.test(c.path),
  listReversals: (c: FakeCall) => c.method === "GET" && /^\/v1\/transfers\/[^/]+\/reversals$/.test(c.path),
  listDisputes: (c: FakeCall) => c.method === "GET" && c.path === "/v1/disputes",
  refund: (c: FakeCall) => c.method === "POST" && /^\/v1\/payments\/[^/]+\/refund$/.test(c.path),
  fetchPayment: (c: FakeCall) => c.method === "GET" && /^\/v1\/payments\/[^/]+$/.test(c.path),
  /** Anything that can move or change money at Razorpay: every /v1 POST and PATCH. */
  v1Write: (c: FakeCall) => c.path.startsWith("/v1/") && (c.method === "POST" || c.method === "PATCH"),
};

export class FakeRazorpay {
  calls: FakeCall[] = [];
  accounts = new Map<string, FakeAccount>();
  /** What the product reads after the bank details are set. */
  afterBankStatus = "under_review";

  // ── The money leg ──
  payments = new Map<string, FakePayment>();
  transfers = new Map<string, FakeTransfer>();
  reversals = new Map<string, Array<{ id: string; amount: number; notes: Record<string, string>; createdAt: number }>>();
  settlements = new Map<string, FakeSettlement>();
  disputes: FakeDispute[] = [];
  /** The merchant's own balance: a transfer needs it, a reversal returns it. */
  balance = 100_000_000;
  /** What a transfer reads right after creation. The docs' sample says `pending`. */
  createStatus: "pending" | "processed" = "processed";
  /** Whether PATCH on_hold:true works on a transfer that has already settled (plan question d: UNVERIFIED). */
  allowRehold = true;
  /** A released transfer can be re-held only until it settles; this is the same switch for one that was merely released. */
  allowReholdAfterRelease = true;
  /** Linked accounts that are suspended: a transfer to them is refused. */
  suspended = new Set<string>();
  /** A linked account's floating balance, which a reversal of already-settled money draws on. */
  floating = new Map<string, number>();
  /** What a refund reads right after it is made. */
  refundStatus: "processed" | "pending" = "processed";
  /** payment id + idempotency key → the refund it made. */
  refundKeys = new Map<string, { id: string; amount: number; status: string }>();
  /** null: the list honours `count` (up to 100). A number: the endpoint ignores `count` and returns that many (a default page). */
  listPageSize: number | null = null;
  /** false: `skip` is ignored, the same first page comes back every time. */
  honorSkip = true;
  /**
   * ── Concurrency suite only (additive; null = the fake behaves exactly as before) ──
   * Simulated network time per call: `before` = the request is in flight (nothing applied yet, so other work interleaves with it),
   * `after` = it WAS applied and its answer is still on the wire (the window in which a caller does not yet know). The apply step
   * itself stays one synchronous, atomic move, as at Razorpay.
   */
  latency: ((c: FakeCall) => { before?: number; after?: number } | null | undefined) | null = null;
  /**
   * Faults for calls no scripted rule matched (a seeded random workload injects "the answer was lost" this way). Returns a partial
   * Rule (at least `mode`) or null. A scripted intercept() always wins over it.
   */
  chaos: ((c: FakeCall) => (Partial<Rule> & { mode: Mode }) | null | undefined) | null = null;
  /**
   * What was really APPLIED at Razorpay, in the order it happened (calls[] is in the order requests ARRIVED, and a delayed or
   * dropped one makes the two differ). status is the HTTP status of the answer the fake produced, whether or not the caller ever saw it.
   */
  applied: Array<{ call: FakeCall; status: number }> = [];
  private rules: Rule[] = [];
  private n = 0;
  private m = 0;
  private real = razorpayHttp.fetch;

  install() {
    this.real = razorpayHttp.fetch;
    razorpayHttp.fetch = (async (url: any, init: any) => {
      const raw = String(url);
      const u = raw.replace("https://api.razorpay.com/v2", "").replace("https://api.razorpay.com/v1", "/v1");
      const qs = u.includes("?") ? u.slice(u.indexOf("?") + 1) : "";
      const query: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
      const call: FakeCall = { method: init?.method ?? "GET", path: u.split("?")[0], body: init?.body ? JSON.parse(init.body) : null, query, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).filter(([k]) => /idempotency/i.test(k))) };
      this.calls.push(call);
      return this.handle(call);
    }) as typeof fetch;
  }

  restore() {
    razorpayHttp.fetch = this.real;
  }

  /** Forget everything a previous test scripted or stored (rules included: a leftover one would answer the next test's calls). */
  reset() {
    this.calls = [];
    this.accounts.clear();
    this.rules = [];
    this.afterBankStatus = "under_review";
    this.payments.clear();
    this.transfers.clear();
    this.reversals.clear();
    this.settlements.clear();
    this.disputes = [];
    this.balance = 100_000_000;
    this.createStatus = "processed";
    this.allowRehold = true;
    this.allowReholdAfterRelease = true;
    this.suspended.clear();
    this.floating.clear();
    this.listPageSize = null;
    this.honorSkip = true;
    this.refundStatus = "processed";
    this.refundKeys.clear();
    this.latency = null;
    this.chaos = null;
    this.applied = [];
    // The id counters are NOT reset: a test that resets the fake between rows of one table must not mint a transfer id twice.
  }

  intercept(rule: Omit<Rule, "times"> & { times?: number }) {
    this.rules.push({ times: 1, ...rule });
  }

  count(pred: (c: FakeCall) => boolean) {
    return this.calls.filter(pred).length;
  }

  /** The calls Razorpay really ACCEPTED (a 2xx, whether or not the caller ever saw the answer), in the order they happened. */
  appliedOk(pred: (c: FakeCall) => boolean = () => true) {
    return this.applied.filter((a) => a.status >= 200 && a.status < 300 && pred(a.call)).map((a) => a.call);
  }

  /** Every call that could change something at Razorpay on the /v1 side (POST, PATCH). */
  writes() {
    return this.calls.filter(is.v1Write);
  }

  /** Put an account (and optionally its Route product) straight into the fake, as if made earlier. */
  seedAccount(a: { id: string; email: string; productId?: string; status?: string; settlements?: any; requirements?: any[] }) {
    const acc: FakeAccount = { id: a.id, email: a.email, stakeholder: null, product: null };
    if (a.productId) acc.product = { id: a.productId, status: a.status ?? "under_review", settlements: a.settlements ?? null, requirements: a.requirements ?? [] };
    this.accounts.set(a.id, acc);
    return acc;
  }

  setStatus(accountId: string, status: string, requirements: any[] = []) {
    const p = this.accounts.get(accountId)?.product;
    if (p) {
      p.status = status;
      p.requirements = requirements;
    }
  }

  // ── Test drivers for the money leg ──

  /** A captured payment the brand paid. */
  seedPayment(a: { id: string; amount: number; status?: string }): FakePayment {
    const pay: FakePayment = { id: a.id, amount: a.amount, status: a.status ?? "captured", refunds: [], createdAt: Math.floor(Date.now() / 1000) - 60 };
    this.payments.set(a.id, pay);
    return pay;
  }

  /** A transfer that already exists at Razorpay (made earlier, or by someone else). */
  seedTransfer(a: { id?: string; source: string; recipient: string; amount: number; status?: string; onHold?: boolean; onHoldUntil?: number | null; notes?: Record<string, string>; amountReversed?: number; hidden?: number }): FakeTransfer {
    const t: FakeTransfer = {
      id: a.id ?? `trf_FakeTrf${String(++this.m).padStart(4, "0")}`,
      source: a.source,
      recipient: a.recipient,
      amount: a.amount,
      status: a.status ?? "processed",
      amountReversed: a.amountReversed ?? 0,
      onHold: a.onHold ?? true,
      onHoldUntil: a.onHoldUntil ?? null,
      notes: a.notes ?? {},
      settlementId: null,
      createdAt: Math.floor(Date.now() / 1000) - 30,
      hidden: a.hidden ?? 0,
    };
    this.transfers.set(t.id, t);
    return t;
  }

  /** A pending transfer becomes processed (the webhook would say so). */
  processTransfer(id: string) {
    const t = this.transfers.get(id);
    if (t && t.status === "pending") t.status = "processed";
  }

  failTransfer(id: string) {
    const t = this.transfers.get(id);
    if (t) t.status = "failed";
  }

  /**
   * Razorpay settles a released transfer to the linked account's bank. `batchWith` adds other transfers'
   * amounts to the settlement's amount, the way a real batch settlement does.
   */
  settleTransfer(id: string, o: { status?: string; utr?: string | null; fee?: number; batchExtra?: number } = {}): FakeSettlement {
    const t = this.transfers.get(id);
    if (!t) throw new Error(`no fake transfer ${id}`);
    const sid = `setl_FakeSetl${String(++this.n).padStart(4, "0")}`;
    const st: FakeSettlement = {
      id: sid,
      status: o.status ?? "processed",
      utr: o.utr === undefined ? `UTRFAKE${String(this.n).padStart(8, "0")}` : o.utr,
      fee: o.fee ?? 0,
      tax: 0,
      amount: t.amount - t.amountReversed + (o.batchExtra ?? 0),
    };
    this.settlements.set(sid, st);
    t.settlementId = sid;
    return st;
  }

  addDispute(a: { id?: string; paymentId: string; status?: string; phase?: string; amount?: number; createdAt?: number }): FakeDispute {
    const d: FakeDispute = {
      id: a.id ?? `disp_FakeDisp${String(this.disputes.length + 1).padStart(4, "0")}`,
      paymentId: a.paymentId,
      status: a.status ?? "open",
      phase: a.phase ?? "chargeback",
      amount: a.amount ?? 1000,
      createdAt: a.createdAt ?? Math.floor(Date.now() / 1000) - 10,
    };
    this.disputes.push(d);
    return d;
  }

  /** The transfers of a payment that carry this payout id and are still alive (not failed, not fully reversed). */
  liveTransfersFor(payoutId: string) {
    return [...this.transfers.values()].filter((t) => t.notes.payout_id === payoutId && t.status !== "failed" && t.status !== "reversed");
  }

  private async handle(call: FakeCall): Promise<Response> {
    let rule: Rule | undefined;
    for (const r of this.rules) {
      if (r.times <= 0 || !r.match(call)) continue;
      if (r.skip && r.skip > 0) {
        r.skip--;
        continue;
      }
      rule = r;
      break;
    }
    if (rule) rule.times--;
    if (!rule && this.chaos) {
      const c = this.chaos(call);
      if (c) rule = { match: () => true, times: 1, ...c };
    }
    const lat = this.latency?.(call) ?? null;
    if (lat?.before) await new Promise((r) => setTimeout(r, lat.before));
    if (rule?.before) await rule.before();
    if (rule?.mode === "hold") await rule.gate;
    if (rule?.mode === "drop") throw new TypeError("fetch failed");
    if (rule?.mode === "reject") return rule.body !== undefined ? json(rule.body, rule.status ?? 400) : err("Rejected by the fake", rule.status ?? 400);
    const out = this.apply(call, rule);
    this.applied.push({ call, status: out.status });
    if (lat?.after) await new Promise((r) => setTimeout(r, lat.after));
    if (rule?.mode === "lose") throw new TypeError("fetch failed");
    if (rule?.mode === "garbage") return new Response("<html>not json</html>", { status: 200 });
    if (rule?.mode === "badgateway") return new Response("Bad gateway", { status: 502 });
    return out;
  }

  private productEntity(acc: FakeAccount) {
    const p = acc.product!;
    return {
      id: p.id,
      product_name: "route",
      activation_status: p.status,
      account_id: acc.id,
      requested_at: 1_700_000_000,
      requested_configuration: [],
      active_configuration: p.settlements ? { settlements: p.settlements } : {},
      requirements: p.requirements,
      tnc: { id: "tnc_Fake0001", accepted: true, accepted_at: 1_700_000_000 },
    };
  }

  private apply(call: FakeCall, rule?: Rule): Response {
    const { method, path, body } = call;
    if (path.startsWith("/v1/")) return this.applyV1(call, rule);
    if (is.createAccount(call)) {
      const email = String(body.email).toLowerCase();
      const existing = [...this.accounts.values()].find((a) => a.email.toLowerCase() === email);
      if (existing) return err(`Merchant email already exists for account - ${existing.id.replace(/^acc_/, "")}.`);
      const id = `acc_FakeAcct${String(++this.n).padStart(2, "0")}x`;
      const acc: FakeAccount = { id, email: body.email, stakeholder: null, product: null };
      this.accounts.set(id, acc);
      return json({
        id,
        type: "route",
        status: "created",
        email: body.email,
        phone: body.phone,
        reference_id: body.reference_id ?? null,
        legal_business_name: body.legal_business_name,
        business_type: body.business_type,
        contact_name: body.contact_name,
        profile: body.profile,
        legal_info: { pan: "ECHOEDPAN1" },
        created_at: 1_700_000_000,
      });
    }
    const m = /^\/accounts\/([^/]+)(?:\/(stakeholders|products)(?:\/([^/]+))?)?$/.exec(path);
    if (!m) return err(`The fake has no route for ${method} ${path}`, 404);
    const acc = this.accounts.get(m[1]);
    if (!acc) return err("Linked account does not exist", 400, { reason: "linked_account_id_does_not_exist" });
    if (!m[2] && method === "GET") return json({ id: acc.id, type: "route", status: "created", email: acc.email, reference_id: null, created_at: 1_700_000_000, legal_business_name: "Echoed Legal Name", phone: "9999900000" });
    if (m[2] === "stakeholders" && method === "POST") {
      if (acc.stakeholder) return err("Stakeholders cannot be more than one for Route product.");
      if (String(body.kyc?.pan ?? "").startsWith("BADP")) return err("The PAN is invalid", 400, { field: "kyc.pan" });
      acc.stakeholder = { id: "sth_FakeStake01x", pan: body.kyc.pan };
      return json({ id: acc.stakeholder.id, entity: "stakeholder", name: body.name, email: body.email, kyc: { pan: body.kyc.pan }, addresses: body.addresses, phone: body.phone });
    }
    if (m[2] === "products" && !m[3] && method === "POST") {
      if (acc.product) return err("Product already requested for this account");
      acc.product = {
        id: "acc_prd_FakeProd01x",
        status: "needs_clarification",
        settlements: null,
        requirements: [
          { field_reference: "settlements.account_number", reason_code: "field_missing", status: "required", resolution_url: "/x", description: "The account number is required" },
          { field_reference: "settlements.ifsc_code", reason_code: "field_missing", status: "required", resolution_url: "/x", description: "The IFSC is required" },
          { field_reference: "settlements.beneficiary_name", reason_code: "field_missing", status: "required", resolution_url: "/x", description: "The beneficiary name is required" },
        ],
      };
      return json(this.productEntity(acc));
    }
    if (m[2] === "products" && m[3] && method === "PATCH") {
      if (!acc.product || acc.product.id !== m[3]) return err("Product does not exist", 400);
      const s = body.settlements ?? {};
      if (String(s.ifsc_code).startsWith("BADD")) return err("Invalid IFSC Code", 400, { field: "settlements.ifsc_code" });
      acc.product.settlements = { account_number: s.account_number, ifsc_code: s.ifsc_code, beneficiary_name: s.beneficiary_name };
      acc.product.status = this.afterBankStatus;
      acc.product.requirements = [];
      return json(this.productEntity(acc));
    }
    if (m[2] === "products" && m[3] && method === "GET") {
      if (!acc.product || acc.product.id !== m[3]) return err("Product does not exist", 400);
      return json(this.productEntity(acc));
    }
    return err(`The fake has no route for ${method} ${path}`, 404);
  }

  // ── /v1: payments, transfers, reversals, disputes ───────────────────────────────

  private transferEntity(t: FakeTransfer, expand = false) {
    const st = t.settlementId ? this.settlements.get(t.settlementId) ?? null : null;
    return {
      id: t.id,
      entity: "transfer",
      status: t.status,
      source: t.source,
      recipient: t.recipient,
      amount: t.amount,
      currency: "INR",
      amount_reversed: t.amountReversed,
      fees: 1,
      tax: 0,
      notes: Object.keys(t.notes).length ? t.notes : [],
      linked_account_notes: [],
      on_hold: t.onHold,
      on_hold_until: t.onHoldUntil,
      settlement_status: t.settlementId && st?.status === "processed" ? "settled" : t.onHold ? "on_hold" : "pending",
      recipient_settlement_id: t.settlementId,
      ...(expand ? { recipient_settlement: st ? { id: st.id, entity: "settlement", status: st.status, utr: st.utr, fees: st.fee, tax: st.tax, amount: st.amount } : null } : {}),
      created_at: t.createdAt,
      processed_at: t.status === "pending" ? null : t.createdAt + 5,
      error: { code: null, description: null, reason: null, field: null, step: null, id: t.id, source: null, metadata: null },
    };
  }

  /** Honest paging by default; `listPageSize` / `honorSkip` make it dishonest. */
  private page<T>(items: T[], query: Record<string, string>) {
    const skip = this.honorSkip ? Number(query.skip ?? 0) || 0 : 0;
    const asked = Number(query.count ?? 10) || 10;
    const size = this.listPageSize ?? Math.min(asked, 100);
    return items.slice(skip, skip + size);
  }

  private applyV1(call: FakeCall, rule?: Rule): Response {
    const { method, path, body, query } = call;

    let m = /^\/v1\/payments\/([^/]+)\/transfers$/.exec(path);
    if (m && method === "POST") {
      const pay = this.payments.get(m[1]);
      if (!pay) return err("The id provided does not exist", 400);
      if (pay.status !== "captured") return err("The payment has not been captured", 400);
      if (pay.refunds.some((r) => r.status !== "failed")) return err("You cannot request a transfer on payment once a refund has been initiated", 400);
      const list: any[] = Array.isArray(body?.transfers) ? body.transfers : [];
      if (list.length === 0) return err("transfers is required", 400);
      const taken = [...this.transfers.values()].filter((t) => t.source === pay.id).reduce((a, t) => a + (t.amount - t.amountReversed), 0);
      const asking = list.reduce((a, t) => a + Number(t.amount || 0), 0);
      if (taken + asking > pay.amount) return err("The total transfer amount is greater than the payment amount", 400);
      for (const x of list) {
        if (!Number.isInteger(x.amount) || x.amount < 100) return err("The amount must be at least INR 1.00", 400);
        if (typeof x.account !== "string" || !x.account.startsWith("acc_")) return err("account is not a valid id", 400);
        if (this.suspended.has(x.account)) return err("The linked account is suspended", 400);
      }
      if (this.balance < asking) return err("Your account does not have enough balance to carry out the fund transfer operation", 400);
      const made: FakeTransfer[] = [];
      for (const x of list) {
        const t = this.seedTransfer({
          source: pay.id,
          recipient: x.account,
          amount: x.amount,
          status: this.createStatus,
          onHold: x.on_hold === true,
          onHoldUntil: typeof x.on_hold_until === "number" ? x.on_hold_until : null,
          notes: x.notes && typeof x.notes === "object" ? Object.fromEntries(Object.entries(x.notes).map(([k, v]) => [k, String(v)])) : {},
          hidden: rule?.hideFromListings ?? 0,
        });
        this.balance -= x.amount;
        rule?.afterCreate?.(t);
        made.push(t);
      }
      return json({ entity: "collection", count: made.length, items: made.map((t) => this.transferEntity(t)) });
    }
    if (m && method === "GET") {
      const pay = this.payments.get(m[1]);
      if (!pay) return err("The id provided does not exist", 400);
      const all = [...this.transfers.values()].filter((t) => t.source === pay.id);
      const visible = all.filter((t) => t.hidden === 0);
      const items = this.page(visible, query).map((t) => this.transferEntity(t));
      // A transfer that "appears later" stays out of this listing, then comes closer to appearing.
      for (const t of all) if (t.hidden > 0) t.hidden--;
      return json({ entity: "collection", count: items.length, items });
    }

    m = /^\/v1\/transfers\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const t = this.transfers.get(m[1]);
      if (!t) return err("The id provided does not exist", 400);
      return json(this.transferEntity(t, query["expand[]"] === "recipient_settlement"));
    }
    if (m && method === "PATCH") {
      const t = this.transfers.get(m[1]);
      if (!t) return err("The id provided does not exist", 400);
      if (typeof body?.on_hold !== "boolean") return err("on_hold is required", 400);
      const settled = t.settlementId !== null && this.settlements.get(t.settlementId)?.status === "processed";
      if (body.on_hold === true && settled && !this.allowRehold) return err("The transfer has already been settled", 400);
      if (body.on_hold === true && !t.onHold && !this.allowReholdAfterRelease) return err("The settlement of a released transfer cannot be put on hold again", 400);
      t.onHold = body.on_hold;
      t.onHoldUntil = typeof body.on_hold_until === "number" ? body.on_hold_until : null;
      return json(this.transferEntity(t));
    }

    m = /^\/v1\/transfers\/([^/]+)\/reversals$/.exec(path);
    if (m && method === "POST") {
      const t = this.transfers.get(m[1]);
      if (!t) return err("The id provided does not exist", 400);
      const left = t.amount - t.amountReversed;
      const amount = body?.amount === undefined ? left : body.amount; // omitted = EVERYTHING that is left (the docs)
      if (!Number.isInteger(amount) || amount <= 0) return err("The amount must be at least INR 1.00", 400);
      if (amount > left) return err("The reversal amount is more than the amount that can be reversed", 400);
      const settled = t.settlementId !== null && this.settlements.get(t.settlementId)?.status === "processed";
      if (settled && (this.floating.get(t.recipient) ?? 0) < amount) return err("The linked account does not have sufficient balance to process reversal", 400);
      if (settled) this.floating.set(t.recipient, (this.floating.get(t.recipient) ?? 0) - amount);
      t.amountReversed += amount;
      t.status = t.amountReversed >= t.amount ? "reversed" : "partially_reversed";
      this.balance += amount;
      const rev = { id: `rvrsl_FakeRev${String(++this.m).padStart(4, "0")}`, amount, notes: body?.notes && typeof body.notes === "object" ? Object.fromEntries(Object.entries(body.notes).map(([k, v]) => [k, String(v)])) : {}, createdAt: Math.floor(Date.now() / 1000) };
      this.reversals.set(t.id, [...(this.reversals.get(t.id) ?? []), rev]);
      return json({ id: rev.id, entity: "reversal", transfer_id: t.id, amount, fee: 0, tax: 0, currency: "INR", notes: Object.keys(rev.notes).length ? rev.notes : [], initiator_id: "CJoeHMNpi0nC7k", customer_refund_id: null, created_at: rev.createdAt });
    }
    if (m && method === "GET") {
      const t = this.transfers.get(m[1]);
      if (!t) return err("The id provided does not exist", 400);
      const items = (this.reversals.get(t.id) ?? []).map((r) => ({ id: r.id, entity: "reversal", transfer_id: t.id, amount: r.amount, currency: "INR", notes: Object.keys(r.notes).length ? r.notes : [], created_at: r.createdAt }));
      return json({ entity: "collection", count: items.length, items });
    }

    if (path === "/v1/disputes" && method === "GET") {
      const from = Number(query.from ?? 0);
      const to = Number(query.to ?? Number.MAX_SAFE_INTEGER);
      const inRange = this.disputes.filter((d) => d.createdAt >= from && d.createdAt <= to);
      const items = this.page(inRange, query).map((d) => ({
        id: d.id,
        entity: "dispute",
        payment_id: d.paymentId,
        amount: d.amount,
        currency: "INR",
        amount_deducted: d.status === "lost" ? d.amount : 0,
        reason_code: d.phase,
        respond_by: d.createdAt + 86_400,
        status: d.status,
        phase: d.phase,
        created_at: d.createdAt,
        evidence: { amount: d.amount, summary: null },
      }));
      return json({ entity: "collection", count: items.length, items });
    }

    if (path === "/v1/orders" && method === "POST") {
      return json({ id: `order_FakeOrd${String(++this.n).padStart(4, "0")}`, entity: "order", amount: body.amount, currency: body.currency ?? "INR", status: "created", receipt: body.receipt ?? null });
    }

    m = /^\/v1\/payments\/([^/]+)\/refund$/.exec(path);
    if (m && method === "POST") {
      const pay = this.payments.get(m[1]);
      if (!pay) return err("The id provided does not exist", 400);
      // The idempotency key makes a repeated request answer with the refund it already made [R30], like Razorpay does.
      const key = call.headers["X-Refund-Idempotency"];
      if (key && this.refundKeys.has(`${pay.id}:${key}`)) {
        const again = this.refundKeys.get(`${pay.id}:${key}`)!;
        return json({ id: again.id, entity: "refund", amount: again.amount, payment_id: pay.id, status: again.status, receipt: body?.receipt ?? null, created_at: Math.floor(Date.now() / 1000) });
      }
      const amount = body?.amount ?? pay.amount;
      const refunded = pay.refunds.filter((r) => r.status !== "failed").reduce((a, r) => a + r.amount, 0);
      if (!Number.isInteger(amount) || amount <= 0 || amount > pay.amount - refunded) return err("The refund amount is greater than the amount available for refund", 400);
      const rf = { id: `rfnd_FakeRef${String(++this.m).padStart(4, "0")}`, amount, status: this.refundStatus };
      pay.refunds.push(rf);
      if (key) this.refundKeys.set(`${pay.id}:${key}`, rf);
      return json({ id: rf.id, entity: "refund", amount, payment_id: pay.id, status: rf.status, receipt: body?.receipt ?? null, created_at: Math.floor(Date.now() / 1000) });
    }
    m = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(path);
    if (m && method === "GET") {
      const pay = this.payments.get(m[1]);
      if (!pay) return err("The id provided does not exist", 400);
      const items = this.page(pay.refunds, query).map((r) => ({ id: r.id, entity: "refund", amount: r.amount, payment_id: pay.id, status: r.status, created_at: pay.createdAt }));
      return json({ entity: "collection", count: items.length, items });
    }
    m = /^\/v1\/payments\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const pay = this.payments.get(m[1]);
      if (!pay) return err("The id provided does not exist", 400);
      const refunded = pay.refunds.filter((r) => r.status !== "failed").reduce((a, r) => a + r.amount, 0);
      return json({ id: pay.id, entity: "payment", amount: pay.amount, currency: "INR", status: pay.status, captured: pay.status === "captured", amount_refunded: refunded, refund_status: refunded === 0 ? null : refunded >= pay.amount ? "full" : "partial", order_id: "order_FakeOrder01", created_at: pay.createdAt });
    }
    return err(`The fake has no route for ${method} ${path}`, 404);
  }
}
