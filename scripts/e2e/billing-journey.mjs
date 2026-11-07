#!/usr/bin/env node
/**
 * Drives every billing-portal journey in a real browser and reports what happened (LOCAL ONLY).
 * The billing portal (apps/billing, billing.digitalsukoon.com, 2026-11-07) holds what used to be
 * the sales portal's Bill + Finance half; these are the steps that moved out of sales-journey.mjs:
 *
 *   sign-in (deep link, wrong password) → company switch → settings for both companies →
 *   a client (made through the API — the Clients pages live on the sales portal) → draft invoice →
 *   issue → PDF → partial payment → credit note → advance receipt → refund → void → proforma →
 *   convert → issue → dashboard → portal switcher → a link to the sales portal lands signed in →
 *   IGST / GST-changed / over-payment / advance applied / cancel → invoice search → accounts →
 *   tally → Swipe import → a Sales-role (non-admin) user → a 390 px pass over every page → sign out.
 *
 * Needs: the API on :4000, the built portal served on :3007 (`npx serve apps/billing/out -l 3007`),
 * the sales portal served on :3006 for the cross-portal step (optional — that check fails
 * softly), the seeded admin, a Sales-role user (E2E_SALES_EMAIL / E2E_SALES_PASSWORD), and
 * playwright-core + Chromium (PLAYWRIGHT_MODULE / CHROMIUM_PATH).
 *
 *   node scripts/e2e/billing-journey.mjs     # JSON summary; screenshots in OUT_DIR
 *
 * Every expectation is a soft check; a step that cannot continue stops only that journey.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BILLING_URL ?? "http://localhost:3007";
const SALES_BASE = process.env.SALES_URL ?? "http://localhost:3006";
const API = process.env.API_URL ?? "http://localhost:4000/v1";
const OUT = process.env.OUT_DIR ?? path.resolve("e2e-shots/billing");
const ADMIN = { email: process.env.ADMIN_EMAIL ?? "admin@digitalsukoon.com", password: process.env.ADMIN_PASSWORD ?? "Admin@123456" };
const SALES = { email: process.env.E2E_SALES_EMAIL ?? "sales-e2e@digitalsukoon.test", password: process.env.E2E_SALES_PASSWORD ?? "SalesE2E@12345" };
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const { chromium } = pw.default ?? pw;
fs.mkdirSync(OUT, { recursive: true });

const out = { checks: [], journeys: {}, consoleErrors: [], badResponses: [], overflow: [] };
const check = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail ?? "") }) }); return !!ok; };
const stamp = Date.now().toString().slice(-6);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(15_000);
let current = "boot";
page.on("console", (m) => { if (m.type() === "error") out.consoleErrors.push({ journey: current, text: m.text().slice(0, 300) }); });
page.on("pageerror", (e) => out.consoleErrors.push({ journey: current, text: `pageerror: ${e.message.slice(0, 300)}` }));
// 4xx/5xx the UI did not ask for on purpose (expected ones are listed per journey).
const expected = new Set();
page.on("response", (r) => {
  const u = r.url();
  if (!u.startsWith(API) || r.status() < 400) return;
  const key = `${r.request().method()} ${new URL(u).pathname.replace(/[0-9a-f-]{36}/g, ":id")} ${r.status()}`;
  if (!expected.has(key)) out.badResponses.push({ journey: current, key });
});

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});
const go = async (p) => { await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" }); await page.waitForLoadState("networkidle").catch(() => {}); };
const settle = () => page.waitForLoadState("networkidle").catch(() => {});
const text = () => page.locator("main").innerText().catch(() => "");
/** Wait until the page has rendered past its loading spinner. */
const ready = async () => { await page.locator("main [role=status]").filter({ hasText: /Loading|Adding things up/ }).first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {}); await page.locator("main h1").first().waitFor({ timeout: 15_000 }).catch(() => {}); };
// html/body hide horizontal overflow, so scrollWidth alone cannot see content cut off at the
// right edge. Measure element edges instead: anything past the viewport that is not inside its
// own scroll container is clipped content.
const overflowCheck = async (label) => {
  const found = await page.evaluate(() => {
    const vw = window.innerWidth;
    const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox === "auto" || ox === "scroll") return true; } return false; };
    const hits = [];
    for (const el of document.querySelectorAll("header *, main *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1 || clipped(el)) continue;
      if (hits.some((h) => h.el.contains(el))) continue;
      hits.push({ el, by: Math.round(r.right - vw) });
    }
    return hits.slice(0, 4).map((h) => `${h.el.tagName.toLowerCase()}.${String(h.el.className).split(" ").slice(0, 3).join(".")} +${h.by}px`);
  });
  if (found.length) out.overflow.push({ page: label, offenders: found });
};

async function journey(name, fn) {
  current = name;
  const t0 = Date.now();
  try { await fn(); out.journeys[name] = { ok: true, ms: Date.now() - t0 }; }
  catch (e) { out.journeys[name] = { ok: false, ms: Date.now() - t0, error: e.message.split("\n")[0].slice(0, 300) }; await shot(`FAIL-${name}`); }
}

async function signIn(who) {
  await go("/login");
  await page.getByLabel("Work email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });
  await settle();
}
async function signOut() {
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/);
}
const setCompany = async (label) => { await page.getByRole("radio", { name: new RegExp(label) }).click(); await settle(); };
const toastText = async () => (await page.getByRole("status").filter({ hasNotText: /Loading/ }).allInnerTexts().catch(() => [])).join(" | ");

/** Clients are made on the sales portal; here they come straight from the API (same POST the New client page makes). */
async function newClient(name, stateCode, gstin) {
  const r = await page.evaluate(async ({ API, name, stateCode, gstin }) => {
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("accessToken")}` };
    const c = await fetch(`${API}/sales/clients`, { method: "POST", headers: h, body: JSON.stringify({ companyName: name, contactName: "Test", email: `${name.replace(/\W+/g, "").toLowerCase()}@x.test` }) }).then((x) => x.json());
    if (stateCode) await fetch(`${API}/sales/clients/${c.data.id}/billing`, { method: "PUT", headers: h, body: JSON.stringify({ legalName: `${name} Pvt Ltd`, gstin, stateCode, addressLine1: "1 Test Road", city: "Bengaluru", pincode: "560001" }) });
    return c.data.id;
  }, { API, name, stateCode, gstin });
  return r;
}
async function draftInvoice(clientId, amount, label = "Reel") {
  await go(`/invoices/edit?clientId=${clientId}`); await ready();
  const row = page.locator("tbody tr").first();
  await row.locator("input").first().fill(label);
  await row.locator("input[inputmode=decimal]").first().fill(String(amount));
  await page.getByRole("button", { name: /Save draft/ }).click();
  await page.waitForURL(/\/invoices\/view\?id=/); await settle(); await ready();
  return new URL(page.url()).searchParams.get("id");
}
async function issueOpen() {
  await page.getByRole("button", { name: "Issue" }).first().click();
  await page.getByRole("dialog").waitFor();
}

const ids = {};

// ── 1. Sign-in ────────────────────────────────────────────────────────────────────
await journey("sign-in", async () => {
  await ctx.clearCookies();
  await go("/invoices");
  await page.waitForURL(/\/login\?next=/);
  check("signed-out deep link goes to /login?next=", page.url().includes("next=%2Finvoices"), page.url());
  await page.getByLabel("Work email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password-123");
  expected.add("POST /v1/auth/login 401");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(1200);
  check("wrong password shows an error and stays", page.url().includes("/login") && /invalid|incorrect|wrong|don.t match|do not match/i.test(await page.locator("body").innerText()), await page.locator("body").innerText().then((t) => t.slice(0, 200)));
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/invoices/, { timeout: 15_000 });
  check("sign-in returns to the deep link", page.url().includes("/invoices"), page.url());
  check("the header says Billing", /Billing/.test(await page.locator("header").innerText()), "");
});

// ── 2. Company switch + settings ──────────────────────────────────────────────────
const profile = {
  dspl: { legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West", city: "Mumbai", pincode: "400053" },
  dmpl: { legalName: "Dashmani Media Private Limited", gstin: "27AAJCD7425L1Z8", pan: "AAJCD7425L", addressLine1: "Off-702, Parinee I, Plot No 7/A", city: "Mumbai", pincode: "400053" },
};
await journey("company-and-settings", async () => {
  await go("/settings");
  for (const [key, label] of [["dspl", "Digital Sukoon"], ["dmpl", "Dashmani Media"]]) {
    await setCompany(label);
    await page.getByRole("heading", { name: `${label} billing profile` }).waitFor();
    check(`header brand follows ${label}`, (await page.locator("header").innerText()).includes(`${label}`), "");
    const p = profile[key];
    for (const [l, v] of [["Legal name", p.legalName], ["GSTIN", p.gstin], ["PAN", p.pan], ["Address line 1", p.addressLine1], ["City", p.city], ["PIN code", p.pincode]]) {
      // A field's hint sits inside its <label>, so match the label by its start.
      const loc = page.getByLabel(new RegExp(`^${l}`)).first();
      const ok = await loc.fill(v, { timeout: 5000 }).then(() => true).catch((e) => e.message.split("\n").slice(0, 3).join(" "));
      if (ok !== true) { check(`settings field "${l}" is fillable (${label})`, false, ok); throw new Error(`field ${l}`); }
    }
    await page.getByRole("button", { name: "Save profile" }).click();
    const toast = page.getByRole("status").filter({ hasText: /Saved/ });
    check(`settings save for ${label}`, await toast.waitFor({ timeout: 8000 }).then(() => true).catch(() => false), await text().then((t) => t.slice(0, 300)));
  }
  await page.reload({ waitUntil: "domcontentloaded" }); await settle();
  check("company choice survives a reload", await page.getByRole("heading", { name: "Dashmani Media billing profile" }).isVisible().catch(() => false), "");
  await setCompany("Digital Sukoon");
});

// ── 3. Draft invoice → issue → PDF → sent ─────────────────────────────────────────
await journey("invoice-issue-pdf", async () => {
  ids.client = await newClient(`E2E Brand ${stamp}`, "27", "27AABCU9603R1ZX");
  check("client created through the API", !!ids.client, "");
  ids.invoice = await draftInvoice(ids.client, 4000, "Reel");
  await issueOpen(); await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click();
  await settle(); await page.waitForTimeout(800);
  const h = await page.locator("h1").innerText();
  check("invoice issues with a DS number", /DS\/\d\d-\d\d\/\d{4}/.test(h), h);
  const pdfBtn = page.getByRole("button", { name: /PDF/ }).first();
  const dl = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }).catch(() => null), pdfBtn.click()]).then(([d]) => d);
  check("invoice PDF downloads", !!dl, "no download");
  if (dl) { const f = path.join(OUT, "invoice.pdf"); await dl.saveAs(f); check("PDF is a real PDF", fs.readFileSync(f).subarray(0, 4).toString() === "%PDF", ""); }
  await page.getByRole("button", { name: "Mark sent" }).click(); await settle();
  check("mark sent", /sent/i.test(await text()), "");
});

// ── 4. Payment, credit note ───────────────────────────────────────────────────────
await journey("payment-and-credit", async () => {
  await go(`/invoices/view?id=${ids.invoice}`);
  await page.getByRole("link", { name: "Record payment" }).click();
  await page.waitForURL(/\/payments\/record/); await settle(); await ready(); await page.getByText("Received by").waitFor().catch(() => {});
  check("payment form names the receiving company", /digital sukoon private limited/i.test(await text()), (await text()).slice(0, 200));
  await page.getByLabel("Amount received").fill("1000");
  // the preset allocation follows the balance; set it to what we received
  const alloc = page.locator("tbody tr").first().locator("input[inputmode=decimal]").first();
  await alloc.fill("1000");
  await page.getByLabel(/Reference/).fill(`UTR${stamp}`);
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL(/\/invoices\/view\?id=/, { timeout: 15_000 }); await settle();
  check("invoice is partially paid after a part payment", /partially paid/i.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
  await page.getByRole("button", { name: "Credit note" }).click();
  await page.getByLabel("Reason").fill("One post was not delivered");
  await page.getByLabel("Taxable amount to credit").fill("500");
  await page.getByRole("button", { name: "Issue credit note" }).click();
  await settle(); await page.waitForTimeout(800);
  check("credit note issued (CN number shown)", /CN\/\d\d-\d\d\/\d{4}/.test(await text()), (await text()).slice(0, 400));
});

// ── 5. Advance, refund, void ──────────────────────────────────────────────────────
await journey("advance-refund-void", async () => {
  await go(`/payments/record?clientId=${ids.client}`);
  await page.getByLabel("Amount received").fill("3000");
  // leave everything unallocated → an advance
  for (const inp of await page.locator("tbody input[inputmode=decimal]").all()) await inp.fill("0");
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL(/\/payments(\?|$|\/)/); await settle();
  await page.getByRole("link", { name: /RCPT\// }).first().click();
  await page.waitForURL(/\/payments\/view\?id=/); await settle(); await ready();
  ids.receipt = new URL(page.url()).searchParams.get("id");
  check("advance shows unallocated money", /unallocated/i.test(await text()), (await text()).slice(0, 300));
  await page.getByRole("button", { name: "Refund" }).click();
  await page.getByLabel("Amount refunded").fill("500");
  await page.getByLabel(/Reference/).fill(`RF${stamp}`);
  await page.getByRole("dialog").getByRole("button", { name: /refund/i }).last().click();
  await settle(); await page.waitForTimeout(600);
  check("refund numbered RF/", /RF\/\d\d-\d\d\/\d{4}/.test(await text()), (await text()).slice(0, 300));
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click(); await settle(); await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Void receipt" }).click();
  await page.getByLabel("Reason").fill("Recorded twice by mistake");
  await page.getByRole("dialog").getByRole("button", { name: "Void receipt" }).click();
  await settle(); await page.waitForTimeout(600);
  check("receipt voided", /voided/i.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
});

// ── 6. Proforma → tax invoice ─────────────────────────────────────────────────────
await journey("proforma", async () => {
  await go(`/invoices/edit?clientId=${ids.client}`);
  await page.getByLabel("Kind").selectOption("proforma");
  const row = page.locator("tbody tr").first();
  await row.locator("input").first().fill("Advance for festive campaign");
  await row.locator("input[inputmode=decimal]").first().fill("10000");
  await page.getByRole("button", { name: /Save draft/ }).click();
  await page.waitForURL(/\/invoices\/view\?id=/); await settle();
  await page.getByRole("button", { name: "Issue" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click();
  await settle(); await page.waitForTimeout(800);
  check("proforma numbered PI/", /PI\/\d\d-\d\d\/\d{4}/.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
  await page.getByRole("button", { name: "Convert to tax invoice" }).click();
  await page.getByRole("button", { name: "Create draft tax invoice" }).click();
  await page.waitForURL(/\/invoices\/view\?id=/); await settle(); await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Issue" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click();
  await settle(); await page.waitForTimeout(800);
  check("converted invoice issues as DS/", /DS\/\d\d-\d\d\/\d{4}/.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
});

// ── 7. Dashboard ──────────────────────────────────────────────────────────────────
await journey("dashboard", async () => {
  await go("/dashboard");
  await page.getByText("Billing at a glance").waitFor();
  const t = await text();
  check("dashboard shows invoiced amount", /Invoiced this FY\s*₹[1-9]/i.test(t), t.slice(0, 300));
  check("dashboard shows collections", /Collected this FY/.test(t), "");
  await page.locator("a[href='/invoices?status=overdue']").click();
  await page.waitForURL(/\/invoices/).catch(() => {}); await settle();
  check("overdue tile opens the invoices list on its tab", page.url().includes("status=overdue"), page.url());
  await go("/dashboard"); await ready();
  const clientLink = page.locator("main a[href*='/clients/view?id=']").first();
  if (await clientLink.count()) check("top-client links point at the sales portal", (await clientLink.getAttribute("href") ?? "").startsWith("http"), await clientLink.getAttribute("href"));
});

// ── 8. Portal switcher + a link across to the sales portal ────────────────────────
await journey("portal-switcher", async () => {
  await go("/dashboard");
  await page.getByRole("button", { name: /Portals/ }).click();
  check("switcher lists the staff portal", await page.getByText(/Staff portal|portal\.digitalsukoon|Internal/i).first().isVisible().catch(() => false), "");
  check("switcher lists the sales portal", await page.getByText(/Sales portal/i).first().isVisible().catch(() => false), "");
  check("switcher does not list itself", !(await page.getByRole("menuitem", { name: /Billing portal/ }).count()), "");
  await page.keyboard.press("Escape");
});
await journey("cross-portal-link", async () => {
  // A client's name on Payments is a link to the sales portal: one click lands there signed in
  // (POST /auth/handoff {target:"sales", next} → /login?next=…#handoff= → the client page).
  await go("/payments"); await ready();
  const link = page.locator("main a[href*='/clients/view?id=']").first();
  if (!(await link.count())) { check("a client link exists on Payments", false, "none"); return; }
  check("the link's href is the sales portal's absolute URL", (await link.getAttribute("href") ?? "").startsWith(SALES_BASE), await link.getAttribute("href"));
  await link.click();
  const landed = await page.waitForURL((u) => u.href.startsWith(SALES_BASE) && u.pathname.startsWith("/clients/view"), { timeout: 20_000 }).then(() => true).catch(() => false);
  check("one click lands on the client's page on the sales portal, signed in", landed && !page.url().includes("/login"), page.url());
  await go("/payments");
});

// ── 9. Branching journeys ─────────────────────────────────────────────────────────
await journey("inter-state-igst", async () => {
  const ka = await newClient(`E2E Karnataka ${stamp}`, "29", "29AAACB1234F1Z9");
  ids.ka = ka;
  ids.kaInv = await draftInvoice(ka, 10000);
  await issueOpen(); await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click(); await settle(); await ready(); await page.waitForTimeout(500);
  const t = await text();
  check("other-state client is billed IGST", /IGST/.test(t) && !/CGST @/.test(t), t.slice(0, 400));
});

await journey("gst-changed-before-issue", async () => {
  const c = await newClient(`E2E Late profile ${stamp}`);
  const inv = await draftInvoice(c, 5000);
  // the client's billing state is added after the draft was saved
  await page.evaluate(async ({ API, c }) => {
    const h = { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("accessToken")}` };
    await fetch(`${API}/sales/clients/${c}/billing`, { method: "PUT", headers: h, body: JSON.stringify({ legalName: "Late Pvt Ltd", gstin: "29AAACB1234F1Z9", stateCode: "29", addressLine1: "2 Road", city: "Bengaluru", pincode: "560001" }) });
  }, { API, c });
  await go(`/invoices/view?id=${inv}`); await ready();
  expected.add("POST /v1/sales/invoices/:id/issue 409");
  await issueOpen(); await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click(); await settle(); await page.waitForTimeout(600);
  const dlg = await page.getByRole("dialog").innerText().catch(() => "");
  check("issue asks to update or keep a changed GST", /Update|keep/i.test(dlg), dlg.slice(0, 300) || (await toastText()));
  const upd = page.getByRole("dialog").getByRole("button", { name: /update/i }).first();
  if (await upd.count()) { await upd.click(); await settle(); await page.waitForTimeout(600); }
  check("issuing with the updated GST gives IGST", /IGST/.test(await text()) && /DS\//.test(await page.locator("h1").innerText()), (await page.locator("h1").innerText()));
});

await journey("over-payment-and-over-credit", async () => {
  await go(`/invoices/view?id=${ids.kaInv}`); await ready();
  await page.getByRole("button", { name: "Credit note" }).click();
  await page.getByLabel("Reason").fill("Too much");
  await page.getByLabel("Taxable amount to credit").fill("999999");
  expected.add("POST /v1/sales/credit-notes 409");
  await page.getByRole("button", { name: "Issue credit note" }).click(); await page.waitForTimeout(800);
  const msg = (await page.getByRole("dialog").innerText().catch(() => "")) + " " + (await toastText());
  check("over-credit is refused with a readable message", /can still be credited|Only/i.test(msg), msg.slice(0, 300));
  await page.keyboard.press("Escape");
  await go(`/payments/record?clientId=${ids.ka}&invoiceId=${ids.kaInv}&company=dspl`); await ready(); await page.getByText("Received by").waitFor();
  await page.getByLabel("Amount received").fill("999999");
  const alloc = page.locator("tbody tr").first().locator("input[inputmode=decimal]").first();
  await alloc.fill("999999");
  await page.getByRole("button", { name: "Record payment" }).click(); await page.waitForTimeout(800);
  check("over-allocation is stopped before saving (no request sent)", page.url().includes("/payments/record") && /outstanding/i.test(await toastText()) && !out.badResponses.some((b) => b.key.startsWith("POST /v1/sales/payments ")), (await toastText()));
});

await journey("apply-advance-to-invoice", async () => {
  // advance for the Karnataka client, then apply it from the invoice
  await go(`/payments/record?clientId=${ids.ka}`); await ready(); await page.getByText("Received by").waitFor();
  await page.getByLabel("Amount received").fill("2000");
  for (const inp of await page.locator("tbody input[inputmode=decimal]").all()) await inp.fill("0");
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.waitForURL(/\/payments(\?|$|\/)/); await settle();
  await go(`/invoices/view?id=${ids.kaInv}`); await ready();
  await page.getByRole("button", { name: "Apply a receipt" }).click();
  await page.getByLabel("Amount to apply").fill("2000");
  await page.getByRole("dialog").getByRole("button", { name: /apply/i }).last().click(); await settle(); await page.waitForTimeout(800);
  check("advance applied to the invoice", /partially paid/i.test(await page.locator("h1").innerText()), await page.locator("h1").innerText() + " " + (await toastText()));
});

await journey("cancel-invoice", async () => {
  const c = await newClient(`E2E Cancel ${stamp}`, "27", "27AABCU9603R1ZX");
  await draftInvoice(c, 3000);
  await issueOpen(); await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click(); await settle(); await ready(); await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await page.getByLabel("Reason").fill("Raised in error");
  await page.getByRole("button", { name: "Cancel invoice" }).click(); await settle(); await page.waitForTimeout(500);
  check("issued, unpaid invoice cancels and keeps its number", /cancelled/i.test(await page.locator("h1").innerText()) && /DS\//.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
});

await journey("invoice-search", async () => {
  await go("/invoices"); await ready();
  await page.getByPlaceholder(/Search/).fill(`E2E Brand ${stamp}`); await page.waitForTimeout(700); await settle();
  const rows = await page.locator("tbody tr").count();
  check("invoice search narrows to the client", rows > 0 && rows < 10, rows);
});

// smart-invoicing: accounts steps
await journey("accounts-page", async () => {
  await go("/accounts"); await ready(); await page.getByRole("heading", { name: "Accounts", exact: true, level: 1 }).waitFor();
  check("accounts page shows the live figures", /Invoiced/.test(await text()) && /GST output/.test(await text()), (await text()).slice(0, 200));
  const pills = page.getByRole("radiogroup", { name: "Financial year" }).getByRole("radio");
  const n = await pills.count();
  check("financial-year pills listed", n >= 4, n);
  // The whole year's sales register: header line first.
  const fyLabel = (await pills.first().innerText()).slice(0, 7);
  await page.getByLabel("Return period").selectOption(fyLabel);
  const register = page.getByRole("button", { name: /Sales register CSV/ });
  if (await register.isEnabled()) {
    const [dl] = await Promise.all([page.waitForEvent("download"), register.click()]);
    const body = await (await import("node:fs/promises")).readFile(await dl.path(), "utf8");
    check("register CSV starts with its header", body.replace(/^﻿/, "").startsWith("Seller GSTIN,Section,Document"), body.slice(0, 80));
  }
  // A closed year's filed figures, typed in lakhs with a loss.
  await pills.nth(1).click(); await settle(); await page.waitForTimeout(500);
  const closed = (await pills.nth(1).innerText()).slice(0, 7);
  await go(`/accounts/filed?fy=${closed}&company=dspl`); await ready();
  await page.getByLabel("Typing figures in").selectOption("lakhs");
  // exact: the sign toggle's group is labelled "Profit after tax: Profit or Loss".
  const revenue = page.getByRole("textbox", { name: "Revenue from operations", exact: true });
  const pat = page.getByRole("textbox", { name: "Profit after tax", exact: true });
  await revenue.fill("48.2153");
  await pat.fill("12");
  await page.getByRole("group", { name: /Profit after tax/ }).getByRole("button", { name: "Loss" }).click();
  // A red box blocks Save; fixing it unblocks it.
  await pat.fill("12.3.4");
  await page.getByText("Fix the figures marked in red first.").waitFor({ timeout: 3_000 }).catch(() => {});
  check("an invalid figure disables Save", await page.getByRole("button", { name: "Save filed figures" }).isDisabled(), "enabled");
  await pat.fill("12");
  await page.locator("input[type=file]").setInputFiles({ name: "signed.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n%e2e\n") });
  await page.waitForTimeout(1200);
  check("signed PDF attached", /signed\.pdf/.test(await text()), await toastText());
  check("the first attach keeps the typed figures", (await revenue.inputValue()) === "48.2153" && (await page.getByLabel("Typing figures in").inputValue()) === "lakhs", await revenue.inputValue());
  await page.getByRole("button", { name: "Save filed figures" }).click();
  await page.waitForURL(/\/accounts\?fy=/); await settle(); await ready();
  check("the save is confirmed on /accounts", /Filed figures for .* saved\.|Nothing changed\./.test(await toastText()), await toastText()); // a re-run saves the same figures
  check("filed row shows in Filed accounts vs the portal", /48,21,530/.test(await text()), (await text()).slice(-400));
});

// smart-invoicing: tally steps
await journey("tally-pages", async () => {
  for (const p of ["/tally", "/tally/settings", "/tally/parties"]) {
    await go(p); await ready(); await page.waitForTimeout(400);
    const body = await page.locator("main").innerText().catch(() => "");
    check(`${p} renders`, /Tally|Party ledgers/.test(body), body.slice(0, 120));
  }
});

// smart-invoicing: import steps
await journey("swipe-import-check", async () => {
  // A one-invoice Swipe export, uploaded through the page: the check is built in the same request.
  const csv = ["Invoice Number,Invoice Date,Customer Name,Customer GSTIN,Taxable Value,CGST,SGST,Total,Amount Paid,Balance",
    `INV/22-23/${String(Date.now() % 9000 + 1000)},01/10/2022,E2E Swipe ${stamp},,1000.00,90.00,90.00,1180.00,1180.00,0.00`].join("\r\n");
  await go("/invoices/import"); await ready();
  await page.locator("input[type=file]").setInputFiles({ name: "swipe-e2e.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: /Upload and check/ }).click();
  await page.waitForURL(/\/invoices\/import\/view\?id=/, { timeout: 20_000 });
  await ready(); await settle();
  ids.swipeImport = new URL(page.url()).searchParams.get("id");
  check("swipe import: check shows one invoice found", (await page.getByText("Invoices found").count()) > 0, page.url());
  // The count is the invoices READY to import; a row for a client staff have not confirmed yet is not.
  check("swipe import: import button present", (await page.getByRole("button", { name: /^Import \d+ invoices/ }).count()) > 0);
});

await journey("desktop-screens", async () => {
  for (const [n, p] of [["dashboard", "/dashboard"], ["invoices", "/invoices"], ["invoice", `/invoices/view?id=${ids.invoice}`], ["invoice-ka", `/invoices/view?id=${ids.kaInv}`], ["payments", "/payments"], ["receipt", `/payments/view?id=${ids.receipt}`], ["pay-record", `/payments/record?clientId=${ids.client}`], ["recurring", "/recurring"], ["bank", "/bank"], ["accounts", "/accounts"], ["reconcile", "/reconcile"], ["tally", "/tally"], ["settings", "/settings"]]) {
    await go(p); await ready(); await page.waitForTimeout(300); await shot(`desk-${n}`);
  }
});

// ── 10. Phone pass ────────────────────────────────────────────────────────────────
await journey("phone-pass", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pages = ["/dashboard", "/invoices", `/invoices/view?id=${ids.invoice}`, `/invoices/view?id=${ids.kaInv}`, `/invoices/edit?clientId=${ids.client}`, "/recurring", `/recurring/edit?clientId=${ids.client}`, "/payments", `/payments/view?id=${ids.receipt}`, `/payments/record?clientId=${ids.client}`, `/payments/record?clientId=${ids.ka}`, "/settings"];
  pages.push(/* accounts (PR 1) */ "/accounts", "/accounts/filed?fy=2025-26&company=dspl");
  pages.push(/* reconcile (PR 5) */ "/reconcile", "/reconcile?tab=gst", "/reconcile?tab=balances", `/reconcile/ledger?clientId=${ids.client}`);
  pages.push(/* reconcile BRS (PR 6) */ "/reconcile?tab=bank", "/reconcile/brs");
  pages.push(/* tally (PR 2) */ "/tally", "/tally/view", "/tally/settings", "/tally/parties");
  pages.push(/* import (PR 3) */ "/invoices/import", ...(ids.swipeImport ? [`/invoices/import/view?id=${ids.swipeImport}`] : []));
  pages.push(/* bank (PR 4) */ "/bank", "/bank/upload", ...(ids.bankLine ? [`/bank/line?id=${ids.bankLine}`] : []), ...(ids.bankStatement ? [`/bank/statement?id=${ids.bankStatement}`] : []));
  for (const p of pages) { await go(p); await ready(); await page.waitForTimeout(300); await overflowCheck(p); await shot(`phone-${p.replace(/[^a-z]+/g, "-")}`); }
  check("no page scrolls sideways at 390 px", out.overflow.length === 0, JSON.stringify(out.overflow));
  await shot("phone-dashboard");
  await page.setViewportSize({ width: 1280, height: 860 });
});

// ── 11. Sales-role (non-admin) user ───────────────────────────────────────────────
await journey("sales-role-user", async () => {
  await signOut();
  check("sign out lands on /login", page.url().includes("/login"), page.url());
  await signIn(SALES);
  await go("/settings");
  check("non-admin sees the read-only notice", /Only an Admin or Super Admin/.test(await text()), (await text()).slice(0, 300));
  check("non-admin cannot edit settings", await page.getByRole("button", { name: "Save profile" }).isDisabled().catch(() => false), "save enabled");
  await go("/invoices"); check("sales user can open invoices", (await page.locator("h1").innerText()).includes("Invoices"), "");
  await signOut();
});

await browser.close();
out.summary = { checks: out.checks.length, failed: out.checks.filter((c) => !c.ok).length, journeysFailed: Object.entries(out.journeys).filter(([, j]) => !j.ok).map(([k]) => k), consoleErrors: out.consoleErrors.length, badResponses: out.badResponses.length };
console.log(JSON.stringify(out, null, 1));
