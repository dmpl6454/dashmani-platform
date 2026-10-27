#!/usr/bin/env node
/**
 * Drives every sales-portal journey in a real browser and reports what happened (LOCAL ONLY):
 *
 *   sign-in (deep link, wrong password) → company switch → settings for both companies →
 *   inventory (views, search, CSV) → add a client + billing profile → quote from the inventory →
 *   send / accept / convert → order lines delivered → invoice → issue → PDF → partial payment →
 *   credit note → advance receipt → refund → void → proforma → convert → issue → campaign
 *   booking → invoice for Dashmani Media → dashboard → a Sales-role (non-admin) user →
 *   a 390 px pass over every page → sign out.
 *
 * Needs: the API on :4000, the built portal served on :3006 (`npx serve apps/sales/out -l 3006`),
 * the seeded admin, scripts/dev-seed-campaigns.ts loaded, a Sales-role user (E2E_SALES_EMAIL /
 * E2E_SALES_PASSWORD), at least one campaign booking that can be invoiced (optional), and
 * playwright-core + Chromium (PLAYWRIGHT_MODULE / CHROMIUM_PATH).
 *
 *   node scripts/e2e/sales-journey.mjs     # JSON summary; screenshots in OUT_DIR
 *
 * Every expectation is a soft check; a step that cannot continue stops only that journey.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SALES_URL ?? "http://localhost:3006";
const API = process.env.API_URL ?? "http://localhost:4000/v1";
const OUT = process.env.OUT_DIR ?? path.resolve("e2e-shots/sales");
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
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
}
const setCompany = async (label) => { await page.getByRole("radio", { name: new RegExp(label) }).click(); await settle(); };

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

// ── 3. Inventory ──────────────────────────────────────────────────────────────────
await journey("inventory", async () => {
  await go("/inventory");
  await page.locator("table tbody tr, [data-channel]").first().waitFor({ timeout: 15_000 });
  const t = await text();
  check("inventory lists channels", (await page.locator("table tbody tr").count()) > 0, t.slice(0, 200));
  const allBtn = page.getByRole("button", { name: /all channels/i });
  if (await allBtn.count()) { await allBtn.first().click(); await settle(); check("all-channels view", (await page.locator("table tbody tr").count()) > 0, ""); }
  const csv = page.getByRole("button", { name: /csv|export/i }).first();
  if (await csv.count()) {
    const dl = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), csv.click()]).then(([d]) => d);
    check("inventory CSV downloads", !!dl, "no download event");
  } else check("inventory CSV button exists", false, "not found");
});

// ── 4. Client + billing profile ───────────────────────────────────────────────────
await journey("client", async () => {
  await go("/clients");
  await page.getByRole("button", { name: "Add client" }).click();
  await page.getByLabel("Company", { exact: true }).fill(`E2E Brand ${stamp}`);
  await page.getByLabel("Contact person").fill("Asha Rao");
  await page.getByLabel("Email", { exact: true }).fill(`e2e-${stamp}@brand.test`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await settle();
  await page.getByRole("link", { name: new RegExp(`E2E Brand ${stamp}`) }).first().click();
  await page.waitForURL(/\/clients\/view\?id=/); await settle();
  ids.client = new URL(page.url()).searchParams.get("id");
  check("client created and opened", !!ids.client, page.url());
  const add = page.getByRole("button", { name: /^(Add|Edit)$/ }).first();
  await add.click();
  await page.getByLabel("Legal name").fill(`E2E Brand ${stamp} Private Limited`);
  await page.getByLabel("GSTIN").fill("27AABCU9603R1ZX");
  await page.getByLabel("Address line 1").fill("12 Film City Road");
  await page.getByLabel("City").fill("Mumbai");
  await page.getByLabel("PIN").fill("400065");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await settle(); await page.waitForTimeout(500);
  check("billing profile saved", (await text()).includes("27AABCU9603R1ZX"), (await text()).slice(0, 300));
});

// ── 5. Quote → order ──────────────────────────────────────────────────────────────
await journey("quote-to-order", async () => {
  await go(`/quotes/edit?clientId=${ids.client}`);
  await page.getByLabel("Title").fill(`E2E reels ${stamp}`);
  await page.getByRole("button", { name: /From inventory/ }).click();
  const pick = page.getByRole("dialog").or(page.locator("div").filter({ hasText: "Add a placement from the inventory" }).last());
  await page.getByText("Add a placement from the inventory").waitFor();
  const offer = page.getByRole("dialog").locator("button").filter({ hasText: /₹/ }).first();
  check("inventory picker offers a priced placement", await offer.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false), "no priced offer");
  await offer.click();
  await page.getByRole("button", { name: /Custom line/ }).click();
  const descs = page.locator("tbody input[placeholder], tbody input").filter({ hasNot: page.locator("[inputmode]") });
  const last = page.locator("tbody tr").last();
  await last.locator("input").first().fill("Story mention");
  await last.locator("input[inputmode=decimal]").first().fill("2500");
  await page.getByRole("button", { name: "Create quote" }).click();
  await page.waitForURL(/\/quotes\/view\?id=/); await settle(); await ready();
  ids.quote = new URL(page.url()).searchParams.get("id");
  const t = await text();
  check("quote created with a Q number", /Q\/\d\d-\d\d\/\d{4}/.test(t), t.slice(0, 200));
  await page.getByRole("button", { name: "Mark sent" }).click(); await settle();
  await page.getByRole("button", { name: "Mark accepted" }).click(); await settle();
  await page.getByRole("button", { name: "Convert to order" }).click();
  await page.getByRole("button", { name: "Create order" }).click();
  await page.waitForURL(/\/orders\/view\?id=/); await settle(); await ready();
  ids.order = new URL(page.url()).searchParams.get("id");
  check("quote converts to an SO order", /SO\/\d\d-\d\d\/\d{4}/.test(await text()), (await text()).slice(0, 200));
});

// ── 6. Order delivery → invoice → issue → PDF ─────────────────────────────────────
await journey("order-to-invoice", async () => {
  await go(`/orders/view?id=${ids.order}`);
  const rows = page.locator("tbody tr").filter({ has: page.locator("select") });
  const n = await rows.count();
  check("order shows editable lines", n > 0, n);
  for (let i = 0; i < n; i++) {
    const r = page.locator("tbody tr").filter({ has: page.locator("select") }).nth(i);
    await r.locator("select").selectOption("delivered");
    await r.locator("input[placeholder='Post link']").fill(`https://www.instagram.com/reel/E2E${stamp}${i}/`);
    await r.getByRole("button", { name: "Save" }).click();
    await settle(); await page.waitForTimeout(400);
  }
  check("every line delivered moves the order to delivered", /delivered/i.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/invoices\/view\?id=/); await settle();
  ids.invoice = new URL(page.url()).searchParams.get("id");
  await page.getByRole("button", { name: "Issue" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click();
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

// ── 7. Payment, credit note ───────────────────────────────────────────────────────
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

// ── 8. Advance, refund, void ──────────────────────────────────────────────────────
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

// ── 9. Proforma → tax invoice ─────────────────────────────────────────────────────
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

// ── 10. Campaign booking → invoice for Dashmani Media ─────────────────────────────
await journey("booking-invoice", async () => {
  await go("/bookings?stage=to_invoice");
  await settle();
  const first = page.locator("tbody tr a[href^='/bookings/view']").first();
  if (!(await first.count())) { check("a booking to invoice exists (seed one to test this)", false, "none"); return; }
  await first.click(); await page.waitForURL(/\/bookings\/view/); await settle();
  await setCompany("Dashmani Media");
  await page.getByRole("button", { name: /Create invoice \(Dashmani Media\)/ }).click();
  await page.waitForURL(/\/invoices\/view\?id=/); await settle();
  await page.locator("h1").filter({ hasText: /Draft invoice/ }).waitFor();
  check("booking invoice belongs to Dashmani Media", /dashmani media/i.test(await text()), (await text()).slice(0, 200));
  await setCompany("Digital Sukoon");
});

// ── 11. Dashboard ─────────────────────────────────────────────────────────────────
await journey("dashboard", async () => {
  await go("/dashboard");
  await page.getByText("Sales at a glance").waitFor();
  const t = await text();
  check("dashboard shows invoiced amount", /Invoiced this FY\s*₹[1-9]/i.test(t), t.slice(0, 300));
  check("dashboard shows the bookings block", t.includes("Campaign bookings"), "");
  await page.locator("a[href='/bookings?stage=to_invoice']").click();
  await page.waitForURL(/\/bookings/).catch(() => {}); await settle();
  await page.locator("main button.bg-indigo").filter({ hasText: /To invoice/i }).waitFor({ timeout: 5000 }).catch(() => {});
  check("bookings tile opens its tab", page.url().includes("stage=to_invoice") && /To invoice/i.test(await page.locator("main button.bg-indigo").first().innerText().catch(() => "")), page.url());
});

// ── 12. Portal switcher ───────────────────────────────────────────────────────────
await journey("portal-switcher", async () => {
  await go("/dashboard");
  await page.getByRole("button", { name: /Portals/ }).click();
  check("switcher lists the staff portal", await page.getByText(/Staff portal|portal\.digitalsukoon|Internal/i).first().isVisible().catch(() => false), "");
  await page.keyboard.press("Escape");
});

// ── 12b. Branching journeys ──────────────────────────────────────────────────────
const toastText = async () => (await page.getByRole("status").filter({ hasNotText: /Loading/ }).allInnerTexts().catch(() => [])).join(" | ");
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

await journey("quote-decline-delete", async () => {
  await go(`/quotes/edit?clientId=${ids.client}`); await ready();
  await page.getByLabel("Title").fill(`Declined ${stamp}`);
  const row = page.locator("tbody tr").first();
  await row.locator("input").first().fill("Static post");
  await row.locator("input[inputmode=decimal]").first().fill("1000");
  await page.getByRole("button", { name: "Create quote" }).click();
  await page.waitForURL(/\/quotes\/view/); await settle(); await ready();
  await page.getByRole("button", { name: "Declined" }).click();
  await page.getByRole("button", { name: "Mark declined" }).click(); await settle();
  check("quote declined", /declined/i.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
  await page.getByRole("button", { name: "Reopen" }).click(); await settle();
  await page.locator("h1").filter({ hasText: /draft/i }).waitFor({ timeout: 5000 }).catch(() => {});
  check("declined quote reopens to draft", /draft/i.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
  await page.getByRole("button", { name: "Delete" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page.waitForURL(/\/quotes(\?|$)/, { timeout: 8000 }).catch(() => {});
  check("draft quote deletes and returns to the list", /\/quotes$|\/quotes\?/.test(page.url()) || page.url().endsWith("/quotes/"), page.url());
});

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

await journey("cancel-invoice-and-order", async () => {
  const c = await newClient(`E2E Cancel ${stamp}`, "27", "27AABCU9603R1ZX");
  const inv = await draftInvoice(c, 3000);
  await issueOpen(); await page.getByRole("dialog").getByRole("button", { name: "Issue" }).click(); await settle(); await ready(); await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await page.getByLabel("Reason").fill("Raised in error");
  await page.getByRole("button", { name: "Cancel invoice" }).click(); await settle(); await page.waitForTimeout(500);
  check("issued, unpaid invoice cancels and keeps its number", /cancelled/i.test(await page.locator("h1").innerText()) && /DS\//.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
  await go(`/orders/edit?clientId=${c}`); await ready();
  await page.getByLabel("Title").fill(`Cancel me ${stamp}`);
  const row = page.locator("tbody tr").first();
  await row.locator("input").first().fill("Reel");
  await row.locator("input[inputmode=decimal]").first().fill("1000");
  await page.getByRole("button", { name: "Create order" }).click();
  await page.waitForURL(/\/orders\/view/); await settle(); await ready();
  await page.getByRole("button", { name: "Cancel order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel order" }).click(); await settle(); await page.waitForTimeout(400);
  check("order cancels", /cancelled/i.test(await page.locator("h1").innerText()), await page.locator("h1").innerText());
});

await journey("client-statement-and-search", async () => {
  await go(`/clients/view?id=${ids.client}`); await ready();
  const t = await text();
  check("statement lists the client's invoices and payments", /DS\//.test(t) && /RCPT\//.test(t), t.slice(0, 300));
  await go("/invoices"); await ready();
  await page.getByPlaceholder(/Search/).fill(`E2E Brand ${stamp}`); await page.waitForTimeout(700); await settle();
  const rows = await page.locator("tbody tr").count();
  check("invoice search narrows to the client", rows > 0 && rows < 10, rows);
});

await journey("desktop-screens", async () => {
  for (const [n, p] of [["dashboard", "/dashboard"], ["inventory", "/inventory"], ["clients", "/clients"], ["client", `/clients/view?id=${ids.client}`], ["quotes", "/quotes"], ["quote", `/quotes/view?id=${ids.quote}`], ["order", `/orders/view?id=${ids.order}`], ["invoices", "/invoices"], ["invoice", `/invoices/view?id=${ids.invoice}`], ["invoice-ka", `/invoices/view?id=${ids.kaInv}`], ["payments", "/payments"], ["receipt", `/payments/view?id=${ids.receipt}`], ["bookings", "/bookings"], ["quote-edit", `/quotes/edit?clientId=${ids.client}`], ["pay-record", `/payments/record?clientId=${ids.client}`]]) {
    await go(p); await ready(); await page.waitForTimeout(300); await shot(`desk-${n}`);
  }
});

// ── 13. Phone pass ────────────────────────────────────────────────────────────────
await journey("phone-pass", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pages = ["/dashboard", "/inventory", "/clients", `/clients/view?id=${ids.client}`, "/quotes", `/quotes/view?id=${ids.quote}`, "/orders", `/orders/view?id=${ids.order}`, "/invoices", `/invoices/view?id=${ids.invoice}`, "/payments", `/payments/view?id=${ids.receipt}`, "/bookings", "/settings", `/quotes/edit?clientId=${ids.client}`, `/orders/edit?clientId=${ids.client}`, `/invoices/edit?clientId=${ids.client}`, `/payments/record?clientId=${ids.client}`, `/payments/record?clientId=${ids.ka}`, `/invoices/view?id=${ids.kaInv}`];
  for (const p of pages) { await go(p); await ready(); await page.waitForTimeout(300); await overflowCheck(p); await shot(`phone-${p.replace(/[^a-z]+/g, "-")}`); }
  check("no page scrolls sideways at 390 px", out.overflow.length === 0, JSON.stringify(out.overflow));
  await shot("phone-dashboard");
  await page.setViewportSize({ width: 1280, height: 860 });
});

// ── 14. Sales-role (non-admin) user ───────────────────────────────────────────────
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
