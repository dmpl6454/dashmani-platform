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
 * 2xx), or one held open until a test lets it go (to overlap two requests deterministically).
 */
import { razorpayHttp } from "../src/services/campaign/razorpay";

export interface FakeCall {
  method: string;
  /** The path after /v2, e.g. /accounts/acc_X/products/acc_prd_Y. */
  path: string;
  body: any;
}

export interface FakeAccount {
  id: string;
  email: string;
  stakeholder: { id: string; pan: string } | null;
  product: { id: string; status: string; settlements: { account_number: string; ifsc_code: string; beneficiary_name: string } | null; requirements: any[] } | null;
}

type Mode = "reject" | "lose" | "garbage" | "badgateway" | "hold";
export interface Rule {
  match: (c: FakeCall) => boolean;
  mode: Mode;
  /** reject only. */
  status?: number;
  body?: unknown;
  times: number;
  /** hold only: the call waits for this before it is applied. */
  gate?: Promise<void>;
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
};

export class FakeRazorpay {
  calls: FakeCall[] = [];
  accounts = new Map<string, FakeAccount>();
  /** What the product reads after the bank details are set. */
  afterBankStatus = "under_review";
  private rules: Rule[] = [];
  private n = 0;
  private real = razorpayHttp.fetch;

  install() {
    this.real = razorpayHttp.fetch;
    razorpayHttp.fetch = (async (url: any, init: any) => {
      const u = String(url).replace("https://api.razorpay.com/v2", "").replace("https://api.razorpay.com/v1", "/v1");
      const call: FakeCall = { method: init?.method ?? "GET", path: u.split("?")[0], body: init?.body ? JSON.parse(init.body) : null };
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
  }

  intercept(rule: Omit<Rule, "times"> & { times?: number }) {
    this.rules.push({ times: 1, ...rule });
  }

  count(pred: (c: FakeCall) => boolean) {
    return this.calls.filter(pred).length;
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

  private async handle(call: FakeCall): Promise<Response> {
    const rule = this.rules.find((r) => r.times > 0 && r.match(call));
    if (rule) rule.times--;
    if (rule?.mode === "hold") await rule.gate;
    if (rule?.mode === "reject") return rule.body !== undefined ? json(rule.body, rule.status ?? 400) : err("Rejected by the fake", rule.status ?? 400);
    const out = this.apply(call);
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

  private apply(call: FakeCall): Response {
    const { method, path, body } = call;
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
}
