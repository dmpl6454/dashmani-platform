#!/usr/bin/env node
/**
 * Drives every sales-portal journey in a real browser and reports what happened (LOCAL ONLY).
 * Since 2026-11-07 the invoicing and finance pages live on the billing portal (apps/billing) and
 * their steps in billing-journey.mjs; this script covers the selling half and the handoff across:
 *
 *   sign-in (deep link, wrong password) → company switch → inventory (views, search, CSV) →
 *   add a client + billing profile → quote from the inventory → send / accept / convert →
 *   order lines delivered → Create invoice lands on the BILLING portal signed in → campaign
 *   booking → invoice for Dashmani Media (lands on billing) → dashboard (tiles link to billing) →
 *   portal switcher → quote decline/delete → cancel an order → the client statement →
 *   a Sales-role (non-admin) user → a 390 px pass over every page → sign out.
 *
 * Needs: the API on :4000, the built portal served on :3006 (`npx serve apps/sales/out -l 3006`),
 * the built billing portal on :3007 (`npx serve apps/billing/out -l 3007`) for the handoff steps,
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
const BILLING_BASE = process.env.BILLING_URL ?? "http://localhost:3007";
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
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/);
}
const setCompany = async (label) => { await page.getByRole("radio", { name: new RegExp(label) }).click(); await settle(); };

const ids = {};

// ── 1. Sign-in ────────────────────────────────────────────────────────────────────
await journey("sign-in", async () => {
  await ctx.clearCookies();
  await go("/clients");
  await page.waitForURL(/\/login\?next=/);
  check("signed-out deep link goes to /login?next=", page.url().includes("next=%2Fclients"), page.url());
  await page.getByLabel("Work email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password-123");
  expected.add("POST /v1/auth/login 401");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(1200);
  check("wrong password shows an error and stays", page.url().includes("/login") && /invalid|incorrect|wrong|don.t match|do not match/i.test(await page.locator("body").innerText()), await page.locator("body").innerText().then((t) => t.slice(0, 200)));
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/clients/, { timeout: 15_000 });
  check("sign-in returns to the deep link", page.url().includes("/clients"), page.url());
});

// ── 2. Company switch (the seller settings are on the billing portal) ────────────
await journey("company-switch", async () => {
  await go("/dashboard"); await ready();
  for (const label of ["Digital Sukoon", "Dashmani Media"]) {
    await setCompany(label);
    check(`header brand follows ${label}`, (await page.locator("header").innerText()).includes(label), "");
  }
  await page.reload({ waitUntil: "domcontentloaded" }); await settle();
  check("company choice survives a reload", (await page.locator("header").innerText()).includes("Dashmani Media"), "");
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
  // Since #244 "Add client" is a link to the full New client page, which takes the billing
  // profile on the same form and opens the new client when saved.
  await page.getByRole("link", { name: "Add client" }).first().click();
  await page.waitForURL(/\/clients\/new/); await settle();
  await page.getByLabel("Company", { exact: true }).fill(`E2E Brand ${stamp}`);
  await page.getByLabel("Contact person").fill("Asha Rao");
  // The Email field's label also holds its hint ("Also the address they would sign in with…").
  await page.getByLabel(/^Email/).first().fill(`e2e-${stamp}@brand.test`);
  await page.getByLabel("Legal name").fill(`E2E Brand ${stamp} Private Limited`);
  await page.getByLabel("GSTIN").fill("27AABCU9603R1ZX");
  await page.getByLabel("Address line 1").fill("12 Film City Road");
  await page.getByLabel("City").fill("Mumbai");
  await page.getByLabel("PIN").fill("400065");
  await page.getByRole("button", { name: "Create client" }).click();
  await page.waitForURL(/\/clients\/view\?id=/); await settle();
  ids.client = new URL(page.url()).searchParams.get("id");
  check("client created and opened", !!ids.client, page.url());
  await page.waitForTimeout(500);
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

// ── 6. Order delivery → invoice (the draft opens on the billing portal) ──────────
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
  // The draft is made here, then a handoff opens it on the billing portal, already signed in.
  const landed = await page.waitForURL((u) => u.href.startsWith(BILLING_BASE) && u.pathname.startsWith("/invoices/view"), { timeout: 20_000 }).then(() => true).catch(() => false);
  await settle();
  ids.invoice = landed ? new URL(page.url()).searchParams.get("id") : null;
  check("Create invoice lands on the billing portal, signed in, on the new draft", landed && !page.url().includes("/login"), page.url());
  if (landed) { await page.locator("h1").filter({ hasText: /Draft invoice/ }).waitFor({ timeout: 10_000 }).catch(() => {}); check("billing shows the draft", /Draft invoice/.test(await page.locator("h1").innerText().catch(() => "")), ""); }
  await go("/orders"); await ready();
  const link = page.locator("main a[href*='/invoices/view?id=']").first();
  if (await link.count()) check("the order's invoice number links to the billing portal", (await link.getAttribute("href") ?? "").startsWith(BILLING_BASE), await link.getAttribute("href"));
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
  const landed = await page.waitForURL((u) => u.href.startsWith(BILLING_BASE) && u.pathname.startsWith("/invoices/view"), { timeout: 20_000 }).then(() => true).catch(() => false);
  await settle();
  check("the booking's invoice opens on the billing portal", landed, page.url());
  if (landed) { await page.locator("h1").filter({ hasText: /Draft invoice/ }).waitFor(); check("booking invoice belongs to Dashmani Media", /dashmani media/i.test(await text()), (await text()).slice(0, 200)); }
  await go("/dashboard"); await ready();
  await setCompany("Digital Sukoon");
});

// ── 11. Dashboard ─────────────────────────────────────────────────────────────────
await journey("dashboard", async () => {
  await go("/dashboard");
  await page.getByText("Sales at a glance").waitFor();
  const t = await text();
  check("dashboard shows invoiced amount", /Invoiced this FY\s*₹[1-9]/i.test(t), t.slice(0, 300));
  check("dashboard shows the bookings block", t.includes("Campaign bookings"), "");
  const invoiced = page.locator("main a[href*='/invoices?status=all']").first();
  check("the invoiced tile links to the billing portal", (await invoiced.getAttribute("href").catch(() => "") ?? "").startsWith(BILLING_BASE), await invoiced.getAttribute("href").catch(() => ""));
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
  check("switcher lists the billing portal", await page.getByRole("menuitem", { name: /Billing portal/ }).first().isVisible().catch(() => false), "");
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

await journey("cancel-order", async () => {
  const c = await newClient(`E2E Cancel ${stamp}`, "27", "27AABCU9603R1ZX");
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

await journey("client-statement", async () => {
  await go(`/clients/view?id=${ids.client}`); await ready();
  const t = await text();
  check("statement lists the client's invoice", /DS\/|Draft/.test(t), t.slice(0, 300));
  const pay = page.locator("main a[href*='/payments/record?clientId=']").first();
  check("Record payment links to the billing portal", (await pay.getAttribute("href").catch(() => "") ?? "").startsWith(BILLING_BASE), await pay.getAttribute("href").catch(() => ""));
});

await journey("desktop-screens", async () => {
  for (const [n, p] of [["dashboard", "/dashboard"], ["inventory", "/inventory"], ["clients", "/clients"], ["client", `/clients/view?id=${ids.client}`], ["quotes", "/quotes"], ["quote", `/quotes/view?id=${ids.quote}`], ["order", `/orders/view?id=${ids.order}`], ["bookings", "/bookings"], ["quote-edit", `/quotes/edit?clientId=${ids.client}`], ["creators", "/creators"]]) {
    await go(p); await ready(); await page.waitForTimeout(300); await shot(`desk-${n}`);
  }
});

// ── 13. Phone pass ────────────────────────────────────────────────────────────────
await journey("phone-pass", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pages = ["/dashboard", "/inventory", "/clients", `/clients/view?id=${ids.client}`, `/clients/edit?id=${ids.client}`, "/clients/new", "/quotes", `/quotes/view?id=${ids.quote}`, "/orders", `/orders/view?id=${ids.order}`, "/bookings", "/creators", `/quotes/edit?clientId=${ids.client}`, `/orders/edit?clientId=${ids.client}`];
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
  await go("/clients"); check("sales user can open clients", (await page.locator("h1").innerText()).includes("Clients"), "");
  check("sales user sees the Billing portal entry", (await page.locator("header").innerText()).includes("Billing portal"), "");
  await signOut();
});

await browser.close();
out.summary = { checks: out.checks.length, failed: out.checks.filter((c) => !c.ok).length, journeysFailed: Object.entries(out.journeys).filter(([, j]) => !j.ok).map(([k]) => k), consoleErrors: out.consoleErrors.length, badResponses: out.badResponses.length };
console.log(JSON.stringify(out, null, 1));
