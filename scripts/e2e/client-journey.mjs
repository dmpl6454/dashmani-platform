#!/usr/bin/env node
/**
 * Drives the self-serve client journey in a real browser and reports what happened:
 *
 *   website CTA → /signup?next=/campaigns/new → details (prefilled) → content upload (the render
 *   worker prepares the preview) → accounts → review & submit (offline payment mode) → staff ask
 *   for a change → the client edits the caption only and re-sends → staff approve, drop one post
 *   and mark the others live → the client sees every post link → home page → a 390 px pass over
 *   the same screens → cancel → probes for the carousel upload queue and a passed posting date.
 *
 * LOCAL ONLY. It needs:
 *   - the API on :4000 in offline payment mode (CAMPAIGN_PAYMENT_MODE=offline) with an overlay
 *     font the render worker can use (fonts-dejavu-core or CAMPAIGN_FONT_FILE);
 *   - the client portal on :3001;
 *   - scripts/dev-seed-campaigns.ts loaded (rate cards) and the seeded admin account;
 *   - Playwright + Chromium (PLAYWRIGHT_MODULE / CHROMIUM_PATH override the defaults below);
 *   - psql on PATH for the passed-date probe (E2E_DB_URL, localhost only; skipped otherwise).
 *
 *   node scripts/e2e/client-journey.mjs            # prints a JSON summary, screenshots in OUT
 *
 * Every expectation is a soft check (out.checks): one wrong string is reported, not fatal. A
 * step that cannot continue (a page that never loads) stops the run. It creates a fresh client
 * (e2e+<ts>@acme.test) every run and never touches an existing one.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE = process.env.CLIENT_URL ?? "http://localhost:3001";
const API = process.env.API_URL ?? "http://localhost:4000/v1";
const OUT = process.env.OUT_DIR ?? path.resolve("e2e-shots");
const FIX = path.resolve("scripts/e2e/fixtures");
const MEDIA_VIDEO = process.env.E2E_VIDEO ?? path.join(FIX, "reel.mp4");
const MEDIA_IMAGE = process.env.E2E_IMAGE ?? path.join(FIX, "post.jpg");
const SLIDES = ["red", "green", "blue", "orange"].map((c) => path.join(FIX, `slide-${c}.jpg`));
const ADMIN = { email: process.env.ADMIN_EMAIL ?? "admin@digitalsukoon.com", password: process.env.ADMIN_PASSWORD ?? "Admin@123456" };
const RENDER_WAIT_MS = Number(process.env.RENDER_WAIT_MS ?? 240_000);
const DB_URL = process.env.E2E_DB_URL ?? "postgresql://user:password@localhost:5433/dashmani_e2e";
const pwPath = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.js";
const pw = await import(pwPath).catch(() => import("playwright"));
const { chromium } = pw.default ?? pw; // CJS build: the exports sit on default
const EXEC = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const out = { ok: false, checks: [], steps: [], timings: {}, consoleErrors: [], pageErrors: [], httpErrors: [], mobile: {}, probes: {} };
const step = (name, data = {}) => { out.steps.push({ name, at: stamp(), ...data }); console.error(`[${stamp()}] ${name}${Object.keys(data).length ? " " + JSON.stringify(data) : ""}`); };
/** A soft expectation: recorded, never thrown. */
const check = (name, pass, detail) => { out.checks.push({ name, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) }); if (!pass) console.error(`  ✗ ${name}${detail === undefined ? "" : " — " + JSON.stringify(detail)}`); };
const email = `e2e+${Date.now()}@acme.test`;
const password = "E2e-Pass-2026!";

// IST calendar helpers (the client defaults the posting window to tomorrow → +7 days, IST).
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = () => { const [y, m] = istToday().split("-"); return `${MONTHS[Number(m) - 1]} ${y}`; };
const rupeesToNum = (s) => Number(String(s).replace(/[^\d.]/g, ""));

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
function wire(page, bucket) {
  page.on("response", (r) => { if (r.status() >= 400) out.httpErrors.push({ where: bucket, status: r.status(), url: r.url().slice(0, 160) }); });
  page.on("pageerror", (e) => out.pageErrors.push({ where: bucket, message: e.message }));
  page.on("console", (m) => { if (m.type() === "error") out.consoleErrors.push({ where: bucket, text: m.text().slice(0, 300) }); });
  // Accept window.confirm (Cancel campaign) and the leave-page warning; remember what fired.
  page.on("dialog", (d) => { (out.dialogs ??= []).push({ where: bucket, type: d.type(), message: d.message().slice(0, 120) }); d.accept().catch(() => {}); });
}
/** Wait until React has hydrated and enabled a submit button (a native submit would GET-reload the page and drop the typed fields). */
async function waitEnabled(page, selector, timeout = 30_000) {
  await page.waitForFunction((sel) => { const b = document.querySelector(sel); return b && !b.disabled; }, selector, { timeout });
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {}); }
async function api(pathname, { method = "GET", token, body, raw = false } = {}) {
  const res = await fetch(`${API}${pathname}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (raw) return { status: res.status, json };
  if (!res.ok || json.success === false) throw new Error(`${method} ${pathname} → ${res.status} ${JSON.stringify(json.error ?? json).slice(0, 200)}`);
  return json.data;
}
// overflowPx: the page scrolls sideways. clippedPx: some box ends past the viewport even though an
// ancestor hides the scroll (a card wider than the phone, a price pushed off-screen) — the
// document-level number alone missed exactly that. Deliberate horizontal scrollers are skipped.
const overflow = (page) => page.evaluate(() => {
  const vw = window.innerWidth;
  const scrolls = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox === "auto" || ox === "scroll") return true; } return false; };
  let clipped = 0, worst = null;
  for (const el of document.querySelectorAll("main *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).position === "fixed") continue;
    const over = Math.round(r.right - vw);
    if (over > clipped && !scrolls(el)) { clipped = over; worst = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`; }
  }
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: vw, overflowPx: Math.max(0, document.documentElement.scrollWidth - vw), clippedPx: clipped, worst };
});
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const stepNav = (page) => page.evaluate(() => {
  const nav = document.querySelector("nav[aria-label=Steps]");
  if (!nav) return null;
  const pills = [...nav.querySelectorAll("button")].map((b) => ({ name: (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g, " ").trim(), current: b.getAttribute("aria-current") === "step", disabled: b.getAttribute("aria-disabled") === "true" || b.disabled, visible: b.getBoundingClientRect().width > 0 }));
  return { pills, fits: nav.scrollWidth <= nav.clientWidth + 1 };
});
const submitButton = (page) => page.locator("button[aria-live=polite]").filter({ hasText: /Submit for review|Pay ₹|Preparing preview/ }).first();
async function waitSubmitEnabled(page, timeout = RENDER_WAIT_MS) {
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button[aria-live=polite]")].find((x) => /Submit for review|Pay ₹/.test(x.textContent || "")); return b && !b.disabled; }, null, { timeout });
}
const psql = (sql) => {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL)) throw new Error("refusing: E2E_DB_URL is not local");
  return execFileSync("psql", [DB_URL, "-tAc", sql], { encoding: "utf8" }).trim();
};

let campaignId = null;
let current = null; // the page being driven right now (for the failure screenshot)
let clientToken = null;
let staleId = null;
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  current = page;
  wire(page, "desktop");

  // 1. Website CTA lands on signup with the booking intent.
  await page.goto(`${BASE}/signup?next=%2Fcampaigns%2Fnew`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#cemail", { timeout: 30_000 });
  await waitEnabled(page, "button.auth-btn[type=submit]");
  const signupFields = await page.$$eval("form.auth-form input", (els) => els.map((e) => e.id || e.name));
  step("signup page", { fields: signupFields });
  check("signup: no confirm-password field", !signupFields.includes("cpw2") && !(await bodyText(page)).includes("Confirm password"), signupFields);
  check("signup: copy names a video or image, not 'creative'", !/upload your creative/i.test(await bodyText(page)));
  await shot(page, "01-signup");
  await page.fill("#ccompany", "Acme Studios");
  await page.fill("#cemail", email);
  await page.fill("#cname", "Asha Rao");
  await page.fill("#cpw", password);
  const tSignup = Date.now();
  await page.click("button.auth-btn[type=submit]");
  await page.waitForURL(/\/campaigns\/new/, { timeout: 30_000 });
  out.timings.signupToWizardMs = Date.now() - tSignup;
  clientToken = await page.evaluate(() => localStorage.getItem("clientAccessToken"));
  step("signed up → /campaigns/new", { email });

  // 2. Details: brand and name come from the signup, the window defaults to tomorrow → +7.
  await page.waitForSelector("#c-name", { timeout: 30_000 });
  await waitEnabled(page, "form button[type=submit]");
  const det = { brand: await page.inputValue("#c-brand"), name: await page.inputValue("#c-name"), from: await page.inputValue("#c-from"), to: await page.inputValue("#c-to") };
  step("details step", det);
  const tomorrow = addDays(istToday(), 1);
  check("details: brand prefilled from signup", det.brand === "Acme Studios", det.brand);
  check("details: name prefilled '<company> — <Mon YYYY>'", det.name === `Acme Studios — ${monthLabel()}`, det.name);
  check("details: earliest posting date defaults to tomorrow (IST)", det.from === tomorrow, { got: det.from, want: tomorrow });
  check("details: latest posting date defaults to +7 days", det.to === addDays(tomorrow, 7), { got: det.to, want: addDays(tomorrow, 7) });
  const detText = await bodyText(page);
  check("details: date labels are plain", /Earliest posting date/i.test(detText) && /Latest posting date/i.test(detText));
  const nav1 = await stepNav(page);
  check("details: step indicator shows 4 steps, step 1 current, later steps locked", nav1 && nav1.pills.length === 4 && nav1.pills[0].current && nav1.pills.slice(1).every((p) => p.disabled), nav1);
  await shot(page, "02-details");

  // 2b. A window over 60 days is caught before any request.
  let createPosts = 0;
  const countCreate = (r) => { if (r.method() === "POST" && /\/v1\/client\/campaigns$/.test(r.url())) createPosts++; };
  page.on("request", countCreate);
  await page.fill("#c-to", addDays(det.from, 61));
  await page.click("form button[type=submit]");
  await page.waitForTimeout(500);
  check("details: a 61-day window is refused locally", (await bodyText(page)).includes("The launch window can be at most 60 days") && createPosts === 0, { createPosts });
  check("details: invalid date field is marked aria-invalid", (await page.getAttribute("#c-to", "aria-invalid")) === "true");
  check("details: the latest-date picker is capped at +60 days", (await page.getAttribute("#c-to", "max")) === addDays(det.from, 60), await page.getAttribute("#c-to", "max"));
  await page.fill("#c-to", addDays(det.from, 7));
  await page.fill("#c-name", "E2E Diwali launch");
  await page.click("form button[type=submit]");
  await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: 30_000 });
  page.off("request", countCreate);
  campaignId = page.url().match(/\/campaigns\/([0-9a-f-]{36})/)[1];
  step("draft created", { campaignId });

  // 3. Content step: keys must not leave the wizard, and the optional bits start folded.
  await page.waitForSelector("input[type=file]", { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(800);
  const nav2 = await stepNav(page);
  check("content: step 2 is current", nav2 && nav2.pills[1]?.current, nav2);
  check("content: 'Cancel campaign' is offered on every step", await page.getByRole("button", { name: "Cancel campaign" }).isVisible());
  const pathBefore = new URL(page.url()).pathname;
  const uploadBtn = page.getByRole("button", { name: /^Upload$/ }).first();
  if (await uploadBtn.count()) await uploadBtn.focus();
  for (const k of ["ArrowDown", "ArrowUp", "ArrowRight", "3", "g", "p"]) { await page.keyboard.press(k); await page.waitForTimeout(150); }
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(600);
  out.probes.keyboard = { pathBefore, pathAfter: new URL(page.url()).pathname, edgeHint: await page.evaluate(() => document.querySelector(".edge-hint")?.textContent?.replace(/\s+/g, " ").trim() ?? null) };
  check("content: arrow / digit / g-chord keys do not navigate away", out.probes.keyboard.pathAfter === pathBefore, out.probes.keyboard);
  check("content: the edge hint does not promise channel keys here", !/change channel/.test(out.probes.keyboard.edgeHint ?? ""), out.probes.keyboard.edgeHint);
  const emptyText = await bodyText(page);
  check("content: no 'Position' choice before any printed text", !/\bPosition\b/i.test(emptyText));
  check("content: 'More options' starts folded", await page.evaluate(() => { const m = document.getElementById("creative-more"); return Boolean(m && m.hidden); }));
  check("content: plain card titles", emptyText.includes("Printed text") && /\bCaption\b/.test(emptyText) && !/super text/i.test(emptyText), null);
  await shot(page, "03-content-empty");

  // 3b. Upload, then reload without saving: the leave warning fires and the upload comes back.
  const tUp = Date.now();
  await page.setInputFiles("input[type=file] >> nth=0", MEDIA_VIDEO);
  await page.waitForFunction(() => !/Uploading|Checking file|Queued/.test(document.body.innerText) && document.querySelector("video"), null, { timeout: 90_000 });
  out.timings.uploadMs = Date.now() - tUp;
  step("video uploaded", { uploadMs: out.timings.uploadMs });
  await page.fill("#c-super", "FLAT 50% OFF");
  await page.waitForTimeout(200);
  check("content: Position appears once there is printed text", /\bPosition\b/i.test(await bodyText(page)));
  check("content: an unsaved upload is labelled", (await bodyText(page)).includes("Not saved yet"));
  const dialogsBefore = (out.dialogs ?? []).length;
  await page.evaluate(() => { window.__beforeReload = true; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !window.__beforeReload && document.querySelector("input[type=file]"), null, { timeout: 30_000 });
  await page.waitForFunction(() => document.body.innerText.includes("Not saved yet"), null, { timeout: 30_000 }).catch(() => {});
  step("reloaded");
  // ⚠️ Playwright's Chromium is an open-source build without H.264, so every <video> here ends in
  // "Preview unavailable" (MediaError 4) — real Chrome/Safari play it. The restored tile is
  // therefore identified by its file name; the save below (a reel refuses anything but a video)
  // proves it came back as the video it was.
  out.probes.reloadRestore = {
    leaveWarning: (out.dialogs ?? []).slice(dialogsBefore).some((d) => d.type === "beforeunload"),
    tileBack: await page.evaluate(() => [...document.querySelectorAll("span[title]")].some((e) => e.getAttribute("title") === "reel.mp4")),
    labelled: (await bodyText(page)).includes("Not saved yet"),
  };
  check("content: reload with unsaved work raises the leave warning", out.probes.reloadRestore.leaveWarning, out.probes.reloadRestore);
  check("content: the unsaved upload is restored after a reload", out.probes.reloadRestore.tileBack && out.probes.reloadRestore.labelled, out.probes.reloadRestore);

  // 3c. A bad collaborator handle is caught on the field, with no request.
  await page.fill("#c-super", "FLAT 50% OFF");
  await page.fill("#c-caption", "E2E launch — only this week #diwali #sale");
  const moreToggle = page.locator("button[aria-controls=creative-more]");
  if (await moreToggle.count()) await moreToggle.click();
  step("more options opened");
  await page.fill("#c-collab", "@my-brand");
  let creativePuts = 0;
  const countPut = (r) => { if (r.method() === "PUT" && /\/creative$/.test(r.url())) creativePuts++; };
  page.on("request", countPut);
  await page.getByRole("button", { name: /Save & choose accounts/ }).click();
  await page.waitForTimeout(500);
  check("content: an invalid @handle is refused on its field", (await bodyText(page)).includes('"@my-brand" isn\'t an Instagram username') && (await page.getAttribute("#c-collab", "aria-invalid")) === "true" && creativePuts === 0, { creativePuts });
  await page.fill("#c-collab", "");
  await shot(page, "04-content-filled");
  await page.getByRole("button", { name: /Save & choose accounts/ }).click();
  await page.waitForSelector("ul li input[type=checkbox]", { timeout: 30_000 });
  page.off("request", countPut);
  const accText = await bodyText(page);
  step("accounts step", { accounts: await page.$$eval("ul li input[type=checkbox]", (els) => els.length), backgroundNote: accText.includes("being prepared in the background") });
  check("accounts: says the preview is being prepared meanwhile", accText.includes("being prepared in the background"));
  await shot(page, "05-accounts");

  // 4. Accounts: pick three, remembering their prices.
  const rows = page.locator("ul li:has(input[type=checkbox])");
  const picked = [];
  for (let i = 0; i < 3; i++) {
    const row = rows.nth(i);
    await row.locator("input[type=checkbox]").check();
    picked.push(rupeesToNum((await row.locator(".tabular-nums").filter({ hasText: "₹" }).first().textContent()) ?? "0"));
  }
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.waitForFunction(() => /Submit for review|Pay ₹|Preparing preview/.test(document.body.innerText), null, { timeout: 30_000 });
  const nav4 = await stepNav(page);
  const revText = await bodyText(page);
  step("review step reached", { buttonText: (await submitButton(page).textContent())?.trim(), picked });
  check("review: step 4 is called 'Review & submit' in offline mode", nav4?.pills[3]?.name.includes("Review & submit"), nav4?.pills[3]);
  check("review: says how the wait works while the preview is prepared", /Preparing your preview: \d+ file/.test(revText) && /you can leave this page/i.test(revText), revText.match(/Preparing your preview[^\n]*/)?.[0]);
  check("review: rows say 'Post between' and 'Printed text'", revText.includes("Post between") && revText.includes("Printed text"));
  check("review: per-account text is folded behind one toggle", revText.includes("Customise per account"));
  await shot(page, "06-review-waiting");

  // 5. The render worker (one file per 30 s tick) unblocks the submit button.
  const tRender = Date.now();
  await waitSubmitEnabled(page);
  out.timings.renderWaitMs = Date.now() - tRender;
  const btnText = (await submitButton(page).textContent())?.trim() ?? "";
  const expectTotal = picked.reduce((a, b) => a + b, 0);
  step("preview ready", { renderWaitMs: out.timings.renderWaitMs, buttonText: btnText });
  check("review: the total on the button is the sum of the picked prices", rupeesToNum(btnText.split("·")[1] ?? "") === expectTotal && expectTotal > 0, { btnText, expectTotal });
  check("review: preview sub says the printed text is in place", (await bodyText(page)).includes("with your printed text in place"));
  await shot(page, "07-review-ready");

  // 6. A caption-only edit from Review goes straight back to Review, with no new render.
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.waitForSelector("#c-caption", { timeout: 15_000 });
  await page.fill("#c-caption", "E2E launch — this week only #diwali #sale");
  await page.getByRole("button", { name: /Save & review/ }).click();
  await page.waitForFunction(() => /Submit for review|Pay ₹|Preparing preview/.test(document.body.innerText), null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  out.probes.captionOnlyEdit = { url: page.url(), button: (await submitButton(page).textContent())?.trim(), enabled: await submitButton(page).isEnabled() };
  check("review: a caption-only edit returns to Review without re-preparing", /step=pay/.test(page.url()) && out.probes.captionOnlyEdit.enabled, out.probes.captionOnlyEdit);

  // 7. Submit.
  await waitSubmitEnabled(page);
  await submitButton(page).click();
  await page.waitForFunction(() => /Submitted\.|Payment received/.test(document.body.innerText), null, { timeout: 30_000 });
  const subText = await bodyText(page);
  step("submitted", { statusCopy: subText.match(/Submitted\.[^\n]*/)?.[0] });
  check("after submit: names the confirmation email", subText.includes(`We're sending a confirmation to ${email}`));
  check("after submit: shows the go-live window", /Go-live window: /.test(subText));
  check("after submit: never claims a payment", !/Payment received|Paid ₹/.test(subText));
  await shot(page, "08-submitted");
  const again = await api(`/client/campaigns/${campaignId}/checkout`, { method: "POST", token: clientToken, raw: true });
  check("second checkout answers 'already been submitted' (offline wording)", again.status === 409 && again.json?.error?.message === "This campaign has already been submitted.", again);

  // 8. Staff ask for a change; the client edits the caption only and re-sends with no wait.
  const admin = await api("/auth/login", { method: "POST", body: ADMIN });
  const tok = admin.accessToken;
  await api(`/admin/campaigns/${campaignId}/request-changes`, { method: "POST", token: tok, body: { note: "Please shorten the caption." } });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=A change is needed", { timeout: 30_000 });
  check("changes requested: shows the go-live window", /Go-live window: /.test(await bodyText(page)));
  await page.getByRole("button", { name: /Update/ }).first().click();
  await page.waitForSelector("#c-caption", { timeout: 15_000 });
  await page.fill("#c-caption", "E2E launch #diwali");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(1500);
  const sendBtn = page.getByRole("button", { name: "Send for review" });
  out.probes.changesLoop = { sendEnabled: await sendBtn.isEnabled().catch(() => false) };
  check("changes requested: a caption-only fix can be sent at once (no re-render)", out.probes.changesLoop.sendEnabled, out.probes.changesLoop);
  await sendBtn.click().catch(() => {});
  await page.waitForFunction(() => /Submitted\.|In review/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
  await shot(page, "09-resubmitted");

  // 9. Staff approve, drop the third post, mark the other two live.
  await api(`/admin/campaigns/${campaignId}/approve`, { method: "POST", token: tok });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /Approved\./.test(document.body.innerText), null, { timeout: 30_000 });
  check("approved: names the posting window", /Approved\. Your posts will go live between/.test(await bodyText(page)));
  const b = await api(`/admin/campaigns/${campaignId}`, { token: tok });
  const links = [];
  for (const [i, it] of b.items.entries()) {
    if (i === 2) { await api(`/admin/campaigns/${campaignId}/items/${it.id}/refund`, { method: "POST", token: tok }); continue; }
    const url = it.platform === "facebook" ? `https://www.facebook.com/reel/10000000000${i}` : `https://www.instagram.com/reel/E2E${i}XYZ/`;
    await api(`/admin/campaigns/${campaignId}/items/${it.id}/posted`, { method: "POST", token: tok, body: { url } });
    links.push(url);
  }
  step("staff approved, dropped one, posted two", { items: b.items.length });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("a:has-text('View post')", { timeout: 30_000 });
  const seen = await page.$$eval("a:has-text('View post')", (as) => as.map((a) => a.href));
  const liveText = await bodyText(page);
  step("client sees links", { seen });
  out.linksMatch = links.every((l) => seen.includes(l));
  check("live: every posted link is shown", out.linksMatch, { links, seen });
  check("live: the dropped post says 'not charged', never 'refunded'", liveText.includes("Not posted — not charged") && !/refunded/i.test(liveText));
  await shot(page, "10-live");

  // 10. Home is campaign-first for a client with no agency projects.
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /Your campaigns|Could not load/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
  const home = await bodyText(page);
  check("home: lists the client's campaigns", home.includes("Your campaigns") && home.includes("E2E Diwali launch"));
  check("home: offers 'Start a campaign', not the agency 'New brief'", (await page.getByRole("button", { name: /Start a campaign/ }).count()) > 0 && !home.includes("New brief"));
  await shot(page, "11-home");

  // 11. Passed posting date on a draft blocks submit with a way out. The draft is built through
  //     the API (upload → content → one account) so the Review step is reachable.
  const newDraft = (name) => api("/client/campaigns", { method: "POST", token: clientToken, body: { name, brand: "Acme Studios", campaignType: "brand", launchFrom: addDays(istToday(), 1), launchTo: addDays(istToday(), 3) } });
  staleId = (await newDraft("E2E stale")).id;
  try {
    const bytes = fs.readFileSync(MEDIA_IMAGE);
    const up = await api("/client/campaign-uploads", { method: "POST", token: clientToken, body: { filename: "post.jpg", size: bytes.length, mime: "image/jpeg" } });
    const put = await fetch(`${API}/client/campaign-uploads/${up.id}/chunks/0`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${clientToken}` }, body: bytes });
    if (!put.ok) throw new Error(`chunk PUT ${put.status}`);
    await api(`/client/campaign-uploads/${up.id}/complete`, { method: "POST", token: clientToken });
    await api(`/client/campaigns/${staleId}/creative`, { method: "PUT", token: clientToken, body: { format: "post", mediaIds: [up.id], caption: "stale probe" } });
    const cat = await api("/client/campaigns/catalogue", { token: clientToken });
    const offer = cat.flatMap((a) => a.offers).find((o) => o.format === "post");
    await api(`/client/campaigns/${staleId}/items`, { method: "PUT", token: clientToken, body: { rateCardIds: [offer.rateCardId] } });
    psql(`UPDATE campaign_bookings SET launch_from = DATE '2020-01-01', launch_to = DATE '2020-01-05' WHERE id = '${staleId}'`);
    await page.goto(`${BASE}/campaigns/${staleId}?step=pay`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /posting date has passed|Submit for review|Preparing preview/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
    out.probes.staleDate = { text: (await bodyText(page)).match(/[^\n]*posting date has passed[^\n]*/)?.[0] ?? null, submitDisabled: await submitButton(page).isDisabled().catch(() => null) };
    check("stale draft: a passed posting date is called out and blocks submit", Boolean(out.probes.staleDate.text) && out.probes.staleDate.submitDisabled === true, out.probes.staleDate);
    await shot(page, "11b-stale-date");
  } catch (e) {
    out.probes.staleDate = { skipped: String(e.message ?? e) };
  }

  // 12. Carousel queue: four slides upload two at a time, and Cancel discards one.
  const carId = (await newDraft("E2E carousel")).id;
  await page.goto(`${BASE}/campaigns/${carId}?step=creative`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[type=file]", { state: "attached", timeout: 30_000 });
  await page.getByRole("button", { name: /Carousel/ }).first().click();
  // Slow each chunk down so the queue is observable.
  // A cancelled upload aborts its request, which also settles the route: continue() may then throw.
  await page.route("**/chunks/**", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue().catch(() => {}); });
  const deletes = [];
  page.on("request", (r) => { if (r.method() === "DELETE" && /campaign-uploads/.test(r.url())) deletes.push(r.url()); });
  await page.setInputFiles("input[type=file] >> nth=0", SLIDES);
  let maxUploading = 0, sawQueued = false;
  for (let i = 0; i < 8; i++) {
    const t = await bodyText(page);
    maxUploading = Math.max(maxUploading, (t.match(/Uploading \d+%/g) ?? []).length);
    sawQueued ||= /\bQueued\b/.test(t);
    await page.waitForTimeout(250);
  }
  const cancelBtn = page.getByRole("button", { name: /^Cancel upload of/ }).first();
  if (await cancelBtn.count()) await cancelBtn.click();
  await page.unroute("**/chunks/**");
  await page.waitForFunction(() => !/Uploading|Queued|Checking file/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {});
  const carText = await bodyText(page);
  out.probes.carousel = { maxUploading, sawQueued, tooMany: /uploads in progress/.test(carText), images: await page.$$eval("img[alt]", (els) => els.length), deletes: deletes.length };
  check("carousel: at most two uploads run at once, the rest queue", maxUploading <= 2 && sawQueued, out.probes.carousel);
  check("carousel: four picked slides never hit the upload limit", !out.probes.carousel.tooMany, out.probes.carousel);
  await shot(page, "12-carousel");

  // 13. Mobile pass at 390 px.
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  current = m;
  wire(m, "mobile");
  await m.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await m.waitForSelector("#cemail", { timeout: 30_000 });
  await waitEnabled(m, "button.auth-btn[type=submit]");
  out.mobile.loginFormTop = await m.evaluate(() => Math.round(document.querySelector("#cemail").getBoundingClientRect().top));
  check("mobile: the sign-in form is near the top of the page", out.mobile.loginFormTop < 600, out.mobile.loginFormTop);
  await m.fill("#cemail", email);
  await m.fill("#cpw", password);
  await m.click("button.auth-btn[type=submit]");
  await m.waitForURL(/\/dashboard|\/campaigns/, { timeout: 30_000 });
  out.mobile.landing = { url: m.url(), ...(await overflow(m)) };
  await m.goto(`${BASE}/campaigns`, { waitUntil: "domcontentloaded" });
  await m.waitForSelector("text=E2E Diwali launch", { timeout: 30_000 });
  out.mobile.list = await overflow(m);
  check("mobile: a draft row says what to do next", /Next: /.test(await bodyText(m)));
  await shot(m, "m1-campaigns");
  await m.goto(`${BASE}/campaigns/new`, { waitUntil: "domcontentloaded" });
  await m.waitForSelector("#c-name", { timeout: 30_000 });
  await waitEnabled(m, "form button[type=submit]");
  out.mobile.details = { ...(await overflow(m)), nav: await stepNav(m), stepLine: (await bodyText(m)).includes("Step 1 of 4") };
  await shot(m, "m2-details");
  await m.fill("#c-name", "E2E mobile post");
  await m.click("form button[type=submit]");
  await m.waitForURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const mobileDraftId = m.url().match(/\/campaigns\/([0-9a-f-]{36})/)[1];
  await m.waitForSelector("input[type=file]", { state: "attached", timeout: 30_000 });
  await m.waitForTimeout(800);
  out.mobile.content = { nav: await stepNav(m), stepLine: (await bodyText(m)).includes("Step 2 of 4"), cancel: await m.getByRole("button", { name: "Cancel campaign" }).isVisible() };
  check("mobile: the step indicator fits and names the step", out.mobile.details.nav?.fits && out.mobile.details.stepLine && out.mobile.content.nav?.fits && out.mobile.content.stepLine, { details: out.mobile.details.nav, content: out.mobile.content.nav });
  check("mobile: Cancel campaign is reachable", out.mobile.content.cancel);
  await m.getByRole("button", { name: /^Post\b/ }).first().click();
  await m.setInputFiles("input[type=file] >> nth=0", MEDIA_IMAGE);
  await m.waitForFunction(() => !/Uploading|Checking file|Queued/.test(document.body.innerText) && document.querySelector("img[alt]"), null, { timeout: 90_000 });
  out.mobile.creative = await overflow(m);
  await shot(m, "m3-content");
  await m.getByRole("button", { name: /Save & choose accounts/ }).click();
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
    engagementShown: /engagement/i.test(await m.evaluate(() => document.querySelector("ul li")?.innerText ?? "")),
  };
  check("mobile: account rows show engagement", out.mobile.accounts.engagementShown);
  check("mobile: the bottom bar never covers the last account", out.mobile.accounts.lastRowCoveredPx === 0 && out.mobile.accounts.continueVisible, out.mobile.accounts);
  await shot(m, "m4-accounts");
  // Review (the passed-date draft from the desktop pass) and the live campaign page, on a phone.
  if (typeof staleId === "string") {
    await m.goto(`${BASE}/campaigns/${staleId}?step=pay`, { waitUntil: "domcontentloaded" });
    await m.waitForFunction(() => /Submit for review|Preparing preview|Pay ₹/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
    out.mobile.review = await overflow(m);
    await shot(m, "m5-review");
  }
  if (campaignId) {
    await m.goto(`${BASE}/campaigns/${campaignId}`, { waitUntil: "domcontentloaded" });
    await m.waitForSelector("a:has-text('View post')", { timeout: 30_000 }).catch(() => {});
    out.mobile.live = await overflow(m);
    await shot(m, "m6-live");
  }
  await m.goto(`${BASE}/campaigns/${mobileDraftId}?step=accounts`, { waitUntil: "domcontentloaded" });
  await m.waitForSelector("ul li input[type=checkbox]", { timeout: 30_000 });
  // Cancel this draft from the header.
  await m.evaluate(() => window.scrollTo(0, 0));
  await m.getByRole("button", { name: "Cancel campaign" }).click();
  await m.waitForURL(/\/campaigns$/, { timeout: 30_000 }).catch(() => {});
  await m.waitForFunction(() => document.body.innerText.includes("E2E mobile post") && /Cancelled/i.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
  out.mobile.cancelled = { url: m.url(), text: (await bodyText(m)).includes("Cancelled") };
  check("mobile: cancelling lands on the list with the row cancelled", /\/campaigns$/.test(out.mobile.cancelled.url) && out.mobile.cancelled.text, out.mobile.cancelled);
  for (const k of ["landing", "list", "details", "creative", "accounts", "review", "live"]) {
    if (!out.mobile[k]) continue;
    check(`mobile: nothing runs off the screen on ${k}`, out.mobile[k].overflowPx === 0 && out.mobile[k].clippedPx <= 0, { overflowPx: out.mobile[k].overflowPx, clippedPx: out.mobile[k].clippedPx, worst: out.mobile[k].worst });
  }
  await mctx.close();

  // Deliberate 409 (second checkout) and the slowed / cancelled carousel upload are expected.
  const unexpected = out.httpErrors.filter((h) => !(h.status === 409 && /checkout/.test(h.url)));
  out.unexpectedHttpErrors = unexpected;
  out.ok = out.pageErrors.length === 0 && out.checks.every((c) => c.pass);
} catch (err) {
  out.error = String(err?.message ?? err);
  step("FAILED", { error: out.error });
  if (current) await shot(current, "zz-failure");
} finally {
  out.campaignId = campaignId;
  out.email = email;
  out.passed = out.checks.filter((c) => c.pass).length;
  out.failed = out.checks.filter((c) => !c.pass).map((c) => c.name);
  out.totalMs = Date.now() - t0;
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
