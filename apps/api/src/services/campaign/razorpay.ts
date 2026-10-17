import crypto from "crypto";
import { razorpayConfig } from "./config";
import { destinationHint, scrubPayoutSecrets } from "../../utils/payout-scrub";

// Minimal Razorpay REST client and signature helpers. No SDK: a handful of calls do not justify
// a dependency, and a plain fetch is trivially mockable in tests (razorpayHttp.fetch is swapped
// out there).
//
// The surface covers three things:
//   - Checkout money: orders and refunds (the original exports, unchanged).
//   - Route (creator payouts): linked accounts, the Route product, held transfers, releases and
//     reversals, plus the reads the reconciliation job needs.
//   - Reads of the payment itself (status, refunds).
//
// ⚠️ THREE RULES THAT EVERY FUNCTION HERE FOLLOWS. They exist because this client moves money
// and carries creators' bank details, and each one closes a specific way that goes wrong.
//
// 1. A response is never trusted raw. Every body is parsed into an ALLOW-LISTED typed object and
//    the raw JSON is dropped. Razorpay echoes the PAN (`legal_info.pan`, `kyc.pan`) and the full
//    settlement account number back [R5][R6][R29], and a spread of the raw body into a log line,
//    a column or an audit row would be a leak no review would spot. A parser that does not find
//    the fields it needs returns null and the call throws UNKNOWN_RESULT; it never "best-effort"
//    accepts a half-read money answer.
// 2. "Did it happen?" has three answers, not two. A definite 4xx means Razorpay refused and nothing
//    changed; a 2xx with a readable body means it happened; everything else (a timeout, a 5xx, a 409,
//    a 2xx whose body we cannot read) is UNKNOWN, and the caller must reconcile instead of rolling
//    back or retrying blind. isDefinitelyRejected() is the one place that decides which is which.
// 3. Nothing is logged and no message leaves unscrubbed. No request or response body is ever
//    printed, and every error message passes through scrubPayoutSecrets before it is thrown.

const BASE_V1 = "https://api.razorpay.com/v1";
// Linked accounts, stakeholders and product configuration live under /v2 [R5][R6][R8][R29].
const BASE_V2 = "https://api.razorpay.com/v2";

const TIMEOUT_MS = 15_000;

export const razorpayHttp: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) };

export class RazorpayError extends Error {
  /**
   * Set only when Razorpay answered "Merchant email already exists for account - X" [R5]. It is
   * read from the RAW description, before scrubbing: a 14-character base-62 account id contains
   * a run of five digits about once in a thousand ids, and the scrubber would mangle it.
   */
  existingAccountId?: string;

  constructor(
    message: string,
    public status: number,
    public code?: string,
    public reason?: string,
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

/**
 * True ONLY when Razorpay (or this client, before sending anything) definitely refused the
 * request, so nothing changed on Razorpay's side and it is safe to roll back our own claim.
 *
 *   400 401 403 404 422  definite: a validation, auth, permission or lookup refusal.
 *   NOT_CONFIGURED       definite: the request was never sent.
 *   429                  NOT definite. Rate limiting is applied at Razorpay's edge, and from the
 *                        outside we cannot prove the request never reached the backend; a wrong
 *                        "definite" on a transfer risks paying twice, a wrong "unknown" costs one
 *                        reconciliation pass.
 *   408                  NOT definite, same reason (a timeout can fire after the work started).
 *   409                  NOT definite: the idempotent request is still being processed [R30].
 *   5xx, redirects       NOT definite.
 *   status 0 / NETWORK   NOT definite: the request may have been received before the connection died.
 *   UNKNOWN_RESULT       NOT definite: Razorpay answered 2xx and we could not read what it did.
 */
export function isDefinitelyRejected(err: unknown): boolean {
  if (!(err instanceof RazorpayError)) return false;
  if (err.code === "NOT_CONFIGURED") return true;
  if (err.code === "UNKNOWN_RESULT" || err.code === "NETWORK") return false;
  return err.status === 400 || err.status === 401 || err.status === 403 || err.status === 404 || err.status === 422;
}

// ── Transport ───────────────────────────────────────────────────────────────────

type Method = "GET" | "POST" | "PATCH";
type QueryPairs = Array<[string, string | number]>;

interface CallOptions {
  api?: "v1" | "v2";
  body?: unknown;
  query?: QueryPairs;
  headers?: Record<string, string>;
}

/**
 * URLSearchParams escapes `[` and `]` in keys. Razorpay's own examples send `expand[]=…` with
 * literal brackets, so the key part of each pair is put back the way the docs spell it; values
 * stay fully escaped.
 */
function queryString(pairs: QueryPairs | undefined): string {
  if (!pairs || pairs.length === 0) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of pairs) sp.append(k, String(v));
  const parts = sp
    .toString()
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      const key = eq === -1 ? part : part.slice(0, eq);
      const rest = eq === -1 ? "" : part.slice(eq);
      return key.replace(/%5B/gi, "[").replace(/%5D/gi, "]") + rest;
    });
  return `?${parts.join("&")}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Message for an error: scrubbed, bounded, and never the raw body. */
function safeMessage(text: string): string {
  return scrubPayoutSecrets(text).slice(0, 300);
}

// "Merchant email already exists for account - BbHKlnuyZkf0xa." [R5]
const EXISTING_ACCOUNT_RE = /already exists for account\s*-\s*(?:acc_)?([A-Za-z0-9]{6,32})/i;

function httpError(status: number, json: unknown): RazorpayError {
  const e = isObj(json) && isObj(json.error) ? json.error : null;
  const description = typeof e?.description === "string" ? e.description : "";
  const code = typeof e?.code === "string" ? scrubPayoutSecrets(e.code).slice(0, 80) : undefined;
  const reason = typeof e?.reason === "string" && e.reason !== "NA" && e.reason !== "" ? scrubPayoutSecrets(e.reason).slice(0, 120) : undefined;
  const err = new RazorpayError(safeMessage(description || `Razorpay HTTP ${status}`), status, code, reason);
  const existing = EXISTING_ACCOUNT_RE.exec(description);
  if (existing) err.existingAccountId = `acc_${existing[1]}`;
  return err;
}

/**
 * One HTTP round trip. Returns the parsed JSON of a 2xx answer; throws RazorpayError otherwise:
 *   non-2xx          → the HTTP status and Razorpay's own error code (message scrubbed),
 *   2xx, bad body    → UNKNOWN_RESULT with the HTTP status: Razorpay accepted the request and we
 *                      cannot tell what it did, so this is neither success nor failure,
 *   timeout, network → status 0, code NETWORK.
 * The body is read INSIDE the timeout window, so a response that stalls half-way counts too.
 */
async function call(method: Method, path: string, opts: CallOptions = {}): Promise<{ status: number; json: unknown }> {
  if (!razorpayConfig.configured()) throw new RazorpayError("Razorpay is not configured", 0, "NOT_CONFIGURED");
  const auth = Buffer.from(`${razorpayConfig.keyId()}:${razorpayConfig.keySecret()}`).toString("base64");
  const url = `${opts.api === "v2" ? BASE_V2 : BASE_V1}${path}${queryString(opts.query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await razorpayHttp.fetch(url, {
      method,
      // Extra headers go first so nothing a caller passes can replace the credentials.
      headers: { ...opts.headers, Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    let text: string | null = null;
    try {
      text = await res.text();
    } catch {
      text = null; // the connection died mid-body; the status line is still known
    }
    let json: unknown;
    let readable = false;
    if (text !== null && text.length > 0) {
      try {
        json = JSON.parse(text);
        readable = true;
      } catch {
        readable = false;
      }
    }
    if (!res.ok) throw httpError(res.status, readable ? json : undefined);
    if (!readable) {
      throw new RazorpayError(`Razorpay answered HTTP ${res.status} but the response could not be read`, res.status, "UNKNOWN_RESULT");
    }
    return { status: res.status, json };
  } catch (err) {
    if (err instanceof RazorpayError) throw err;
    const aborted = (err as Error)?.name === "AbortError" || ctrl.signal.aborted;
    throw new RazorpayError(safeMessage(aborted ? "Razorpay request timed out" : `Razorpay request failed: ${(err as Error)?.message ?? "unknown error"}`), 0, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

/** call() plus an allow-list parse. A parser that returns null means the answer was not what we need. */
async function request<T>(method: Method, path: string, opts: CallOptions, parse: (json: unknown) => T | null, what: string): Promise<T> {
  const { status, json } = await call(method, path, opts);
  const out = parse(json);
  if (out === null) throw new RazorpayError(`Razorpay answered HTTP ${status} with an unexpected ${what}`, status, "UNKNOWN_RESULT");
  return out;
}

// ── Parsing helpers ─────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** Razorpay documents some amounts as integers and shows others as numeric strings. */
const intLoose = (v: unknown): number | null => {
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) return Number(v);
  return int(v);
};

/** Ids go into URL paths. Anything outside this shape ("..", "a/b", "x?y") is refused before it can reach one. */
function pathId(v: string, what: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(v)) throw new RazorpayError(`Invalid ${what} id`, 400, "INVALID_REQUEST");
  return v;
}

function positiveInt(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v <= 0) throw new RazorpayError(`${what} must be a positive whole number of paise`, 400, "INVALID_REQUEST");
  return v;
}

// ── Orders and refunds (checkout) ───────────────────────────────────────────────

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

function parseOrder(json: unknown): RazorpayOrder | null {
  if (!isObj(json)) return null;
  const id = str(json.id);
  const amount = int(json.amount);
  const currency = str(json.currency);
  const status = str(json.status);
  if (!id || amount === null || !currency || !status) return null;
  return { id, amount, currency, status };
}

export async function createOrder(amountPaise: number, receipt: string, notes: Record<string, string>) {
  return request(
    "POST",
    "/orders",
    { body: { amount: amountPaise, currency: "INR", receipt: receipt.slice(0, 40), notes, payment_capture: 1 } },
    parseOrder,
    "order",
  );
}

export interface RazorpayRefund {
  id: string;
  amount: number;
  status: string; // pending | processed | failed
  payment_id?: string | null;
  receipt?: string | null;
  created_at?: number | null;
}

/**
 * @param statusOptional  list entries: the refund-list fields are UNVERIFIED [R33], so a missing
 *                        status reads as "unknown" instead of failing the whole page. A create
 *                        response is stricter: without a status we do not know what happened.
 */
function parseRefund(json: unknown, statusOptional = false): RazorpayRefund | null {
  if (!isObj(json)) return null;
  const id = str(json.id);
  const amount = int(json.amount);
  const status = str(json.status) ?? (statusOptional ? "unknown" : null);
  if (!id || amount === null || !status) return null;
  return { id, amount, status, payment_id: str(json.payment_id), receipt: str(json.receipt), created_at: int(json.created_at) };
}

// The key must be at least 10 characters of letters, digits, hyphens and underscores [R30]. The
// upper bound is ours (Razorpay documents none): a key is meant to be a short stable id such as
// "rf-item-<uuid>", never free text.
const REFUND_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{10,128}$/;

/**
 * Refund (part of) a captured payment.
 *
 * @param idempotencyKey  Sent as `X-Refund-Idempotency` [R30]. Pass a STABLE key per refund intent
 *   (for example `rf-item-<itemId>`) and the SAME key on every retry: after a timeout Razorpay
 *   then returns the original refund instead of creating a second one. Retrying with the same
 *   key and a different body is rejected (400). Omitted = no header, the pre-existing behaviour;
 *   money callers must always pass one.
 */
export async function refundPayment(paymentId: string, amountPaise: number, receipt: string, idempotencyKey?: string) {
  if (idempotencyKey !== undefined && !REFUND_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new RazorpayError("Refund idempotency keys must be 10 to 128 characters of letters, digits, hyphens and underscores", 400, "INVALID_REQUEST");
  }
  return request(
    "POST",
    `/payments/${encodeURIComponent(paymentId)}/refund`,
    {
      body: { amount: amountPaise, speed: "normal", receipt: receipt.slice(0, 40) },
      headers: idempotencyKey === undefined ? undefined : { "X-Refund-Idempotency": idempotencyKey },
    },
    (json) => parseRefund(json),
    "refund",
  );
}

// ── Payments ────────────────────────────────────────────────────────────────────

/** The few payment fields money logic needs. The payer's email, phone, card and VPA are dropped. */
export interface RazorpayPayment {
  id: string;
  amount: number;
  currency: string;
  status: string; // created | authorized | captured | refunded | failed
  captured: boolean;
  amount_refunded: number;
  refund_status: string | null; // null | partial | full
  order_id: string | null;
  created_at: number | null;
}

function parsePayment(json: unknown): RazorpayPayment | null {
  if (!isObj(json)) return null;
  const id = str(json.id);
  const amount = int(json.amount);
  const status = str(json.status);
  const amountRefunded = int(json.amount_refunded);
  if (!id || amount === null || !status || amountRefunded === null) return null;
  return {
    id,
    amount,
    currency: str(json.currency) ?? "INR",
    status,
    captured: bool(json.captured) ?? status === "captured",
    amount_refunded: amountRefunded,
    refund_status: str(json.refund_status),
    order_id: str(json.order_id),
    created_at: int(json.created_at),
  };
}

/** GET /v1/payments/:id [api/payments/fetch-with-id]. */
export async function fetchPayment(paymentId: string) {
  return request("GET", `/payments/${pathId(paymentId, "payment")}`, {}, parsePayment, "payment");
}

const REFUND_PAGE = 100;
const REFUND_MAX_PAGES = 5;

/**
 * GET /v1/payments/:id/refunds [R33: the doc returns only the last 10 by default; count and skip
 * page it]. Reads every page. ⚠️ The result is a TOTAL that the money rules trust ("Razorpay's
 * total, not ours"), so it is exact or it is an error: a malformed entry, or more refunds than
 * REFUND_MAX_PAGES pages can hold, throws UNKNOWN_RESULT instead of returning a short list that
 * would let a second refund through. The entry fields are UNVERIFIED against a live account.
 */
export async function fetchPaymentRefunds(paymentId: string): Promise<RazorpayRefund[]> {
  const id = pathId(paymentId, "payment");
  const all: RazorpayRefund[] = [];
  for (let page = 0; page < REFUND_MAX_PAGES; page++) {
    const items = await request(
      "GET",
      `/payments/${id}/refunds`,
      { query: [["count", REFUND_PAGE], ["skip", page * REFUND_PAGE]] },
      (json) => {
        if (!isObj(json) || !Array.isArray(json.items)) return null;
        const parsed = json.items.map((it) => parseRefund(it, true));
        return parsed.every((p): p is RazorpayRefund => p !== null) ? parsed : null;
      },
      "refund list",
    );
    all.push(...items);
    if (items.length < REFUND_PAGE) return all;
  }
  throw new RazorpayError(`Razorpay returned more than ${REFUND_PAGE * REFUND_MAX_PAGES} refunds for one payment`, 200, "UNKNOWN_RESULT");
}

/**
 * What the refunds on a payment have taken out of it: pending and processed count, failed does
 * not (a failed refund returned nothing). An entry with an unknown status counts, because
 * under-counting is the dangerous direction.
 */
export function refundedTotalPaise(refunds: RazorpayRefund[]): number {
  return refunds.reduce((sum, r) => (r.status === "failed" ? sum : sum + r.amount), 0);
}

// ── Route: linked accounts [R5][R6][R8][R29] ─────────────────────────────────────

/**
 * The linked account as WE keep it. `legal_info.pan`, the address, the phone and the name that
 * Razorpay echoes back are deliberately not here. The email stays: a returning creator is adopted
 * only when our verified email equals the account's [R5].
 */
export interface RazorpayLinkedAccount {
  id: string;
  status: string | null; // created | suspended
  type: string | null;
  email: string | null;
  reference_id: string | null;
  created_at: number | null;
}

function parseLinkedAccount(json: unknown): RazorpayLinkedAccount | null {
  if (!isObj(json)) return null;
  const id = str(json.id);
  if (!id) return null;
  return { id, status: str(json.status), type: str(json.type), email: str(json.email), reference_id: str(json.reference_id), created_at: int(json.created_at) };
}

export interface CreateLinkedAccountInput {
  email: string;
  phone: string;
  /** The creator's name as on the PAN; Razorpay needs 4 to 200 characters [R5]. */
  legalName: string;
  contactName: string;
  /**
   * Our creator id. Needs the `route_code_support` feature enabled, otherwise Razorpay refuses the
   * whole request [R5]. ⚠️ UNVERIFIED length: the request doc allows 512 characters, the entity doc
   * says 20, and a UUID is 36. Check in test mode; a too-long value comes back as a definite 400.
   */
  referenceId?: string;
  /** Both come from Razorpay's lists [R5]; which pair fits creators is plan question i. */
  category: string;
  subcategory: string;
  address: { street1: string; street2?: string; city: string; state: string; postalCode: string };
}

/**
 * POST /v2/accounts [R5]. `type: "route"`, `business_type: "individual"`: creators are individuals,
 * whose only KYC document is the owner PAN, and that goes on the stakeholder [R6], not here, so
 * this body carries no `legal_info`. A duplicate email answers 400 and sets `existingAccountId`
 * on the error.
 */
export async function createLinkedAccount(input: CreateLinkedAccountInput) {
  return request(
    "POST",
    "/accounts",
    {
      api: "v2",
      body: {
        email: input.email,
        phone: input.phone,
        type: "route",
        ...(input.referenceId ? { reference_id: input.referenceId } : {}),
        legal_business_name: input.legalName,
        business_type: "individual",
        contact_name: input.contactName,
        profile: {
          category: input.category,
          subcategory: input.subcategory,
          addresses: {
            registered: {
              street1: input.address.street1,
              ...(input.address.street2 ? { street2: input.address.street2 } : {}),
              city: input.address.city,
              state: input.address.state,
              postal_code: input.address.postalCode,
              country: "IN",
            },
          },
        },
      },
    },
    parseLinkedAccount,
    "linked account",
  );
}

/** GET /v2/accounts/:id [api/payments/route/fetch-with-id]. */
export async function fetchLinkedAccount(accountId: string) {
  return request("GET", `/accounts/${pathId(accountId, "account")}`, { api: "v2" }, parseLinkedAccount, "linked account");
}

export interface RazorpayStakeholder {
  id: string;
}

export interface CreateStakeholderInput {
  /** As on the PAN card [R6]. */
  name: string;
  email: string;
  /** The creator's PAN; its 4th character must be "P" [R6]. Sent once and never kept. */
  panNumber: string;
  phone?: string;
  residential?: { street: string; city: string; state: string; postalCode: string };
}

/** POST /v2/accounts/:id/stakeholders [R6]. Only the stakeholder id comes back out of the parser; the echoed PAN is dropped. */
export async function createStakeholder(accountId: string, input: CreateStakeholderInput) {
  return request(
    "POST",
    `/accounts/${pathId(accountId, "account")}/stakeholders`,
    {
      api: "v2",
      body: {
        name: input.name,
        email: input.email,
        relationship: { executive: true },
        percentage_ownership: 100,
        ...(input.phone ? { phone: { primary: input.phone } } : {}),
        ...(input.residential
          ? {
              addresses: {
                residential: {
                  street: input.residential.street,
                  city: input.residential.city,
                  state: input.residential.state,
                  postal_code: input.residential.postalCode,
                  country: "IN",
                },
              },
            }
          : {}),
        kyc: { pan: input.panNumber },
      },
    },
    (json): RazorpayStakeholder | null => {
      const id = isObj(json) ? str(json.id) : null;
      return id ? { id } : null;
    },
    "stakeholder",
  );
}

// ── Route: product configuration [R8][R29] ───────────────────────────────────────

export interface RazorpayRouteRequirement {
  field_reference: string;
  reason_code: string | null;
  status: string | null;
}

/**
 * The Route product of one linked account. `activation_status`: requested | needs_clarification |
 * under_review | activated | suspended [R8]. The settlement details Razorpay echoes back are
 * reduced to a masked `settlement_hint` ("HDFC ••••1234") and a flag; the number itself never
 * survives parsing, so polling a product can never put it into a column or a log.
 */
export interface RazorpayRouteProduct {
  id: string;
  account_id: string | null;
  product_name: string | null;
  activation_status: string;
  requirements: RazorpayRouteRequirement[];
  tnc_accepted: boolean | null;
  requested_at: number | null;
  has_settlement_details: boolean;
  settlement_hint: string | null;
}

function parseRouteProduct(json: unknown): RazorpayRouteProduct | null {
  if (!isObj(json)) return null;
  const id = str(json.id);
  const activation = str(json.activation_status);
  if (!id || !activation) return null;
  const requirements: RazorpayRouteRequirement[] = [];
  if (Array.isArray(json.requirements)) {
    for (const r of json.requirements) {
      if (!isObj(r)) continue;
      const field = str(r.field_reference);
      if (field) requirements.push({ field_reference: scrubPayoutSecrets(field).slice(0, 120), reason_code: str(r.reason_code), status: str(r.status) });
    }
  }
  const cfg = isObj(json.active_configuration) && isObj(json.active_configuration.settlements) ? json.active_configuration.settlements : null;
  const hasNumber = cfg !== null && (typeof cfg.account_number === "string" ? cfg.account_number.length > 0 : typeof cfg.account_number === "number");
  const hasIfsc = cfg !== null && str(cfg.ifsc_code) !== null;
  return {
    id,
    account_id: str(json.account_id),
    product_name: str(json.product_name),
    activation_status: activation,
    requirements,
    tnc_accepted: isObj(json.tnc) ? bool(json.tnc.accepted) : null,
    requested_at: int(json.requested_at),
    has_settlement_details: hasNumber && hasIfsc,
    settlement_hint: cfg ? destinationHint(cfg.ifsc_code, cfg.account_number) : null,
  };
}

/** POST /v2/accounts/:id/products [R8]. Terms are accepted here, so the caller must say so explicitly. */
export async function requestRouteProduct(accountId: string, opts: { tncAccepted: true }) {
  return request(
    "POST",
    `/accounts/${pathId(accountId, "account")}/products`,
    { api: "v2", body: { product_name: "route", tnc_accepted: opts.tncAccepted } },
    parseRouteProduct,
    "product configuration",
  );
}

export interface SettlementDetailsInput {
  accountNumber: string;
  ifsc: string;
  /** As the bank holds it; Razorpay allows letters, digits and spaces only [R5 errors]. */
  beneficiaryName: string;
}

/**
 * PATCH /v2/accounts/:id/products/:pid [R29]: set (or replace) the settlement bank account.
 * Whether this can CHANGE an already-activated account's bank is UNVERIFIED (FAQ Penny Testing
 * Q7 says it takes a support request), so callers use it for first-time setup only.
 */
export async function updateRouteProductSettlement(accountId: string, productId: string, input: SettlementDetailsInput) {
  return request(
    "PATCH",
    `/accounts/${pathId(accountId, "account")}/products/${pathId(productId, "product")}`,
    {
      api: "v2",
      body: {
        settlements: { account_number: input.accountNumber, ifsc_code: input.ifsc, beneficiary_name: input.beneficiaryName },
        tnc_accepted: true,
      },
    },
    parseRouteProduct,
    "product configuration",
  );
}

/** GET /v2/accounts/:id/products/:pid [api/payments/route/fetch-product-config]. */
export async function fetchRouteProduct(accountId: string, productId: string) {
  return request(
    "GET",
    `/accounts/${pathId(accountId, "account")}/products/${pathId(productId, "product")}`,
    { api: "v2" },
    parseRouteProduct,
    "product configuration",
  );
}

// ── Route: transfers, holds and reversals [R3][R10][R11][R13][R16][R21] ──────────

/** What we put in a transfer's `notes` and read back to recognise our own transfers [R11]. Nothing else is kept. */
export interface TransferNotes {
  payout_id?: string;
  booking_item_id?: string;
}

/**
 * The settlement a transfer ended up in [R21]. ⚠️ `amount_settled` is the amount of the WHOLE
 * settlement batch: Razorpay's own sample shows 200000 against a 100000 transfer. It is not the
 * creator's share and must never be shown as such. `utr` is the bank reference.
 */
export interface RazorpaySettlement {
  id: string;
  status: string | null; // processed | failed
  utr: string | null;
  fee: number | null;
  tax: number | null;
  amount_settled: number | null;
}

export interface RazorpayTransfer {
  id: string;
  /** created | pending | processed | failed | reversed | partially_reversed. The docs name the field `transfer_status`, the samples `status`; both are read. */
  status: string;
  source: string | null; // the payment (pay_…) or order the transfer came from
  recipient: string; // the linked account (acc_…)
  amount: number;
  currency: string;
  amount_reversed: number;
  on_hold: boolean;
  on_hold_until: number | null;
  settlement_status: string | null; // pending | on_hold | settled
  recipient_settlement_id: string | null;
  /** Present only when the transfer was fetched with expand[]=recipient_settlement. */
  recipient_settlement: RazorpaySettlement | null;
  fees: number | null;
  tax: number | null;
  notes: TransferNotes;
  created_at: number | null;
  processed_at: number | null;
  error: { code: string | null; description: string | null; reason: string | null } | null;
}

/** Exported for the settlement webhook, like parseRazorpayTransfer. */
export function parseRazorpaySettlement(v: unknown): RazorpaySettlement | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  return {
    id,
    status: str(v.status),
    utr: str(v.utr),
    // The doc says `fee`, the sample `fees`.
    fee: int(v.fee) ?? int(v.fees),
    tax: int(v.tax),
    amount_settled: intLoose(v.amount),
  };
}

function parseTransferNotes(v: unknown): TransferNotes {
  const out: TransferNotes = {};
  if (!isObj(v)) return out; // Razorpay sends [] for "no notes"
  const payout = str(v.payout_id);
  const item = str(v.booking_item_id);
  if (payout) out.payout_id = payout.slice(0, 64);
  if (item) out.booking_item_id = item.slice(0, 64);
  return out;
}

/**
 * Exported for the webhook handlers: a transfer entity inside an event is read through the same
 * allow-list as one fetched from the API. Null when a field money logic depends on (id, amount,
 * status, recipient, on_hold, amount_reversed) is missing or has the wrong type.
 */
export function parseRazorpayTransfer(v: unknown): RazorpayTransfer | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const amount = int(v.amount);
  const status = str(v.status) ?? str(v.transfer_status);
  const recipient = str(v.recipient);
  const amountReversed = int(v.amount_reversed);
  const onHold = bool(v.on_hold);
  if (!id || amount === null || !status || !recipient || amountReversed === null || onHold === null) return null;
  let error: RazorpayTransfer["error"] = null;
  if (isObj(v.error)) {
    const code = str(v.error.code);
    const description = str(v.error.description);
    const reason = str(v.error.reason);
    if (code || description || reason) {
      error = {
        code: code ? scrubPayoutSecrets(code).slice(0, 120) : null,
        description: description ? safeMessage(description) : null,
        reason: reason ? scrubPayoutSecrets(reason).slice(0, 120) : null,
      };
    }
  }
  return {
    id,
    status,
    source: str(v.source),
    recipient,
    amount,
    currency: str(v.currency) ?? "INR",
    amount_reversed: amountReversed,
    on_hold: onHold,
    on_hold_until: int(v.on_hold_until),
    settlement_status: str(v.settlement_status),
    recipient_settlement_id: str(v.recipient_settlement_id),
    recipient_settlement: parseRazorpaySettlement(v.recipient_settlement),
    fees: int(v.fees),
    tax: int(v.tax),
    notes: parseTransferNotes(v.notes),
    created_at: int(v.created_at),
    processed_at: int(v.processed_at),
    error,
  };
}

function parseTransferCollection(json: unknown): RazorpayTransfer[] | null {
  if (!isObj(json) || !Array.isArray(json.items)) return null;
  const parsed = json.items.map(parseRazorpayTransfer);
  return parsed.every((p): p is RazorpayTransfer => p !== null) ? parsed : null;
}

export interface CreateTransferInput {
  /** The linked account (acc_…). */
  account: string;
  amountPaise: number;
  /** Always true: a transfer is created HELD and released only after the post is verified [R11][R13]. The literal type makes an un-held transfer a compile error. */
  onHold: true;
  /** What we recognise the transfer by later. Never the brand's price, never `linked_account_notes`. */
  notes: { payout_id: string; booking_item_id: string };
}

/**
 * POST /v1/payments/:id/transfers [R11], one transfer. ⚠️ There is no idempotency key for this
 * call [R3], so a timeout leaves the outcome UNKNOWN: the caller looks the transfer up with
 * listPaymentTransfers (by notes.payout_id) before ever sending it again.
 */
export async function createTransferFromPayment(paymentId: string, input: CreateTransferInput): Promise<RazorpayTransfer> {
  const id = pathId(paymentId, "payment");
  const account = pathId(input.account, "account");
  positiveInt(input.amountPaise, "A transfer amount");
  // The type already forbids it; this stops a cast or a plain-JS caller from creating a transfer that settles at once.
  if (input.onHold !== true) throw new RazorpayError("Creator transfers are always created on hold", 400, "INVALID_REQUEST");
  const items = await request(
    "POST",
    `/payments/${id}/transfers`,
    {
      body: {
        transfers: [{ account, amount: input.amountPaise, currency: "INR", on_hold: true, notes: { payout_id: input.notes.payout_id, booking_item_id: input.notes.booking_item_id } }],
      },
    },
    parseTransferCollection,
    "transfer",
  );
  // We asked for exactly one transfer. Anything else means we cannot say which one is ours.
  if (items.length !== 1) throw new RazorpayError(`Razorpay returned ${items.length} transfers for a one-transfer request`, 200, "UNKNOWN_RESULT");
  return items[0];
}

/** GET /v1/payments/:id/transfers [R3]: every transfer made from a payment. */
export async function listPaymentTransfers(paymentId: string) {
  return request("GET", `/payments/${pathId(paymentId, "payment")}/transfers`, {}, parseTransferCollection, "transfer list");
}

/** GET /v1/transfers/:id with expand[]=recipient_settlement [R21]: the transfer and, once it has one, its settlement and bank UTR. */
export async function fetchTransfer(transferId: string) {
  return request(
    "GET",
    `/transfers/${pathId(transferId, "transfer")}`,
    { query: [["expand[]", "recipient_settlement"]] },
    parseRazorpayTransfer,
    "transfer",
  );
}

/**
 * PATCH /v1/transfers/:id [R13]: `on_hold: false` releases the settlement, `on_hold: true` holds
 * it again (indefinitely, no `on_hold_until`). Whether a released-but-unsettled transfer can be
 * held again is UNVERIFIED (plan question d).
 */
export async function setTransferHold(transferId: string, onHold: boolean) {
  return request(
    "PATCH",
    `/transfers/${pathId(transferId, "transfer")}`,
    { body: { on_hold: onHold } },
    parseRazorpayTransfer,
    "transfer",
  );
}

export interface RazorpayReversal {
  id: string;
  transfer_id: string | null;
  amount: number;
  created_at: number | null;
  notes: TransferNotes;
}

function parseReversal(json: unknown): RazorpayReversal | null {
  if (!isObj(json)) return null;
  const id = str(json.id);
  const amount = int(json.amount);
  if (!id || amount === null) return null;
  return { id, transfer_id: str(json.transfer_id), amount, created_at: int(json.created_at), notes: parseTransferNotes(json.notes) };
}

/**
 * POST /v1/transfers/:id/reversals [R16]: take back `amountPaise` from the linked account.
 *
 * ⚠️ THE AMOUNT IS ALWAYS EXPLICIT, and there is no way to ask for "all". Omitting it reverses the
 * whole transfer, and `reverse_all` on a refund reverses EVERY transfer of the payment, other
 * creators' shares included [R14][R16]. The caller passes `transfer.amount - transfer.amount_reversed`
 * read fresh, so a second reversal after a half-finished first one takes back only what is left.
 * No idempotency key exists either: after a timeout, listTransferReversals decides what happened.
 * A reversal id in the answer means it succeeded [R16].
 */
export async function reverseTransfer(transferId: string, amountPaise: number, notes?: { payout_id: string }) {
  positiveInt(amountPaise, "A reversal amount");
  return request(
    "POST",
    `/transfers/${pathId(transferId, "transfer")}/reversals`,
    { body: { amount: amountPaise, ...(notes ? { notes: { payout_id: notes.payout_id } } : {}) } },
    parseReversal,
    "reversal",
  );
}

/** GET /v1/transfers/:id/reversals [api/payments/route/fetch-reversals]. */
export async function listTransferReversals(transferId: string) {
  return request(
    "GET",
    `/transfers/${pathId(transferId, "transfer")}/reversals`,
    {},
    (json) => {
      if (!isObj(json) || !Array.isArray(json.items)) return null;
      const parsed = json.items.map(parseReversal);
      return parsed.every((p): p is RazorpayReversal => p !== null) ? parsed : null;
    },
    "reversal list",
  );
}

// ── Signatures ──────────────────────────────────────────────────────────────────

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Checkout handler signature: HMAC-SHA256(order_id|payment_id, key_secret). UI hint only. */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret = razorpayConfig.keySecret()) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC-SHA256 of the RAW request body with the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret = razorpayConfig.webhookSecret()) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}
