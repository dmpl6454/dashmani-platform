/**
 * The Razorpay client (services/campaign/razorpay.ts) with razorpayHttp.fetch stubbed: no network.
 *
 * What these pin is the client's contract with the money code above it:
 *   - a 2xx with a body we cannot read is UNKNOWN, never success and never a clean failure;
 *   - isDefinitelyRejected is true only when Razorpay certainly refused;
 *   - what Razorpay echoes back (PAN, account number, IFSC, names) never survives parsing and
 *     never appears in a thrown message or a log call;
 *   - the request shapes (v2 base, PATCH, idempotency header, held transfers, explicit reversals)
 *     are exactly what the plan relies on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  razorpayHttp,
  RazorpayError,
  isDefinitelyRejected,
  createOrder,
  refundPayment,
  fetchPayment,
  fetchPaymentRefunds,
  refundedTotalPaise,
  createLinkedAccount,
  fetchLinkedAccount,
  createStakeholder,
  requestRouteProduct,
  updateRouteProductSettlement,
  fetchRouteProduct,
  createTransferFromPayment,
  listPaymentTransfers,
  fetchTransfer,
  setTransferHold,
  reverseTransfer,
  listTransferReversals,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../src/services/campaign/razorpay";

const ENV_KEYS = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = razorpayHttp.fetch;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string | undefined;
}
let calls: Call[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Replace razorpayHttp.fetch with a recorder that answers through `answer`. */
function stub(answer: (c: Call) => Response | Promise<Response>) {
  razorpayHttp.fetch = (async (url: any, init: any) => {
    const rawBody: string | undefined = init?.body;
    const call: Call = { url: String(url), method: init?.method, headers: init?.headers ?? {}, body: rawBody ? JSON.parse(rawBody) : null, rawBody };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
}

/** Run `fn` and return the error it rejects with. */
async function failure(fn: () => Promise<unknown>): Promise<RazorpayError> {
  try {
    await fn();
  } catch (e) {
    return e as RazorpayError;
  }
  throw new Error("expected the call to reject");
}

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  calls = [];
  stub(() => json({}, 404));
});
afterEach(() => {
  razorpayHttp.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Fixtures: what Razorpay really sends, secrets included ──────────────────────

const PAN = "ABCPE1234F";
const ACCOUNT_NUMBER = "1234567890123456";
const IFSC = "HDFC0000317";

const transferEntity = (over: Record<string, unknown> = {}) => ({
  id: "trf_JJD535tJtk6Yy0",
  entity: "transfer",
  status: "processed",
  source: "pay_JGmCgTEa9OTQcX",
  recipient: "acc_IROu8Nod6PXPtZ",
  amount: 12345,
  currency: "INR",
  amount_reversed: 0,
  fees: 31,
  tax: 5,
  notes: { payout_id: "po_1", booking_item_id: "it_1", name: "Gaurav Kumar", roll_no: "IEC2011025" },
  linked_account_notes: ["roll_no"],
  on_hold: true,
  on_hold_until: null,
  settlement_status: "on_hold",
  recipient_settlement_id: null,
  created_at: 1649933574,
  processed_at: 1649933579,
  error: { code: null, description: null, reason: null, field: null, step: null, id: "trf_JJD535tJtk6Yy0", source: null, metadata: null },
  source_channel: "online",
  ...over,
});

const productEntity = (over: Record<string, unknown> = {}) => ({
  requested_configuration: [],
  active_configuration: { settlements: { account_number: ACCOUNT_NUMBER, ifsc_code: IFSC, beneficiary_name: "Gaurav Kumar" } },
  requirements: [
    { field_reference: "kyc.pan", resolution_url: "/accounts/acc_1/products/acc_prd_1", reason_code: "kyc_failed", status: "required" },
  ],
  tnc: { id: "tnc_1", accepted: true, accepted_at: 1659638222 },
  id: "acc_prd_K1eopFF8G21tux",
  product_name: "route",
  activation_status: "needs_clarification",
  account_id: "acc_K1em7bWYEiwmnc",
  requested_at: 1659638222,
  ...over,
});

// ── Transport ───────────────────────────────────────────────────────────────────

describe("transport", () => {
  it("uses the v1 base for payments and transfers and the v2 base for accounts, with the right verbs", async () => {
    stub((c) => {
      if (c.url.endsWith("/orders")) return json({ id: "order_1", amount: 5000, currency: "INR", status: "created" });
      if (c.url.includes("/v2/accounts/acc_1/products/prd_1")) return json(productEntity());
      if (c.url.includes("/v2/accounts")) return json({ id: "acc_1", status: "created", type: "route" });
      if (c.url.includes("/v1/transfers/trf_1")) return json(transferEntity({ id: "trf_1" }));
      return json({}, 404);
    });
    await createOrder(5000, "rcpt", {});
    await createLinkedAccount({
      email: "a@b.co",
      phone: "9000090000",
      legalName: "Gaurav Kumar",
      contactName: "Gaurav Kumar",
      category: "services",
      subcategory: "ad_and_marketing",
      address: { street1: "507 Koramangala", city: "Bengaluru", state: "KARNATAKA", postalCode: "560034" },
    });
    await updateRouteProductSettlement("acc_1", "prd_1", { accountNumber: ACCOUNT_NUMBER, ifsc: IFSC, beneficiaryName: "Gaurav Kumar" });
    await setTransferHold("trf_1", false);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.razorpay.com/v1/orders",
      "POST https://api.razorpay.com/v2/accounts",
      "PATCH https://api.razorpay.com/v2/accounts/acc_1/products/prd_1",
      "PATCH https://api.razorpay.com/v1/transfers/trf_1",
    ]);
  });

  // The only extra header any caller passes is X-Refund-Idempotency, so this checks that it
  // arrives alongside the credentials without disturbing them. Whether a header named
  // Authorization or Content-Type would win over the credentials is not reachable from here (no
  // caller can pass one), so it is not claimed: it rests on the order of the spread in call().
  it("sends basic auth built from the configured keys and a JSON content type, next to the idempotency header", async () => {
    stub(() => json({ id: "rfnd_1", amount: 100, status: "processed" }));
    await refundPayment("pay_1", 100, "r", "rf-item-0000001");
    const expected = `Basic ${Buffer.from("rzp_test_key:rzp_test_secret").toString("base64")}`;
    expect(calls[0].headers.Authorization).toBe(expected);
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].headers["X-Refund-Idempotency"]).toBe("rf-item-0000001");
  });

  it("builds query strings with URLSearchParams and keeps the documented literal expand[] key", async () => {
    stub(() => json(transferEntity()));
    await fetchTransfer("trf_1");
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/transfers/trf_1?expand[]=recipient_settlement");

    stub(() => json({ items: [] }));
    await fetchPaymentRefunds("pay_1");
    expect(calls[calls.length - 1].url).toBe("https://api.razorpay.com/v1/payments/pay_1/refunds?count=100&skip=0");
  });

  it("refuses with NOT_CONFIGURED, sends nothing, and counts as a definite no", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    try {
      const err = await failure(() => fetchPayment("pay_1"));
      expect(err.code).toBe("NOT_CONFIGURED");
      expect(isDefinitelyRejected(err)).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    }
  });

  it("rejects an id that could rewrite the request path before anything is sent", async () => {
    for (const bad of ["../orders", "pay_1/../x", "pay_1?x=1", "", "a b"]) {
      const err = await failure(() => fetchTransfer(bad));
      expect(err.code).toBe("INVALID_REQUEST");
      expect(isDefinitelyRejected(err)).toBe(true);
    }
    expect((await failure(() => fetchPayment("../x"))).code).toBe("INVALID_REQUEST");
    expect(calls).toHaveLength(0);
  });
});

// ── Unknown results ─────────────────────────────────────────────────────────────

describe("a 2xx answer we cannot read is UNKNOWN_RESULT", () => {
  it.each([
    ["an HTML page", () => new Response("<html><body>Bad gateway</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["an empty body", () => new Response("", { status: 200 })],
    ["a 202 with no body", () => new Response(null, { status: 202 })],
    ["truncated JSON", () => new Response('{"id":"rfnd_1","amount":1', { status: 200 })],
    ["JSON null", () => new Response("null", { status: 200 })],
    ["a JSON array", () => new Response("[]", { status: 200 })],
    ["a JSON string", () => new Response('"ok"', { status: 200 })],
    ["an object without the fields we need", () => json({ entity: "refund" })],
  ])("%s", async (_name, answer) => {
    stub(() => answer());
    const err = await failure(() => refundPayment("pay_1", 100, "r", "rf-item-0000001"));
    expect(err).toBeInstanceOf(RazorpayError);
    expect(err.code).toBe("UNKNOWN_RESULT");
    expect(err.status).toBeGreaterThanOrEqual(200);
    expect(err.status).toBeLessThan(300);
    expect(isDefinitelyRejected(err)).toBe(false);
  });

  it("carries the real HTTP status of the unreadable answer", async () => {
    stub(() => new Response("<html></html>", { status: 201 }));
    expect((await failure(() => createOrder(100, "r", {}))).status).toBe(201);
  });

  it("covers every parsed call, not just refunds", async () => {
    stub(() => new Response("<html></html>", { status: 200 }));
    const calls2: Array<() => Promise<unknown>> = [
      () => createOrder(100, "r", {}),
      () => fetchPayment("pay_1"),
      () => fetchPaymentRefunds("pay_1"),
      () => fetchLinkedAccount("acc_1"),
      () => createStakeholder("acc_1", { name: "G K", email: "a@b.co", panNumber: PAN }),
      () => requestRouteProduct("acc_1", { tncAccepted: true }),
      () => fetchRouteProduct("acc_1", "prd_1"),
      () => createTransferFromPayment("pay_1", { account: "acc_1", amountPaise: 1000, onHold: true, notes: { payout_id: "p", booking_item_id: "i" } }),
      () => listPaymentTransfers("pay_1"),
      () => fetchTransfer("trf_1"),
      () => setTransferHold("trf_1", true),
      () => reverseTransfer("trf_1", 1000),
      () => listTransferReversals("trf_1"),
    ];
    for (const fn of calls2) {
      const err = await failure(fn);
      expect(err.code).toBe("UNKNOWN_RESULT");
      expect(isDefinitelyRejected(err)).toBe(false);
    }
  });

  it("a 2xx whose body dies half-way is UNKNOWN_RESULT too", async () => {
    razorpayHttp.fetch = (async () => ({ ok: true, status: 200, text: () => Promise.reject(new Error("socket hang up")) })) as unknown as typeof fetch;
    const err = await failure(() => fetchPayment("pay_1"));
    expect(err.code).toBe("UNKNOWN_RESULT");
    expect(err.status).toBe(200);
  });

  it("a non-2xx with an unreadable body keeps its status and is not mistaken for success", async () => {
    stub(() => new Response("<html>502</html>", { status: 502 }));
    const err = await failure(() => fetchPayment("pay_1"));
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("Razorpay HTTP 502");
    expect(isDefinitelyRejected(err)).toBe(false);
  });
});

describe("timeouts", () => {
  it("a request that never answers becomes status 0 NETWORK after 15 seconds", async () => {
    vi.useFakeTimers();
    razorpayHttp.fetch = ((_url: any, init: any) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
    const outcome = expect(fetchPayment("pay_1")).rejects.toMatchObject({ status: 0, code: "NETWORK" });
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
  });

  it("a body that stalls after a 2xx header is UNKNOWN_RESULT, not a clean failure", async () => {
    vi.useFakeTimers();
    razorpayHttp.fetch = ((_url: any, init: any) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          new Promise((_res, rej) => {
            init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
          }),
      })) as unknown as typeof fetch;
    const outcome = expect(fetchPayment("pay_1")).rejects.toMatchObject({ status: 200, code: "UNKNOWN_RESULT" });
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
  });

  it("a connection error is NETWORK with its message scrubbed", async () => {
    razorpayHttp.fetch = (async () => {
      throw new Error("connect ECONNRESET 1234567890123456");
    }) as typeof fetch;
    const err = await failure(() => fetchPayment("pay_1"));
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK");
    expect(err.message).not.toContain("1234567890123456");
    expect(isDefinitelyRejected(err)).toBe(false);
  });
});

// ── isDefinitelyRejected ────────────────────────────────────────────────────────

describe("isDefinitelyRejected", () => {
  const e = (status: number, code?: string) => new RazorpayError("x", status, code);

  it.each([
    [400, "BAD_REQUEST_ERROR", true],
    [401, undefined, true],
    [403, undefined, true],
    [404, undefined, true],
    [422, undefined, true],
    [408, undefined, false], // a timeout can fire after the work started
    [409, undefined, false], // the idempotent request is still being processed
    [429, undefined, false], // an edge limit: we cannot prove the backend never saw it
    [500, "SERVER_ERROR", false],
    [502, undefined, false],
    [503, undefined, false],
    [504, undefined, false],
    [302, undefined, false],
    [0, "NETWORK", false],
    [0, undefined, false],
    [200, "UNKNOWN_RESULT", false],
    [201, "UNKNOWN_RESULT", false],
    [0, "NOT_CONFIGURED", true], // nothing was sent
    [400, "INVALID_REQUEST", true], // refused locally, nothing was sent
  ])("status %s code %s -> %s", (status, code, expected) => {
    expect(isDefinitelyRejected(e(status, code))).toBe(expected);
  });

  it("is false for anything that is not a RazorpayError", () => {
    expect(isDefinitelyRejected(new Error("400"))).toBe(false);
    expect(isDefinitelyRejected({ status: 400 })).toBe(false);
    expect(isDefinitelyRejected(null)).toBe(false);
    expect(isDefinitelyRejected(undefined)).toBe(false);
    expect(isDefinitelyRejected("400")).toBe(false);
  });

  it("matches what real calls throw", async () => {
    stub(() => json({ error: { code: "BAD_REQUEST_ERROR", description: "The payment has been fully refunded already." } }, 400));
    expect(isDefinitelyRejected(await failure(() => refundPayment("pay_1", 100, "r", "rf-item-0000001")))).toBe(true);
    stub(() => json({ error: { code: "BAD_REQUEST_ERROR", description: "Request in progress" } }, 409));
    expect(isDefinitelyRejected(await failure(() => refundPayment("pay_1", 100, "r", "rf-item-0000001")))).toBe(false);
    stub(() => json({ error: { description: "boom" } }, 500));
    expect(isDefinitelyRejected(await failure(() => refundPayment("pay_1", 100, "r", "rf-item-0000001")))).toBe(false);
  });
});

// ── What Razorpay echoes back must never survive ────────────────────────────────

describe("secrets never survive parsing, errors or logging", () => {
  it("the linked account keeps ids and status only: no PAN, phone, name or address", async () => {
    stub(() =>
      json({
        id: "acc_GRWKk7qQsLnDjX",
        type: "route",
        status: "created",
        email: "gaurav.kumar@example.com",
        phone: "9000090000",
        reference_id: "creator-1",
        legal_business_name: "Gaurav Kumar",
        contact_name: "Gaurav Kumar",
        profile: { addresses: { registered: { street1: "507, Koramangala 1st block", postal_code: "560034" } } },
        legal_info: { pan: PAN, gst: "18AABCU9603R1ZM" },
        created_at: 1611136837,
      }),
    );
    const acc = await fetchLinkedAccount("acc_GRWKk7qQsLnDjX");
    expect(acc).toEqual({ id: "acc_GRWKk7qQsLnDjX", status: "created", type: "route", email: "gaurav.kumar@example.com", reference_id: "creator-1", created_at: 1611136837 });
    const dump = JSON.stringify(acc);
    for (const leaked of [PAN, "legal_info", "9000090000", "Koramangala", "560034", "18AABCU9603R1ZM", "Gaurav Kumar"]) expect(dump).not.toContain(leaked);
  });

  it("the stakeholder is reduced to its id (the echoed PAN is dropped)", async () => {
    stub(() => json({ entity: "stakeholder", id: "sth_GLGgm8fFCKc92m", name: "Gaurav Kumar", email: "g@example.com", kyc: { pan: PAN }, addresses: { residential: { street: "506, Koramangala" } } }));
    const sth = await createStakeholder("acc_1", { name: "Gaurav Kumar", email: "g@example.com", panNumber: PAN });
    expect(sth).toEqual({ id: "sth_GLGgm8fFCKc92m" });
    // The PAN had to go OUT in the request; it must not come back in anything we return.
    expect(calls[0].body.kyc.pan).toBe(PAN);
  });

  it("the product keeps only a masked hint, never the account number, IFSC or beneficiary name", async () => {
    stub(() => json(productEntity()));
    const product = await fetchRouteProduct("acc_K1em7bWYEiwmnc", "acc_prd_K1eopFF8G21tux");
    expect(product.settlement_hint).toBe("HDFC ••••3456");
    expect(product.has_settlement_details).toBe(true);
    expect(product.activation_status).toBe("needs_clarification");
    expect(product.requirements).toEqual([{ field_reference: "kyc.pan", reason_code: "kyc_failed", status: "required" }]);
    const dump = JSON.stringify(product);
    for (const leaked of [ACCOUNT_NUMBER, "1234567890", IFSC, "0000317", "Gaurav", "settlements", "account_number", "resolution_url"]) expect(dump).not.toContain(leaked);
  });

  it("a product whose account number arrives as a bare number (as in Razorpay's sample) is masked too", async () => {
    stub(() => json(productEntity({ active_configuration: { settlements: { account_number: 7878780080310012, ifsc_code: "RATN0VAAPIS", beneficiary_name: "G" } } })));
    const product = await fetchRouteProduct("acc_1", "prd_1");
    expect(product.settlement_hint).toBe("RATN ••••0012");
    expect(JSON.stringify(product)).not.toContain("7878780080310012");
  });

  it("an account number past 2^53 gives no hint rather than a wrong one", async () => {
    stub(() => new Response('{"id":"prd_1","activation_status":"activated","active_configuration":{"settlements":{"account_number":12345678901234567890,"ifsc_code":"HDFC0000317"}}}', { status: 200 }));
    const product = await fetchRouteProduct("acc_1", "prd_1");
    expect(product.settlement_hint).toBeNull();
    expect(product.has_settlement_details).toBe(true);
    expect(JSON.stringify(product)).not.toMatch(/1234567890|12345678901234567000/);
  });

  it("a product with no settlement details yet says so", async () => {
    stub(() => json(productEntity({ active_configuration: {} })));
    const product = await fetchRouteProduct("acc_1", "prd_1");
    expect(product.has_settlement_details).toBe(false);
    expect(product.settlement_hint).toBeNull();
  });

  it("the payment drops the payer's email, phone and card or VPA", async () => {
    stub(() =>
      json({ id: "pay_MT3PgKGazkDUUM", entity: "payment", amount: 1000, currency: "INR", status: "captured", order_id: "order_1", amount_refunded: 0, refund_status: null, captured: true, email: "payer@example.com", contact: "+919000090000", vpa: "payer@okbank", card_id: "card_1", created_at: 1692694191 }),
    );
    const pay = await fetchPayment("pay_MT3PgKGazkDUUM");
    expect(pay).toEqual({ id: "pay_MT3PgKGazkDUUM", amount: 1000, currency: "INR", status: "captured", captured: true, amount_refunded: 0, refund_status: null, order_id: "order_1", created_at: 1692694191 });
    expect(JSON.stringify(pay)).not.toMatch(/payer@|9000090000|okbank|card_1/);
  });

  it("transfers keep an explicit field list: no linked_account_notes, no stray notes", async () => {
    stub(() => json(transferEntity()));
    const t = await fetchTransfer("trf_JJD535tJtk6Yy0");
    expect(t.notes).toEqual({ payout_id: "po_1", booking_item_id: "it_1" });
    const dump = JSON.stringify(t);
    for (const leaked of ["linked_account_notes", "roll_no", "IEC2011025", "Gaurav Kumar", "source_channel", "entity"]) expect(dump).not.toContain(leaked);
  });

  it("error messages are scrubbed at source, on v2 account calls and everywhere else", async () => {
    const description = `Invalid IFSC Code ${IFSC} for account ${ACCOUNT_NUMBER}, PAN ${PAN} does not match`;
    stub(() => json({ error: { code: "BAD_REQUEST_ERROR", description, reason: "input_validation_failed", field: "settlements" } }, 400));
    const attempts: Array<() => Promise<unknown>> = [
      () => updateRouteProductSettlement("acc_1", "prd_1", { accountNumber: ACCOUNT_NUMBER, ifsc: IFSC, beneficiaryName: "G K" }),
      () => createStakeholder("acc_1", { name: "G K", email: "a@b.co", panNumber: PAN }),
      () => requestRouteProduct("acc_1", { tncAccepted: true }),
      () => fetchPayment("pay_1"),
      () => refundPayment("pay_1", 100, "r", "rf-item-0000001"),
    ];
    for (const fn of attempts) {
      const err = await failure(fn);
      expect(err.message).toContain("[redacted]");
      for (const leaked of [IFSC, "0000317", ACCOUNT_NUMBER, "123456789", PAN]) expect(err.message).not.toContain(leaked);
      expect(err.reason).toBe("input_validation_failed");
      expect(err.status).toBe(400);
      expect(err.code).toBe("BAD_REQUEST_ERROR");
    }
  });

  it("a failing call's error carries nothing but message, status, code and reason", async () => {
    stub(() => json({ error: { code: "BAD_REQUEST_ERROR", description: `pan ${PAN}`, metadata: { pan: PAN, account_number: ACCOUNT_NUMBER } } }, 400));
    const err = await failure(() => fetchLinkedAccount("acc_1"));
    // Own properties are the error's own bookkeeping and nothing that came out of the body.
    expect(Object.keys(err).every((k) => ["name", "status", "code", "reason", "existingAccountId"].includes(k))).toBe(true);
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toMatch(new RegExp(`${PAN}|${ACCOUNT_NUMBER}`));
  });

  it("never logs: not on success, not on failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    stub(() => json(productEntity()));
    await fetchRouteProduct("acc_1", "prd_1");
    stub(() => json({ error: { description: `bad ${ACCOUNT_NUMBER}` } }, 400));
    await failure(() => fetchRouteProduct("acc_1", "prd_1"));
    stub(() => new Response("<html></html>", { status: 200 }));
    await failure(() => fetchRouteProduct("acc_1", "prd_1"));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("a returning creator: the existing account id is read from the RAW message, before scrubbing mangles it", async () => {
    // A 14-character id with five digits in a row, which the scrubber would otherwise eat.
    stub(() => json({ error: { code: "BAD_REQUEST_ERROR", description: "Merchant email already exists for account - ab12345xyzLmNo." } }, 400));
    const err = await failure(() =>
      createLinkedAccount({ email: "a@b.co", phone: "9000090000", legalName: "Gaurav Kumar", contactName: "Gaurav Kumar", category: "services", subcategory: "ad_and_marketing", address: { street1: "507 Koramangala", city: "Bengaluru", state: "KARNATAKA", postalCode: "560034" } }),
    );
    expect(err.existingAccountId).toBe("acc_ab12345xyzLmNo");
    expect(err.message).not.toContain("12345");
    expect(isDefinitelyRejected(err)).toBe(true);

    stub(() => json({ error: { description: "Merchant email already exists for account - acc_BbHKlnuyZkf0xa." } }, 400));
    expect((await failure(() => fetchPayment("pay_1"))).existingAccountId).toBe("acc_BbHKlnuyZkf0xa");

    stub(() => json({ error: { description: "Something else" } }, 400));
    expect((await failure(() => fetchPayment("pay_1"))).existingAccountId).toBeUndefined();
  });
});

// ── Refunds ─────────────────────────────────────────────────────────────────────

describe("refundPayment", () => {
  const ok = () => json({ id: "rfnd_FP8QHiV938haTz", amount: 500100, status: "processed", payment_id: "pay_1", receipt: "r1", created_at: 1597078866, speed_processed: "normal" });

  it("sends the idempotency key in X-Refund-Idempotency and the documented body", async () => {
    stub(ok);
    const refund = await refundPayment("pay_1", 500100, "item:abc", "rf-item-550e8400-e29b-41d4");
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/payments/pay_1/refund");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["X-Refund-Idempotency"]).toBe("rf-item-550e8400-e29b-41d4");
    expect(calls[0].body).toEqual({ amount: 500100, speed: "normal", receipt: "item:abc" });
    expect(refund).toMatchObject({ id: "rfnd_FP8QHiV938haTz", amount: 500100, status: "processed", payment_id: "pay_1" });
  });

  it("still works with three arguments (the existing call sites) and sends no header", async () => {
    stub(ok);
    await refundPayment("pay_1", 500100, "item:abc");
    expect(calls[0].headers["X-Refund-Idempotency"]).toBeUndefined();
    expect(Object.keys(calls[0].headers).some((k) => k.toLowerCase().includes("idempot"))).toBe(false);
  });

  it("truncates the receipt to Razorpay's 40 characters", async () => {
    stub(ok);
    await refundPayment("pay_1", 100, "x".repeat(80), "rf-item-0000001");
    expect(calls[0].body.receipt).toHaveLength(40);
  });

  it.each([
    ["too short", "short"],
    ["nine characters", "123456789"],
    ["a space", "rf item 0000001"],
    ["a colon", "rf:item:0000001"],
    ["non-ASCII", "rf-item-ééééé"],
    ["too long", "k".repeat(129)],
    ["empty", ""],
  ])("rejects a key that is %s before sending anything", async (_n, key) => {
    stub(ok);
    const err = await failure(() => refundPayment("pay_1", 100, "r", key));
    expect(err.code).toBe("INVALID_REQUEST");
    expect(isDefinitelyRejected(err)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it.each(["abcdefghij", "rf-item-0000001", "550e8400-e29b-41d4-a716-446655440000", "A_b-C_d-E_f"])("accepts the key %s", async (key) => {
    stub(ok);
    await refundPayment("pay_1", 100, "r", key);
    expect(calls[0].headers["X-Refund-Idempotency"]).toBe(key);
  });

  it("a timeout on a refund is UNKNOWN (status 0), so the caller keeps its claim and reconciles", async () => {
    razorpayHttp.fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const err = await failure(() => refundPayment("pay_1", 100, "r", "rf-item-0000001"));
    expect(isDefinitelyRejected(err)).toBe(false);
  });
});

describe("fetchPaymentRefunds and refundedTotalPaise", () => {
  const entry = (i: number, over: Record<string, unknown> = {}) => ({ id: `rfnd_${i}`, entity: "refund", amount: 100, currency: "INR", payment_id: "pay_1", status: "processed", receipt: null, created_at: 1597078124, ...over });

  it("reads a single page", async () => {
    stub(() => json({ entity: "collection", count: 2, items: [entry(1), entry(2, { amount: 250, status: "pending" })] }));
    const refunds = await fetchPaymentRefunds("pay_1");
    expect(refunds.map((r) => r.id)).toEqual(["rfnd_1", "rfnd_2"]);
    expect(calls).toHaveLength(1);
    expect(refundedTotalPaise(refunds)).toBe(350);
  });

  it("pages through every refund, not just the default last ten", async () => {
    stub((c) => {
      const skip = Number(new URL(c.url).searchParams.get("skip"));
      const n = skip === 0 ? 100 : 3;
      return json({ items: Array.from({ length: n }, (_, i) => entry(skip + i)) });
    });
    const refunds = await fetchPaymentRefunds("pay_1");
    expect(refunds).toHaveLength(103);
    expect(calls.map((c) => new URL(c.url).searchParams.get("skip"))).toEqual(["0", "100"]);
  });

  it("an exact multiple of the page size costs one extra, empty read", async () => {
    stub((c) => json({ items: new URL(c.url).searchParams.get("skip") === "0" ? Array.from({ length: 100 }, (_, i) => entry(i)) : [] }));
    expect(await fetchPaymentRefunds("pay_1")).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it("more refunds than it can read is an error, never a short total that would let another refund through", async () => {
    stub(() => json({ items: Array.from({ length: 100 }, (_, i) => entry(i)) }));
    const err = await failure(() => fetchPaymentRefunds("pay_1"));
    expect(err.code).toBe("UNKNOWN_RESULT");
    expect(calls).toHaveLength(5);
  });

  it("one malformed entry fails the whole read instead of dropping out of the total", async () => {
    stub(() => json({ items: [entry(1), { entity: "refund", amount: 100 }] }));
    expect((await failure(() => fetchPaymentRefunds("pay_1"))).code).toBe("UNKNOWN_RESULT");
    stub(() => json({ items: [entry(1), { id: "rfnd_2", amount: "100" }] }));
    expect((await failure(() => fetchPaymentRefunds("pay_1"))).code).toBe("UNKNOWN_RESULT");
    stub(() => json({ nope: true }));
    expect((await failure(() => fetchPaymentRefunds("pay_1"))).code).toBe("UNKNOWN_RESULT");
  });

  it("an entry without a status (fields unverified) is read as unknown and still counts", async () => {
    stub(() => json({ items: [{ id: "rfnd_1", amount: 700 }] }));
    const refunds = await fetchPaymentRefunds("pay_1");
    expect(refunds[0].status).toBe("unknown");
    expect(refundedTotalPaise(refunds)).toBe(700);
  });

  it("a failed refund returned nothing and is not counted", () => {
    expect(
      refundedTotalPaise([
        { id: "a", amount: 100, status: "processed" },
        { id: "b", amount: 200, status: "failed" },
        { id: "c", amount: 400, status: "pending" },
      ]),
    ).toBe(500);
  });
});

describe("fetchPayment", () => {
  it("requires the fields money logic depends on", async () => {
    stub(() => json({ id: "pay_1", amount: 1000, currency: "INR", status: "captured" })); // no amount_refunded
    expect((await failure(() => fetchPayment("pay_1"))).code).toBe("UNKNOWN_RESULT");
  });
  it("derives captured from the status when the flag is missing", async () => {
    stub(() => json({ id: "pay_1", amount: 1000, currency: "INR", status: "captured", amount_refunded: 0 }));
    expect((await fetchPayment("pay_1")).captured).toBe(true);
  });
});

// ── Route: accounts ─────────────────────────────────────────────────────────────

describe("linked account requests", () => {
  const input = {
    email: "gaurav@example.com",
    phone: "9000090000",
    legalName: "Gaurav Kumar",
    contactName: "Gaurav Kumar",
    referenceId: "creator-uuid-1",
    category: "media_and_entertainment",
    subcategory: "others",
    address: { street1: "507 Koramangala", street2: "MG Road", city: "Bengaluru", state: "KARNATAKA", postalCode: "560034" },
  };

  it("creates an individual route account with no business PAN, and the registered address in India", async () => {
    stub(() => json({ id: "acc_1", status: "created" }));
    await createLinkedAccount(input);
    expect(calls[0].body).toEqual({
      email: "gaurav@example.com",
      phone: "9000090000",
      type: "route",
      reference_id: "creator-uuid-1",
      legal_business_name: "Gaurav Kumar",
      business_type: "individual",
      contact_name: "Gaurav Kumar",
      profile: {
        category: "media_and_entertainment",
        subcategory: "others",
        addresses: { registered: { street1: "507 Koramangala", street2: "MG Road", city: "Bengaluru", state: "KARNATAKA", postal_code: "560034", country: "IN" } },
      },
    });
    expect(calls[0].rawBody).not.toContain("legal_info");
  });

  it("omits reference_id when it is not given (the feature may not be enabled)", async () => {
    stub(() => json({ id: "acc_1" }));
    await createLinkedAccount({ ...input, referenceId: undefined });
    expect("reference_id" in calls[0].body).toBe(false);
  });

  it("the stakeholder body carries the PAN once, on kyc, as the executive owner", async () => {
    stub(() => json({ id: "sth_1" }));
    await createStakeholder("acc_1", { name: "Gaurav Kumar", email: "g@example.com", panNumber: PAN, phone: "9000090000", residential: { street: "506 Koramangala 1st block", city: "Bengaluru", state: "Karnataka", postalCode: "560034" } });
    expect(calls[0].url).toBe("https://api.razorpay.com/v2/accounts/acc_1/stakeholders");
    expect(calls[0].body).toMatchObject({ name: "Gaurav Kumar", email: "g@example.com", kyc: { pan: PAN }, relationship: { executive: true }, phone: { primary: "9000090000" } });
    expect(calls[0].body.addresses.residential).toMatchObject({ country: "IN", postal_code: "560034" });
  });

  it("the Route product is requested with terms accepted, then given its settlement details by PATCH", async () => {
    stub(() => json(productEntity()));
    await requestRouteProduct("acc_1", { tncAccepted: true });
    await updateRouteProductSettlement("acc_1", "acc_prd_1", { accountNumber: ACCOUNT_NUMBER, ifsc: IFSC, beneficiaryName: "Gaurav Kumar" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.razorpay.com/v2/accounts/acc_1/products", body: { product_name: "route", tnc_accepted: true } });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://api.razorpay.com/v2/accounts/acc_1/products/acc_prd_1",
      body: { settlements: { account_number: ACCOUNT_NUMBER, ifsc_code: IFSC, beneficiary_name: "Gaurav Kumar" }, tnc_accepted: true },
    });
  });

  it("a product without an activation status is not guessed at", async () => {
    stub(() => json(productEntity({ activation_status: undefined })));
    expect((await failure(() => fetchRouteProduct("acc_1", "prd_1"))).code).toBe("UNKNOWN_RESULT");
  });
});

// ── Route: transfers ────────────────────────────────────────────────────────────

describe("createTransferFromPayment", () => {
  const input = { account: "acc_IROu8Nod6PXPtZ", amountPaise: 12345, onHold: true as const, notes: { payout_id: "po_1", booking_item_id: "it_1" } };
  const created = (over: Record<string, unknown> = {}) => json({ entity: "collection", count: 1, items: [transferEntity({ status: "pending", settlement_status: null, processed_at: null, ...over })] });

  it("makes ONE held INR transfer from the payment, tagged with our ids and nothing else", async () => {
    stub(() => created());
    const t = await createTransferFromPayment("pay_JGmCgTEa9OTQcX", input);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/payments/pay_JGmCgTEa9OTQcX/transfers");
    expect(calls[0].body).toEqual({
      transfers: [{ account: "acc_IROu8Nod6PXPtZ", amount: 12345, currency: "INR", on_hold: true, notes: { payout_id: "po_1", booking_item_id: "it_1" } }],
    });
    expect(calls[0].rawBody).not.toContain("linked_account_notes");
    expect(calls[0].rawBody).not.toContain("on_hold_until");
    expect(t).toMatchObject({ id: "trf_JJD535tJtk6Yy0", status: "pending", recipient: "acc_IROu8Nod6PXPtZ", amount: 12345, on_hold: true, amount_reversed: 0 });
  });

  it("is always created on hold, even if a caller forces the type", async () => {
    stub(() => created());
    const err = await failure(() => createTransferFromPayment("pay_1", { ...input, onHold: false as unknown as true }));
    expect(err.code).toBe("INVALID_REQUEST");
    expect(calls).toHaveLength(0);
  });

  it.each([0, -5, 1.5, NaN, Infinity])("refuses the amount %s before sending anything", async (amountPaise) => {
    stub(() => created());
    const err = await failure(() => createTransferFromPayment("pay_1", { ...input, amountPaise }));
    expect(err.code).toBe("INVALID_REQUEST");
    expect(isDefinitelyRejected(err)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a collection that is not exactly one transfer is UNKNOWN: we cannot say which one is ours", async () => {
    stub(() => json({ entity: "collection", count: 0, items: [] }));
    expect((await failure(() => createTransferFromPayment("pay_1", input))).code).toBe("UNKNOWN_RESULT");
    stub(() => json({ entity: "collection", count: 2, items: [transferEntity(), transferEntity({ id: "trf_2" })] }));
    expect((await failure(() => createTransferFromPayment("pay_1", input))).code).toBe("UNKNOWN_RESULT");
  });

  it("a transfer missing a field the release gate needs is UNKNOWN, not a guess", async () => {
    for (const missing of ["on_hold", "amount_reversed", "recipient", "amount", "status", "id"]) {
      stub(() => json({ items: [transferEntity({ [missing]: undefined })] }));
      expect((await failure(() => createTransferFromPayment("pay_1", input))).code, missing).toBe("UNKNOWN_RESULT");
    }
  });

  it("a definite refusal (insufficient balance) is rejected cleanly and may be rolled back", async () => {
    stub(() => json({ error: { code: "BAD_REQUEST_ERROR", description: "Transfer cannot be made due to insufficient balance" } }, 400));
    const err = await failure(() => createTransferFromPayment("pay_1", input));
    expect(isDefinitelyRejected(err)).toBe(true);
  });

  it("a timeout leaves the outcome unknown (there is no idempotency key for transfers)", async () => {
    razorpayHttp.fetch = (async () => {
      throw new Error("socket closed");
    }) as typeof fetch;
    const err = await failure(() => createTransferFromPayment("pay_1", input));
    expect(err.status).toBe(0);
    expect(isDefinitelyRejected(err)).toBe(false);
  });
});

describe("transfer reads", () => {
  it("reads the status from either spelling, `status` (samples) or `transfer_status` (field list)", async () => {
    stub(() => json(transferEntity({ status: undefined, transfer_status: "failed" })));
    expect((await fetchTransfer("trf_1")).status).toBe("failed");
  });

  it("parses the settlement and bank UTR when expanded, and does not read the batch amount as the creator's share", async () => {
    stub(() =>
      json(
        transferEntity({
          amount: 100000,
          on_hold: false,
          settlement_status: "settled",
          recipient_settlement_id: "setl_LRfWxcxaJyXwde",
          recipient_settlement: { id: "setl_LRfWxcxaJyXwde", entity: "settlement", amount: 200000, status: "processed", fees: 12, tax: 2, utr: "cg8kkuoffu3jpb4k8hgg", created_at: 1678854659 },
        }),
      ),
    );
    const t = await fetchTransfer("trf_1");
    expect(t.recipient_settlement).toEqual({ id: "setl_LRfWxcxaJyXwde", status: "processed", utr: "cg8kkuoffu3jpb4k8hgg", fee: 12, tax: 2, amount_settled: 200000 });
    expect(t.amount).toBe(100000);
    expect(t.settlement_status).toBe("settled");
  });

  it("reads `fee` as well as `fees` and a string amount on the settlement", async () => {
    stub(() => json(transferEntity({ recipient_settlement: { id: "setl_1", status: "failed", fee: 7, amount: "5000" } })));
    expect((await fetchTransfer("trf_1")).recipient_settlement).toEqual({ id: "setl_1", status: "failed", utr: null, fee: 7, tax: null, amount_settled: 5000 });
  });

  it("no expanded settlement is null; an empty notes array (Razorpay's 'none') is an empty object", async () => {
    stub(() => json(transferEntity({ notes: [], recipient_settlement: undefined })));
    const t = await fetchTransfer("trf_1");
    expect(t.recipient_settlement).toBeNull();
    expect(t.notes).toEqual({});
  });

  it("keeps a transfer's error, scrubbed", async () => {
    stub(() => json(transferEntity({ status: "failed", error: { code: "BAD_REQUEST_ERROR", description: `account ${ACCOUNT_NUMBER} is closed`, reason: "account_closed", field: null, step: "x", id: "trf_1", source: "transfer", metadata: { account_number: ACCOUNT_NUMBER } } })));
    const t = await fetchTransfer("trf_1");
    expect(t.error).toEqual({ code: "BAD_REQUEST_ERROR", description: "account [redacted] is closed", reason: "account_closed" });
    expect(JSON.stringify(t)).not.toContain(ACCOUNT_NUMBER);
  });

  it("lists the transfers of a payment and fails the whole read if one entry is unreadable", async () => {
    stub(() => json({ entity: "collection", count: 2, items: [transferEntity(), transferEntity({ id: "trf_2", notes: { payout_id: "po_2" } })] }));
    const list = await listPaymentTransfers("pay_JGmCgTEa9OTQcX");
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/payments/pay_JGmCgTEa9OTQcX/transfers");
    expect(list.map((t) => t.notes.payout_id)).toEqual(["po_1", "po_2"]);

    stub(() => json({ items: [transferEntity(), { id: "trf_x" }] }));
    expect((await failure(() => listPaymentTransfers("pay_1"))).code).toBe("UNKNOWN_RESULT");
  });

  it("an empty list is a real, empty answer (the first listing before a retry)", async () => {
    stub(() => json({ entity: "collection", count: 0, items: [] }));
    expect(await listPaymentTransfers("pay_1")).toEqual([]);
  });
});

describe("holds", () => {
  it("releases with on_hold false and holds again with on_hold true, nothing else in the body", async () => {
    stub(() => json(transferEntity()));
    await setTransferHold("trf_1", false);
    await setTransferHold("trf_1", true);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "https://api.razorpay.com/v1/transfers/trf_1", { on_hold: false }],
      ["PATCH", "https://api.razorpay.com/v1/transfers/trf_1", { on_hold: true }],
    ]);
  });
});

describe("reverseTransfer", () => {
  const reversal = (over: Record<string, unknown> = {}) => json({ id: "rvrsl_EB0BWgGDAu7tOz", entity: "reversal", transfer_id: "trf_1", amount: 12345, fee: 0, tax: 0, currency: "INR", notes: [], initiator_id: "CJoeHMNpi0nC7k", customer_refund_id: null, created_at: 1580456007, ...over });

  it("always sends an explicit amount and never reverse_all", async () => {
    stub(() => reversal());
    const r = await reverseTransfer("trf_1", 12345);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/transfers/trf_1/reversals");
    expect(calls[0].body).toEqual({ amount: 12345 });
    expect(Object.keys(calls[0].body)).toEqual(["amount"]);
    expect(calls[0].rawBody).not.toMatch(/reverse_all/i);
    expect(r).toEqual({ id: "rvrsl_EB0BWgGDAu7tOz", transfer_id: "trf_1", amount: 12345, created_at: 1580456007, notes: {} });
  });

  it("can tag the reversal with our payout id so an unknown result can be matched later", async () => {
    stub(() => reversal({ notes: { payout_id: "po_1", extra: "dropped" } }));
    const r = await reverseTransfer("trf_1", 500, { payout_id: "po_1" });
    expect(calls[0].body).toEqual({ amount: 500, notes: { payout_id: "po_1" } });
    expect(r.notes).toEqual({ payout_id: "po_1" });
  });

  it.each([0, -1, 1.5, NaN, Infinity, undefined as unknown as number])("refuses the amount %s, so 'reverse everything' is not one slip away", async (amount) => {
    stub(() => reversal());
    const err = await failure(() => reverseTransfer("trf_1", amount));
    expect(err.code).toBe("INVALID_REQUEST");
    expect(isDefinitelyRejected(err)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("an insufficient-balance refusal is definite (nothing was reversed); a timeout is not", async () => {
    stub(() => json({ error: { code: "BAD_REQUEST_ERROR", description: "The linked account does not have sufficient balance to process reversal." } }, 400));
    expect(isDefinitelyRejected(await failure(() => reverseTransfer("trf_1", 100)))).toBe(true);
    razorpayHttp.fetch = (async () => {
      throw new Error("timeout");
    }) as typeof fetch;
    expect(isDefinitelyRejected(await failure(() => reverseTransfer("trf_1", 100)))).toBe(false);
  });

  it("a reversal answer without an id is UNKNOWN, not a success", async () => {
    stub(() => json({ entity: "reversal", amount: 100 }));
    expect((await failure(() => reverseTransfer("trf_1", 100))).code).toBe("UNKNOWN_RESULT");
  });

  it("lists the reversals of a transfer", async () => {
    stub(() => json({ entity: "collection", count: 1, items: [{ id: "rvrsl_1", entity: "reversal", transfer_id: "trf_1", amount: 50000, fee: 0, tax: 0, currency: "INR", notes: [], utr: null, created_at: 1684822489 }] }));
    const list = await listTransferReversals("trf_1");
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.razorpay.com/v1/transfers/trf_1/reversals" });
    expect(list).toEqual([{ id: "rvrsl_1", transfer_id: "trf_1", amount: 50000, created_at: 1684822489, notes: {} }]);
  });
});

// ── Unchanged exports ───────────────────────────────────────────────────────────

describe("orders and signatures (existing behaviour)", () => {
  it("createOrder still posts to /v1/orders with auto-capture and returns the order", async () => {
    stub(() => json({ id: "order_1", amount: 5000, currency: "INR", status: "created", receipt: "r", extra: "dropped" }));
    const order = await createOrder(5000, "r".repeat(60), { bookingId: "b1" });
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/orders");
    expect(calls[0].body).toEqual({ amount: 5000, currency: "INR", receipt: "r".repeat(40), notes: { bookingId: "b1" }, payment_capture: 1 });
    expect(order).toEqual({ id: "order_1", amount: 5000, currency: "INR", status: "created" });
  });

  it("verifies the checkout and webhook signatures", () => {
    const sig = crypto.createHmac("sha256", "rzp_test_secret").update("order_1|pay_1").digest("hex");
    expect(verifyCheckoutSignature("order_1", "pay_1", sig)).toBe(true);
    expect(verifyCheckoutSignature("order_1", "pay_2", sig)).toBe(false);
    const raw = Buffer.from('{"event":"x"}');
    const wh = crypto.createHmac("sha256", "whsec_test").update(raw).digest("hex");
    expect(verifyWebhookSignature(raw, wh)).toBe(true);
    expect(verifyWebhookSignature(raw, "00")).toBe(false);
    expect(verifyWebhookSignature(raw, undefined)).toBe(false);
  });
});
