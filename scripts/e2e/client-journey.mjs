#!/usr/bin/env node
/**
 * Drives the self-serve client journey in a real browser and reports what happened:
 *
 *   website CTA → /signup?next=/campaigns/new → details → creative upload (the render worker
 *   prepares the preview) → accounts → submit for review (offline payment mode) → staff approve
 *   and mark each post live through the admin API → the client sees every post link
 *   → a 390 px pass over the same screens (no horizontal overflow, nothing hidden under the bar).
 *
 * LOCAL ONLY. It needs:
 *   - the API on :4000 in offline payment mode (CAMPAIGN_PAYMENT_MODE=offline) with an overlay
 *     font the render worker can use (fonts-dejavu-core or CAMPAIGN_FONT_FILE);
 *   - the client portal on :3001;
 *   - scripts/dev-seed-campaigns.ts loaded (rate cards) and the seeded admin account;
 *   - Playwright + Chromium (PLAYWRIGHT_MODULE / CHROMIUM_PATH override the defaults below).
 *
 *   node scripts/e2e/client-journey.mjs            # prints a JSON summary, screenshots in OUT
 *
 * It creates a fresh client (e2e+<ts>@acme.test) every run and never touches an existing one.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CLIENT_URL ?? "http://localhost:3001";
const API = process.env.API_URL ?? "http://localhost:4000/v1";
const OUT = process.env.OUT_DIR ?? path.resolve("e2e-shots");
const MEDIA_VIDEO = process.env.E2E_VIDEO ?? path.resolve("scripts/e2e/fixtures/reel.mp4");
const MEDIA_IMAGE = process.env.E2E_IMAGE ?? path.resolve("scripts/e2e/fixtures/post.jpg");
const ADMIN = { email: process.env.ADMIN_EMAIL ?? "admin@digitalsukoon.com", password: process.env.ADMIN_PASSWORD ?? "Admin@123456" };
const RENDER_WAIT_MS = Number(process.env.RENDER_WAIT_MS ?? 180_000);
const pwPath = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.js";
const pw = await import(pwPath).catch(() => import("playwright"));
const { chromium } = pw.default ?? pw; // CJS build: the exports sit on default
const EXEC = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const out = { ok: false, steps: [], timings: {}, consoleErrors: [], pageErrors: [], httpErrors: [], mobile: {} };
const step = (name, data = {}) => { out.steps.push({ name, at: stamp(), ...data }); console.error(`[${stamp()}] ${name}${Object.keys(data).length ? " " + JSON.stringify(data) : ""}`); };
const email = `e2e+${Date.now()}@acme.test`;
const password = "E2e-Pass-2026!";

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
function wire(page, bucket) {
  page.on("response", (r) => { if (r.status() >= 400) out.httpErrors.push({ where: bucket, status: r.status(), url: r.url().slice(0, 160) }); });
  page.on("pageerror", (e) => out.pageErrors.push({ where: bucket, message: e.message }));
  page.on("console", (m) => { if (m.type() === "error") out.consoleErrors.push({ where: bucket, text: m.text().slice(0, 300) }); });
}
/** Click a submit button only once React has hydrated and enabled it (a native submit would GET-reload the page and drop the typed fields). */
async function clickSubmit(page, selector, timeout = 30_000) {
  const btn = page.locator(selector).first();
  await btn.waitFor({ state: "visible", timeout });
  await page.waitForFunction((sel) => { const b = document.querySelector(sel); return b && !b.disabled; }, selector.split(",")[0].trim(), { timeout });
  await btn.click();
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {}); }
async function api(pathname, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${pathname}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${pathname} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 200)}`);
  return json.data;
}
const overflow = (page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) }));

let campaignId = null;
let page;
let current = null; // the page being driven right now (for the failure screenshot)
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  page = await ctx.newPage();
  current = page;
  wire(page, "desktop");

  // 1. Website CTA lands on signup with the booking intent.
  await page.goto(`${BASE}/signup?next=%2Fcampaigns%2Fnew`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#cemail", { timeout: 30_000 });
  step("signup page", { heading: (await page.textContent("h2"))?.trim(), fields: await page.$$eval("form.auth-form input", (els) => els.map((e) => e.id || e.name)) });
  await shot(page, "01-signup");
  await page.fill("#ccompany", "Acme Studios");
  await page.fill("#cemail", email);
  await page.fill("#cname", "Asha Rao");
  await page.fill("#cpw", password);
  if (await page.$("#cpw2")) await page.fill("#cpw2", password);
  const tSignup = Date.now();
  await clickSubmit(page, "button.auth-btn[type=submit]");
  await page.waitForURL(/\/campaigns\/new/, { timeout: 30_000 });
  out.timings.signupToWizardMs = Date.now() - tSignup;
  step("signed up → /campaigns/new", { email });

  // 2. Details.
  await page.waitForSelector("#c-name", { timeout: 30_000 });
  step("details step", { brandPrefilled: await page.inputValue("#c-brand"), fromDefault: await page.inputValue("#c-from"), toDefault: await page.inputValue("#c-to") });
  await shot(page, "02-details");
  await page.fill("#c-name", "E2E Diwali launch");
  if (!(await page.inputValue("#c-brand"))) await page.fill("#c-brand", "Acme Studios");
  await clickSubmit(page, "form button[type=submit]");
  await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: 30_000 });
  campaignId = page.url().match(/\/campaigns\/([0-9a-f-]{36})/)[1];
  step("draft created", { campaignId });

  // 3. Creative: upload the reel, add super text + caption, save.
  await page.waitForSelector("input[type=file]", { state: "attached", timeout: 30_000 });
  await shot(page, "03-creative-empty");
  const tUp = Date.now();
  await page.setInputFiles("input[type=file] >> nth=0", MEDIA_VIDEO);
  await page.waitForFunction(() => !document.body.innerText.includes("Uploading") && !document.body.innerText.includes("Checking file") && document.querySelector("video"), null, { timeout: 90_000 });
  out.timings.uploadMs = Date.now() - tUp;
  step("creative uploaded", { uploadMs: out.timings.uploadMs });
  await page.fill("#c-super", "FLAT 50% OFF");
  await page.fill("#c-caption", "E2E launch — only this week #diwali #sale");
  await shot(page, "04-creative-filled");
  await page.click("button:has-text('Save & choose accounts')");
  await page.waitForSelector("ul li input[type=checkbox]", { timeout: 30_000 });
  step("accounts step", { accounts: await page.$$eval("ul li input[type=checkbox]", (els) => els.length) });
  await shot(page, "05-accounts");

  // 4. Accounts: pick two.
  const boxes = await page.$$("ul li input[type=checkbox]");
  await boxes[0].check();
  await boxes[1].check();
  await page.click("button:has-text('Continue')");
  await page.waitForFunction(() => /Submit for review|Pay ₹|Preparing preview/.test(document.body.innerText), null, { timeout: 30_000 });
  step("review step reached", { buttonText: (await page.textContent("button[aria-live=polite]"))?.trim() });
  await shot(page, "06-review-waiting");

  // 5. Wait for the render worker (one file per 30 s tick) to unblock the submit button.
  const tRender = Date.now();
  const submit = page.locator("button[aria-live=polite]:has-text('Submit for review'), button[aria-live=polite]:has-text('Pay ₹')");
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button[aria-live=polite]")].find((x) => /Submit for review|Pay ₹/.test(x.textContent || "")); return b && !b.disabled; }, null, { timeout: RENDER_WAIT_MS });
  out.timings.renderWaitMs = Date.now() - tRender;
  step("preview ready", { renderWaitMs: out.timings.renderWaitMs, buttonText: (await submit.textContent())?.trim() });
  await shot(page, "07-review-ready");
  await submit.click();
  await page.waitForFunction(() => /Submitted\.|Payment received|In review/.test(document.body.innerText), null, { timeout: 30_000 });
  step("submitted", { statusCopy: (await page.textContent("main, body"))?.match(/Submitted\.[^.]*\.|Payment received[^.]*\./)?.[0] });
  await shot(page, "08-submitted");

  // 6. Staff: approve and mark each post live through the admin API.
  const admin = await api("/auth/login", { method: "POST", body: ADMIN });
  const tok = admin.accessToken;
  await api(`/admin/campaigns/${campaignId}/approve`, { method: "POST", token: tok });
  const b = await api(`/admin/campaigns/${campaignId}`, { token: tok });
  const links = [];
  for (const [i, it] of b.items.entries()) {
    const url = it.platform === "facebook" ? `https://www.facebook.com/reel/10000000000${i}` : `https://www.instagram.com/reel/E2E${i}XYZ/`;
    await api(`/admin/campaigns/${campaignId}/items/${it.id}/posted`, { method: "POST", token: tok, body: { url } });
    links.push(url);
  }
  step("staff approved + posted", { items: b.items.length });

  // 7. The client sees the links.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("a:has-text('View post')", { timeout: 30_000 });
  const seen = await page.$$eval("a:has-text('View post')", (as) => as.map((a) => a.href));
  step("client sees links", { seen });
  await shot(page, "09-live");
  out.linksMatch = links.every((l) => seen.includes(l));

  // 8. Mobile pass at 390 px over the same screens with a fresh draft.
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  current = m;
  wire(m, "mobile");
  await m.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await m.fill("#cemail", email);
  await m.fill("#cpw", password);
  await clickSubmit(m, "button.auth-btn[type=submit]");
  await m.waitForURL(/\/dashboard|\/campaigns/, { timeout: 30_000 });
  out.mobile.landing = { url: m.url(), ...(await overflow(m)) };
  await m.goto(`${BASE}/campaigns`, { waitUntil: "domcontentloaded" });
  await m.waitForSelector("text=E2E Diwali launch", { timeout: 30_000 });
  out.mobile.list = await overflow(m);
  await shot(m, "m1-campaigns");
  await m.goto(`${BASE}/campaigns/new`, { waitUntil: "domcontentloaded" });
  await m.waitForSelector("#c-name", { timeout: 30_000 });
  out.mobile.details = await overflow(m);
  await shot(m, "m2-details");
  await m.fill("#c-name", "E2E mobile post");
  if (!(await m.inputValue("#c-brand"))) await m.fill("#c-brand", "Acme Studios");
  await clickSubmit(m, "form button[type=submit]");
  await m.waitForURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await m.waitForSelector("input[type=file]", { state: "attached", timeout: 30_000 });
  await m.click("button[aria-pressed]:has-text('Post')");
  await m.setInputFiles("input[type=file] >> nth=0", MEDIA_IMAGE);
  await m.waitForFunction(() => !document.body.innerText.includes("Uploading") && !document.body.innerText.includes("Checking file") && document.querySelector("img[alt]"), null, { timeout: 90_000 });
  out.mobile.creative = await overflow(m);
  await shot(m, "m3-creative");
  await m.click("button:has-text('Save & choose accounts')");
  await m.waitForSelector("ul li input[type=checkbox]", { timeout: 30_000 });
  const mb = await m.$$("ul li input[type=checkbox]");
  await mb[0].check();
  await m.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await m.waitForTimeout(300);
  out.mobile.accounts = {
    ...(await overflow(m)),
    // Does the fixed bottom bar cover the last account row once scrolled to the bottom?
    lastRowCoveredPx: await m.evaluate(() => {
      const rows = document.querySelectorAll("ul > li");
      const last = rows[rows.length - 1]?.getBoundingClientRect();
      const bar = [...document.querySelectorAll("div")].find((d) => getComputedStyle(d).position === "fixed" && d.textContent?.includes("Continue"))?.getBoundingClientRect();
      return last && bar ? Math.max(0, Math.round(last.bottom - bar.top)) : null;
    }),
    continueVisible: await m.isVisible("button:has-text('Continue')"),
  };
  await shot(m, "m4-accounts");
  await mctx.close();

  out.ok = out.pageErrors.length === 0 && out.linksMatch;
} catch (err) {
  out.error = String(err?.message ?? err);
  step("FAILED", { error: out.error });
  if (current) await shot(current, "zz-failure");
} finally {
  out.campaignId = campaignId;
  out.email = email;
  out.totalMs = Date.now() - t0;
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
