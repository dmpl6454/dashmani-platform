/**
 * Self-serve campaign booking: pure helpers, then the whole flow against Postgres —
 * rate card → catalogue → chunked upload → creative → render → checkout → Razorpay webhook →
 * review → mark posted → delivery email, plus the money and isolation guards.
 *
 * External tools are stubbed: ffprobe (mediaTools.probe), ffmpeg (renderTools.run), Razorpay
 * (razorpayHttp.fetch) and SMTP (sendEmail). Files go to a throwaway CAMPAIGN_MEDIA_DIR.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";
import { CAMPAIGN_UPLOAD_CHUNK_BYTES, isPlatformPostUrl, todayIST } from "@dashmani/shared";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { sendEmail } from "../src/services/email.service";
import { mediaTools, sniffMime, parseProbe, diskAllows } from "../src/services/campaign/media.service";
import { renderTools, renderNext, wrapOverlay, buildFfmpegArgs } from "../src/services/campaign/render.service";
import { razorpayHttp, verifyWebhookSignature } from "../src/services/campaign/razorpay";
import { computeTotal } from "../src/services/campaign/payment.service";
import { invalidateCatalogueCache } from "../src/services/campaign/rate-card.service";
import { signedMediaPath, verifyMediaSignature } from "../src/services/campaign/media-url";
import { generateToken } from "./helpers";

const SECRET = process.env.JWT_SECRET || "dev-secret";
const WEBHOOK_SECRET = "whsec_test";
let mediaDir: string;

beforeAll(() => {
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-media-"));
  process.env.CAMPAIGN_MEDIA_DIR = mediaDir;
  process.env.CAMPAIGN_MIN_FREE_GB = "0";
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});
afterAll(() => {
  fs.rmSync(mediaDir, { recursive: true, force: true });
  for (const k of ["CAMPAIGN_MEDIA_DIR", "CAMPAIGN_MIN_FREE_GB", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) delete process.env[k];
});

// ── Pure helpers ────────────────────────────────────────────────────────────────

describe("campaign pure helpers", () => {
  it("prices from items only", () => {
    expect(computeTotal([{ pricePaise: 150_000 }, { pricePaise: 99_900 }])).toBe(249_900);
    expect(computeTotal([])).toBe(0);
  });

  it("sniffs the real file type from magic bytes", () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("\x89PNG\r\n\x1a\n....", "latin1"))).toBe("image/png");
    expect(sniffMime(Buffer.from("\0\0\0\x18ftypisom\0\0", "latin1"))).toBe("video/mp4");
    expect(sniffMime(Buffer.from("\0\0\0\x14ftypqt  \0\0", "latin1"))).toBe("video/quicktime");
    expect(sniffMime(Buffer.from("<html><script>"))).toBeNull();
  });

  it("swaps width/height for rotated phone video", () => {
    const p = parseProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080, tags: { rotate: "90" } }], format: { duration: "12.5" } }));
    expect(p).toEqual({ hasVideo: true, width: 1080, height: 1920, durationMs: 12500 });
  });

  it("disk guard keeps 2.2× the file plus the floor free", () => {
    expect(diskAllows(10e9, 1e9, 5e9)).toBe(true);
    expect(diskAllows(7e9, 1e9, 5e9)).toBe(false);
  });

  it("never puts overlay text in the ffmpeg filter and refuses unsafe paths", () => {
    const hostile = "x':drawtext=text='%{pts}";
    const args = buildFfmpegArgs({ kind: "video", format: "reel", input: "/m/a.mp4", output: "/m/b.mp4", textFiles: ["/m/t.0.txt"], style: "top", fontFile: "/f/F.ttf" });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("textfile=/m/t.0.txt");
    expect(vf).toContain("expansion=none");
    expect(vf).not.toContain(hostile);
    expect(() => buildFfmpegArgs({ kind: "image", format: "post", input: "/m/a';b.jpg", output: "/m/o.jpg", textFiles: [], style: null, fontFile: null })).toThrow(/Unsafe/);
    expect(wrapOverlay("one two three four five six seven eight nine ten", 12).split("\n").every((l) => l.length <= 12)).toBe(true);
  });

  it("accepts post links only on the item's platform", () => {
    expect(isPlatformPostUrl("instagram", "https://www.instagram.com/reel/ABC/")).toBe(true);
    expect(isPlatformPostUrl("instagram", "https://instagram.com.evil.io/reel/ABC/")).toBe(false);
    expect(isPlatformPostUrl("facebook", "https://www.instagram.com/p/x")).toBe(false);
    expect(isPlatformPostUrl("youtube", "javascript:alert(1)")).toBe(false);
  });

  it("verifies webhook HMACs over the raw body", () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const sig = crypto.createHmac("sha256", "s").update(body).digest("hex");
    expect(verifyWebhookSignature(body, sig, "s")).toBe(true);
    expect(verifyWebhookSignature(Buffer.from('{"event":"payment.captured" }'), sig, "s")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "s")).toBe(false);
  });

  it("signed media links expire and bind the id and variant", () => {
    const p = signedMediaPath("abc", "preview", 60);
    const u = new URL(p, "http://x");
    expect(verifyMediaSignature("abc", "preview", u.searchParams.get("exp")!, u.searchParams.get("sig")!)).toBe(true);
    expect(verifyMediaSignature("abd", "preview", u.searchParams.get("exp")!, u.searchParams.get("sig")!)).toBe(false);
    expect(verifyMediaSignature("abc", "original", u.searchParams.get("exp")!, u.searchParams.get("sig")!)).toBe(false);
    expect(verifyMediaSignature("abc", "preview", "1", u.searchParams.get("sig")!)).toBe(false);
  });
});

// ── Integration ─────────────────────────────────────────────────────────────────

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const MP4_HEAD = Buffer.from("\0\0\0\x18ftypisom\0\0\0\0", "latin1");

function clientToken(id: string) {
  return jwt.sign({ userId: id, email: `${id}@c.test`, roles: [], type: "client" }, SECRET, { expiresIn: "15m" });
}

const rzpCalls: Array<{ url: string; body: any }> = [];
function stubRazorpay() {
  rzpCalls.length = 0;
  let n = 0;
  razorpayHttp.fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    rzpCalls.push({ url: String(url), body });
    if (String(url).endsWith("/orders")) {
      return new Response(JSON.stringify({ id: `order_${++n}`, amount: body.amount, currency: "INR", status: "created" }), { status: 200 });
    }
    if (String(url).includes("/refund")) {
      return new Response(JSON.stringify({ id: `rfnd_${++n}`, amount: body.amount, status: "processed" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function webhook(event: string, entity: Record<string, unknown>, eventId = crypto.randomUUID()) {
  const raw = JSON.stringify({ event, payload: { payment: { entity } } });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app)
    .post("/v1/webhooks/razorpay")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", sig)
    .set("x-razorpay-event-id", eventId)
    .send(raw);
}

describe("campaign booking flow", () => {
  let clientA: { id: string };
  let clientB: { id: string };
  let tokA: string;
  let tokB: string;
  let admin: string;
  let assetId: string;

  beforeEach(async () => {
    invalidateCatalogueCache();
    stubRazorpay();
    vi.mocked(sendEmail).mockClear();
    mediaTools.probe = async (file: string) => {
      const head = fs.readFileSync(file).subarray(0, 4);
      return head[0] === 0xff ? { hasVideo: false, width: 1080, height: 1350, durationMs: null } : { hasVideo: true, width: 1080, height: 1920, durationMs: 20_000 };
    };
    renderTools.run = async (args: string[]) => {
      fs.writeFileSync(args[args.length - 1], "rendered");
    };

    clientA = await prisma.client.create({ data: { companyName: "Brand A", contactName: "Asha", email: "a@brand.test", passwordHash: "x" } });
    clientB = await prisma.client.create({ data: { companyName: "Brand B", contactName: "Bo", email: "b@brand.test", passwordHash: "x" } });
    tokA = clientToken(clientA.id);
    tokB = clientToken(clientB.id);
    const staff = await prisma.user.create({ data: { name: "Staff", email: "staff@ds.test", passwordHash: "x", status: "ACTIVE" } });
    admin = generateToken(staff.id, staff.email, ["Admin"]);
    const conn = await prisma.metaConnection.create({ data: { metaUserId: "mu-1", connectedById: staff.id, status: "ACTIVE" } });
    const asset = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "1789", name: "Bollywood Society", username: "bollywoodsociety", followerCount: 4_600_000, views28d: 1_000_000n, engagements28d: 50_000n },
    });
    assetId = asset.id;
  });

  async function setRates(price = 250_000) {
    const res = await request(app)
      .put("/v1/admin/campaign-rate-cards")
      .set("Authorization", `Bearer ${admin}`)
      .send({ cards: [{ targetType: "meta_asset", targetId: assetId, format: "post", pricePaise: price, category: "Bollywood news" }] });
    expect(res.status).toBe(200);
  }

  async function upload(tok: string, buf: Buffer, mime: string) {
    const init = await request(app).post("/v1/client/campaign-uploads").set("Authorization", `Bearer ${tok}`).send({ filename: "a.jpg", size: buf.length, mime });
    expect(init.status).toBe(201);
    const id = init.body.data.id;
    for (let n = 0; n < init.body.data.totalChunks; n++) {
      const part = buf.subarray(n * CAMPAIGN_UPLOAD_CHUNK_BYTES, (n + 1) * CAMPAIGN_UPLOAD_CHUNK_BYTES);
      const r = await request(app).put(`/v1/client/campaign-uploads/${id}/chunks/${n}`).set("Authorization", `Bearer ${tok}`).set("Content-Type", "application/octet-stream").send(part);
      expect(r.status).toBe(200);
    }
    return { id, complete: await request(app).post(`/v1/client/campaign-uploads/${id}/complete`).set("Authorization", `Bearer ${tok}`) };
  }

  const info = () => ({ name: "Diwali launch", brand: "Brand A", launchFrom: todayIST(), launchTo: todayIST() });

  async function readyBooking() {
    await setRates();
    const created = await request(app).post("/v1/client/campaigns").set("Authorization", `Bearer ${tokA}`).send(info());
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const up = await upload(tokA, JPEG, "image/jpeg");
    expect(up.complete.status).toBe(200);
    const cr = await request(app)
      .put(`/v1/client/campaigns/${id}/creative`)
      .set("Authorization", `Bearer ${tokA}`)
      .send({ format: "post", mediaIds: [up.id], caption: "Big news #diwali", superText: "50% OFF\ntoday", superTextStyle: "bottom" });
    expect(cr.status).toBe(200);
    expect(await renderNext({ ignoreLoad: true })).toBe(up.id);
    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    const rateCardId = cat.body.data[0].offers[0].rateCardId;
    const items = await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: [rateCardId] });
    expect(items.status).toBe(200);
    return { id, mediaId: up.id, rateCardId };
  }

  async function pay(id: string) {
    const co = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`);
    expect(co.status).toBe(200);
    const res = await webhook("payment.captured", { id: `pay_${id.slice(0, 8)}`, order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR", status: "captured" });
    expect(res.status).toBe(200);
    return co.body.data;
  }

  it("catalogue exposes only the documented fields, never earnings or tokens", async () => {
    await setRates();
    const res = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ["category", "engagementRatePct", "followers", "name", "offers", "pictureUrl", "platform", "profileUrl", "targetId", "targetType", "username", "views28d"].sort(),
    );
    expect(res.body.data[0]).toMatchObject({ category: "Bollywood news", followers: 4_600_000, engagementRatePct: 5, offers: [{ format: "post", pricePaise: 250_000 }] });
  });

  it("rejects staff-only and cross-portal access", async () => {
    expect((await request(app).get("/v1/admin/campaigns").set("Authorization", `Bearer ${tokA}`)).status).toBe(403);
    expect((await request(app).get("/v1/client/campaigns").set("Authorization", `Bearer ${admin}`)).status).toBe(403);
  });

  it("chunked upload: oversize chunk 413, out-of-order chunks, missing chunk, fake file rejected", async () => {
    const big = Buffer.concat([MP4_HEAD, Buffer.alloc(CAMPAIGN_UPLOAD_CHUNK_BYTES + 1000 - MP4_HEAD.length, 1)]);
    const init = await request(app).post("/v1/client/campaign-uploads").set("Authorization", `Bearer ${tokA}`).send({ filename: "v.mp4", size: big.length, mime: "video/mp4" });
    const id = init.body.data.id;
    expect(init.body.data.totalChunks).toBe(2);
    const put = (n: number, b: Buffer) => request(app).put(`/v1/client/campaign-uploads/${id}/chunks/${n}`).set("Authorization", `Bearer ${tokA}`).set("Content-Type", "application/octet-stream").send(b);

    expect((await put(1, Buffer.alloc(2000))).status).toBe(413);
    expect((await put(1, big.subarray(CAMPAIGN_UPLOAD_CHUNK_BYTES))).status).toBe(200); // out of order
    const early = await request(app).post(`/v1/client/campaign-uploads/${id}/complete`).set("Authorization", `Bearer ${tokA}`);
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe("CHUNKS_MISSING");
    expect((await put(0, big.subarray(0, CAMPAIGN_UPLOAD_CHUNK_BYTES))).status).toBe(200);
    expect((await put(0, big.subarray(0, CAMPAIGN_UPLOAD_CHUNK_BYTES))).status).toBe(200); // duplicate re-send
    const st = await request(app).get(`/v1/client/campaign-uploads/${id}`).set("Authorization", `Bearer ${tokA}`);
    expect(st.body.data.receivedChunks).toEqual([0, 1]);
    const done = await request(app).post(`/v1/client/campaign-uploads/${id}/complete`).set("Authorization", `Bearer ${tokA}`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ uploadStatus: "complete", mime: "video/mp4", durationMs: 20_000 });

    // Another client cannot see it.
    expect((await request(app).get(`/v1/client/campaign-uploads/${id}`).set("Authorization", `Bearer ${tokB}`)).status).toBe(404);

    // A "JPEG" that is really HTML is rejected and deleted.
    const fake = Buffer.from("<html><script>alert(1)</script></html>");
    const f = await upload(tokA, fake, "image/jpeg");
    expect(f.complete.status).toBe(400);
    expect(f.complete.body.error.code).toBe("FILE_REJECTED");
  });

  it("full flow: pay via webhook, review, post, one delivery email with every link", async () => {
    const { id } = await readyBooking();
    // Another client's booking is invisible.
    expect((await request(app).get(`/v1/client/campaigns/${id}`).set("Authorization", `Bearer ${tokB}`)).status).toBe(404);
    expect((await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokB}`)).status).toBe(404);

    const co = await pay(id);
    expect(co.amount).toBe(250_000);
    expect(rzpCalls[0].body).toMatchObject({ amount: 250_000, currency: "INR", payment_capture: 1 });
    let b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id } });
    expect(b.status).toBe("paid_pending_review");

    // Redelivered event: no second transition.
    const evts = await prisma.campaignBookingEvent.count({ where: { bookingId: id } });
    const lastEvt = await prisma.razorpayWebhookEvent.findFirstOrThrow({ orderBy: { receivedAt: "desc" } });
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: co.orderId, amount: co.amount, currency: "INR" } } } });
    const dup = await request(app).post("/v1/webhooks/razorpay").set("Content-Type", "application/json")
      .set("x-razorpay-signature", crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")).set("x-razorpay-event-id", lastEvt.eventId).send(raw);
    expect(dup.status).toBe(200);
    expect(dup.body.data.duplicate).toBe(true);
    expect(await prisma.campaignBookingEvent.count({ where: { bookingId: id } })).toBe(evts);

    // Tampered body: 400.
    const bad = await request(app).post("/v1/webhooks/razorpay").set("Content-Type", "application/json").set("x-razorpay-signature", "00").send(raw);
    expect(bad.status).toBe(400);

    // Editing is locked once paid.
    expect((await request(app).put(`/v1/client/campaigns/${id}/info`).set("Authorization", `Bearer ${tokA}`).send(info())).status).toBe(409);

    // Review.
    const q = await request(app).get("/v1/admin/campaigns").set("Authorization", `Bearer ${admin}`);
    expect(q.body.data[0]).toMatchObject({ id, status: "paid_pending_review", client: "Brand A" });
    expect((await request(app).post(`/v1/admin/campaigns/${id}/approve`).set("Authorization", `Bearer ${admin}`)).status).toBe(200);
    const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: id } });
    expect(item.status).toBe("manual_pending");

    const wrong = await request(app).post(`/v1/admin/campaigns/${id}/items/${item.id}/posted`).set("Authorization", `Bearer ${admin}`).send({ url: "https://www.facebook.com/reel/1" });
    expect(wrong.status).toBe(400);
    const ok = await request(app).post(`/v1/admin/campaigns/${id}/items/${item.id}/posted`).set("Authorization", `Bearer ${admin}`).send({ url: "https://www.instagram.com/p/DABC123/" });
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id } });
    expect(b.status).toBe("completed");
    expect(b.deliveredAt).not.toBeNull();
    const deliveries = vi.mocked(sendEmail).mock.calls.filter(([o]) => o.to === "a@brand.test" && o.subject.startsWith("Delivered"));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0][0].html).toContain("https://www.instagram.com/p/DABC123/");

    // Updating the link does not send it again; an explicit resend does.
    await request(app).post(`/v1/admin/campaigns/${id}/items/${item.id}/posted`).set("Authorization", `Bearer ${admin}`).send({ url: "https://www.instagram.com/p/DABC124/" });
    expect(vi.mocked(sendEmail).mock.calls.filter(([o]) => o.to === "a@brand.test" && o.subject.startsWith("Delivered"))).toHaveLength(1);
    expect((await request(app).post(`/v1/admin/campaigns/${id}/resend-delivery`).set("Authorization", `Bearer ${admin}`)).status).toBe(200);
    expect(vi.mocked(sendEmail).mock.calls.filter(([o]) => o.to === "a@brand.test" && o.subject.startsWith("Delivered"))).toHaveLength(2);

    // The client sees the link; another client sees nothing.
    const results = await request(app).get(`/v1/client/campaigns/${id}/results`).set("Authorization", `Bearer ${tokA}`);
    expect(results.body.data.items[0]).toMatchObject({ status: "posted_manual", permalink: "https://www.instagram.com/p/DABC124/", metrics: null });
    expect((await request(app).get(`/v1/client/campaigns/${id}/results`).set("Authorization", `Bearer ${tokB}`)).status).toBe(404);
  });

  it("checkout needs a finished render, and ignores client-sent prices", async () => {
    await setRates(100_000);
    const created = await request(app).post("/v1/client/campaigns").set("Authorization", `Bearer ${tokA}`).send(info());
    const id = created.body.data.id;
    const up = await upload(tokA, JPEG, "image/jpeg");
    await request(app).put(`/v1/client/campaigns/${id}/creative`).set("Authorization", `Bearer ${tokA}`).send({ format: "post", mediaIds: [up.id] });
    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: [cat.body.data[0].offers[0].rateCardId], pricePaise: 1 });
    const early = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`).send({ amount: 100 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("RENDER_PENDING");
    await renderNext({ ignoreLoad: true });
    const co = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`).send({ amount: 100 });
    expect(co.body.data.amount).toBe(100_000);
  });

  it("a payment for an outdated order is refunded, not accepted", async () => {
    const { id } = await readyBooking();
    const co = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`);
    // Client edits after checkout → back to draft, total cleared.
    await request(app).put(`/v1/client/campaigns/${id}/info`).set("Authorization", `Bearer ${tokA}`).send({ ...info(), name: "Renamed" });
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id } })).status).toBe("draft");
    const res = await webhook("payment.captured", { id: "pay_old", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" });
    expect(res.status).toBe(200);
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id } })).status).toBe("draft");
    expect(rzpCalls.some((c) => c.url.includes("/payments/pay_old/refund") && c.body.amount === co.body.data.amount)).toBe(true);
  });

  it("reject refunds in full exactly once", async () => {
    const { id } = await readyBooking();
    await pay(id);
    const r = await request(app).post(`/v1/admin/campaigns/${id}/reject`).set("Authorization", `Bearer ${admin}`).send({ note: "Brand not permitted on our network" });
    expect(r.status).toBe(200);
    const refunds = rzpCalls.filter((c) => c.url.includes("/refund"));
    expect(refunds).toHaveLength(1);
    expect(refunds[0].body.amount).toBe(250_000);
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id } })).status).toBe("refunded");
    expect((await request(app).post(`/v1/admin/campaigns/${id}/reject`).set("Authorization", `Bearer ${admin}`).send({ note: "again please" })).status).toBe(409);
    expect(rzpCalls.filter((c) => c.url.includes("/refund"))).toHaveLength(1);
  });

  it("offline mode (no Razorpay keys): checkout submits for review with no payment row; reject and drop charge nothing", async () => {
    const { id } = await readyBooking();
    const keys = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET };
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      expect((await request(app).get(`/v1/client/campaigns/${id}`).set("Authorization", `Bearer ${tokA}`)).body.data.paymentMode).toBe("offline");
      const calls = rzpCalls.length;
      const co = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`);
      expect(co.status).toBe(200);
      expect(co.body.data).toMatchObject({ offline: true, amount: 250_000, status: "paid_pending_review" });
      expect(co.body.data.orderId).toBeUndefined();
      expect(rzpCalls).toHaveLength(calls); // the gateway was never called
      const b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id }, include: { payments: true, items: true } });
      expect(b.status).toBe("paid_pending_review");
      expect(b.paidAt).toBeNull();
      expect(b.submittedAt).not.toBeNull();
      expect(b.totalPaise).toBe(250_000);
      expect(b.pricingSnapshot).not.toBeNull();
      expect(b.payments).toHaveLength(0);
      expect(b.items[0].pricePaise).toBe(250_000);
      // Editing is locked, exactly as after an online payment.
      expect((await request(app).put(`/v1/client/campaigns/${id}/info`).set("Authorization", `Bearer ${tokA}`).send(info())).status).toBe(409);
      await new Promise((r) => setTimeout(r, 50));
      // The client email says "submitted", never "payment received"; staff are told to collect.
      const clientMail = vi.mocked(sendEmail).mock.calls.find(([o]) => o.to === "a@brand.test" && o.subject.includes("Submitted for review"));
      expect(clientMail).toBeDefined();
      expect(vi.mocked(sendEmail).mock.calls.some(([o]) => o.to === "a@brand.test" && o.subject.startsWith("Payment received"))).toBe(false);

      // Dropping an item needs no captured payment and calls no refund.
      expect((await request(app).post(`/v1/admin/campaigns/${id}/approve`).set("Authorization", `Bearer ${admin}`)).status).toBe(200);
      const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: id } });
      const rf = await request(app).post(`/v1/admin/campaigns/${id}/items/${item.id}/refund`).set("Authorization", `Bearer ${admin}`);
      expect(rf.status).toBe(200);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("refunded");
      expect(rzpCalls.filter((c) => c.url.includes("/refund"))).toHaveLength(0);

      // Rejecting an offline booking stays `rejected` (never claims a refund) and calls no refund.
      const { id: id2 } = await readyBooking();
      expect((await request(app).post(`/v1/client/campaigns/${id2}/checkout`).set("Authorization", `Bearer ${tokA}`)).status).toBe(200);
      const rj = await request(app).post(`/v1/admin/campaigns/${id2}/reject`).set("Authorization", `Bearer ${admin}`).send({ note: "Not on our network" });
      expect(rj.status).toBe(200);
      expect(rj.body.data.refundError).toBeNull();
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: id2 } })).status).toBe("rejected");
      expect(rzpCalls.filter((c) => c.url.includes("/refund"))).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 50));
      const rejMail = vi.mocked(sendEmail).mock.calls.find(([o]) => o.to === "a@brand.test" && o.subject.startsWith("Not approved"));
      expect(rejMail?.[0].html).toContain("Nothing has been charged");
      expect(rejMail?.[0].html).not.toContain("refunded to your original payment method");
    } finally {
      process.env.RAZORPAY_KEY_ID = keys.id;
      process.env.RAZORPAY_KEY_SECRET = keys.secret;
    }
  });

  it("changes requested → client re-submits; refunding the only item lists it honestly in delivery", async () => {
    const { id } = await readyBooking();
    await pay(id);
    await request(app).post(`/v1/admin/campaigns/${id}/request-changes`).set("Authorization", `Bearer ${admin}`).send({ note: "Logo too small" });
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id } })).status).toBe("changes_requested");
    expect((await request(app).post(`/v1/client/campaigns/${id}/submit-changes`).set("Authorization", `Bearer ${tokA}`)).status).toBe(200);
    await request(app).post(`/v1/admin/campaigns/${id}/approve`).set("Authorization", `Bearer ${admin}`);
    const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: id } });
    const rf = await request(app).post(`/v1/admin/campaigns/${id}/items/${item.id}/refund`).set("Authorization", `Bearer ${admin}`);
    expect(rf.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id } })).status).toBe("partially_published");
    const mail = vi.mocked(sendEmail).mock.calls.find(([o]) => o.to === "a@brand.test" && o.subject.startsWith("Delivered"));
    expect(mail?.[0].html).toContain("refunded");
  });
  it("campaign type picks the brand or entertainment price; reel song audio adds the account's add-on", async () => {
    const rates = await request(app)
      .put("/v1/admin/campaign-rate-cards")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        cards: [
          { targetType: "meta_asset", targetId: assetId, format: "reel", pricePaise: 300_000, entertainmentPricePaise: 200_000, audioAddonPaise: 50_000 },
          { targetType: "meta_asset", targetId: assetId, format: "post", pricePaise: 100_000, audioAddonPaise: 99_900 },
        ],
      });
    expect(rates.status).toBe(200);
    // An audio add-on is a reel-only thing: it is not stored on a post card.
    const post = await prisma.campaignRateCard.findFirstOrThrow({ where: { format: "post" } });
    expect(post.audioAddonPaise).toBeNull();

    const created = await request(app).post("/v1/client/campaigns").set("Authorization", `Bearer ${tokA}`).send({ ...info(), campaignType: "entertainment" });
    expect(created.body.data.campaignType).toBe("entertainment");
    const id = created.body.data.id;
    const video = Buffer.concat([MP4_HEAD, Buffer.alloc(2000, 1)]);
    const up = await upload(tokA, video, "video/mp4");
    expect(up.complete.status).toBe(200);
    const creative = (extra: Record<string, unknown>) =>
      request(app).put(`/v1/client/campaigns/${id}/creative`).set("Authorization", `Bearer ${tokA}`).send({ format: "reel", mediaIds: [up.id], ...extra });

    // Audio needs a song, and is reels only.
    expect((await creative({ audioIntegration: true })).status).toBe(400);
    expect((await request(app).put(`/v1/client/campaigns/${id}/creative`).set("Authorization", `Bearer ${tokA}`).send({ format: "post", mediaIds: [up.id], audioIntegration: true, audioTrack: "Kesariya" })).status).toBe(400);
    const cr = await creative({ audioIntegration: true, audioTrack: "Kesariya – Arijit Singh" });
    expect(cr.status).toBe(200);
    expect(cr.body.data).toMatchObject({ audioIntegration: true, audioTrack: "Kesariya – Arijit Singh" });
    await renderNext({ ignoreLoad: true });

    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    const reelOffer = cat.body.data[0].offers.find((o: any) => o.format === "reel");
    expect(reelOffer).toMatchObject({ pricePaise: 300_000, entertainmentPricePaise: 200_000, audioAddonPaise: 50_000 });
    const items = await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: [reelOffer.rateCardId] });
    expect(items.status).toBe(200);
    expect(items.body.data.items[0]).toMatchObject({ pricePaise: 250_000, audioAddonPaise: 50_000 });

    // Switching to a brand campaign re-prices the booked account; dropping audio removes the add-on.
    const asBrand = await request(app).put(`/v1/client/campaigns/${id}/info`).set("Authorization", `Bearer ${tokA}`).send({ ...info(), campaignType: "brand" });
    expect(asBrand.body.data.items[0]).toMatchObject({ pricePaise: 350_000, audioAddonPaise: 50_000 });
    const noAudio = await creative({ audioIntegration: false });
    expect(noAudio.body.data.items[0]).toMatchObject({ pricePaise: 300_000, audioAddonPaise: 0 });
    await creative({ audioIntegration: true, audioTrack: "Kesariya – Arijit Singh" });
    await renderNext({ ignoreLoad: true });

    // Checkout charges the server's price and records how it was built.
    const co = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`);
    expect(co.status).toBe(200);
    expect(co.body.data.amount).toBe(350_000);
    const b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id } });
    expect(b.pricingSnapshot).toMatchObject({ campaignType: "brand", audioIntegration: true, items: [{ basePaise: 300_000, audioAddonPaise: 50_000, pricePaise: 350_000 }] });

    // After payment the audio option is frozen — it is part of what was paid for.
    await webhook("payment.captured", { id: "pay_audio", order_id: co.body.data.orderId, amount: 350_000, currency: "INR", status: "captured" });
    await request(app).post(`/v1/admin/campaigns/${id}/request-changes`).set("Authorization", `Bearer ${admin}`).send({ note: "New cut please" });
    const frozen = await creative({ audioIntegration: false });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe("PAID_TERMS_FROZEN");
    const sameTerms = await creative({ audioIntegration: true, audioTrack: "Kesariya (remix)" });
    expect(sameTerms.status).toBe(200);
    expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: id } })).pricePaise).toBe(350_000);
  });

  it("thumbnail + per-account text: own renders, checkout waits for them, staff get each account's files", async () => {
    // Two accounts bookable for a reel.
    const fb = await prisma.metaAsset.create({
      data: { connectionId: (await prisma.metaConnection.findFirstOrThrow()).id, kind: "FACEBOOK_PAGE", metaId: "5555", name: "Filme Flicks", followerCount: 10 },
    });
    const rates = await request(app).put("/v1/admin/campaign-rate-cards").set("Authorization", `Bearer ${admin}`).send({
      cards: [
        { targetType: "meta_asset", targetId: assetId, format: "reel", pricePaise: 100_000 },
        { targetType: "meta_asset", targetId: fb.id, format: "reel", pricePaise: 100_000 },
      ],
    });
    expect(rates.status).toBe(200);
    const created = await request(app).post("/v1/client/campaigns").set("Authorization", `Bearer ${tokA}`).send(info());
    const id = created.body.data.id;
    const video = await upload(tokA, Buffer.concat([MP4_HEAD, Buffer.alloc(2000, 1)]), "video/mp4");
    const cover = await upload(tokA, JPEG, "image/jpeg");
    const creative = (extra: Record<string, unknown> = {}) =>
      request(app).put(`/v1/client/campaigns/${id}/creative`).set("Authorization", `Bearer ${tokA}`)
        .send({ format: "reel", mediaIds: [video.id], caption: "Campaign caption", hashtags: ["diwali"], superText: "FLAT 50% OFF", superTextStyle: "bottom", thumbnailMediaId: cover.id, ...extra });

    // The thumbnail can't double as the creative, and must be an image.
    expect((await creative({ thumbnailMediaId: video.id })).status).toBe(400);
    expect((await creative({ mediaIds: [cover.id], thumbnailMediaId: video.id })).status).toBe(400);
    const cr = await creative();
    expect(cr.status).toBe(200);
    expect(cr.body.data.media).toHaveLength(1);
    expect(cr.body.data.thumbnail).toMatchObject({ id: cover.id, role: "thumbnail", kind: "image", renderStatus: "queued" });
    // Both files render with the default overlay (creative first, then the thumbnail).
    expect(await renderNext({ ignoreLoad: true })).toBe(video.id);
    expect(await renderNext({ ignoreLoad: true })).toBe(cover.id);
    expect(await renderNext({ ignoreLoad: true })).toBeNull();

    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    const cards = cat.body.data.flatMap((a: any) => a.offers.map((o: any) => o.rateCardId));
    const items = await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: cards });
    expect(items.status).toBe(200);
    expect(items.body.data.items).toHaveLength(2);
    const [itemA, itemB] = items.body.data.items;
    expect(itemA.renderStatus).toBeNull(); // posts the default files

    // Account A gets its own caption and overlay → its own render of BOTH files is queued.
    const text = (body: Record<string, unknown>) => request(app).put(`/v1/client/campaigns/${id}/items/${itemA.id}/text`).set("Authorization", `Bearer ${tokA}`).send(body);
    expect((await text({ caption: "x".repeat(2201), superText: null })).status).toBe(400);
    const set = await text({ caption: "Only for Bollywood Society", hashtags: ["bs"], superText: "BS SPECIAL", superTextStyle: "top" });
    expect(set.status).toBe(200);
    const a = set.body.data.items.find((i: any) => i.id === itemA.id);
    expect(a).toMatchObject({ captionOverride: "Only for Bollywood Society", hashtagsOverride: ["bs"], superTextOverride: "BS SPECIAL", superTextStyleOverride: "top", renderStatus: "queued" });
    expect(set.body.data.items.find((i: any) => i.id === itemB.id).renderStatus).toBeNull();
    expect(await prisma.campaignMediaRender.count({ where: { bookingId: id } })).toBe(2);
    // Another client can't touch it.
    expect((await request(app).put(`/v1/client/campaigns/${id}/items/${itemA.id}/text`).set("Authorization", `Bearer ${tokB}`).send({ caption: "hi", superText: null })).status).toBe(404);

    // Checkout waits for the variant renders exactly as it waits for the default ones.
    const early = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("RENDER_PENDING");
    const r1 = await renderNext({ ignoreLoad: true });
    const r2 = await renderNext({ ignoreLoad: true });
    expect(await renderNext({ ignoreLoad: true })).toBeNull();
    const renders = await prisma.campaignMediaRender.findMany({ where: { bookingId: id } });
    expect(renders.map((r) => r.id).sort()).toEqual([r1, r2].sort());
    expect(renders.every((r) => r.status === "done" && r.renderKey)).toBe(true);
    expect((await request(app).get(`/v1/client/campaigns/${id}`).set("Authorization", `Bearer ${tokA}`)).body.data.items.find((i: any) => i.id === itemA.id).renderStatus).toBe("done");

    // The variant is served through a signed "v-<id>" link bound to its own file; the default stays separate.
    const pv = await request(app).get(`/v1/client/campaigns/${id}/items/${itemA.id}/preview-urls`).set("Authorization", `Bearer ${tokA}`);
    expect(pv.status).toBe(200);
    expect(pv.body.data).toHaveLength(2);
    const vid = pv.body.data.find((f: any) => f.mediaId === video.id);
    expect(vid.url).toMatch(new RegExp(`/v1/campaign-media/${video.id}/v-[0-9a-f-]{36}\\?exp=`));
    expect((await request(app).get(vid.url)).status).toBe(200);
    const other = renders.find((r) => r.mediaId !== video.id)!;
    const swapped = vid.url.replace(/v-[0-9a-f-]{36}/, `v-${other.id}`);
    expect((await request(app).get(swapped)).status).toBe(403); // signature covers the variant
    expect((await request(app).get(signedMediaPath(video.id, `v-${other.id}`))).status).toBe(404); // right signature, wrong file
    const pvB = await request(app).get(`/v1/client/campaigns/${id}/items/${itemB.id}/preview-urls`).set("Authorization", `Bearer ${tokA}`);
    expect(pvB.body.data.every((f: any) => f.url.includes("/preview?"))).toBe(true);

    // Re-picking accounts keeps A's text; staff see each account's own files.
    const again = await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: cards });
    expect(again.body.data.items.find((i: any) => i.accountName === "Bollywood Society")).toMatchObject({ captionOverride: "Only for Bollywood Society", superTextOverride: "BS SPECIAL" });
    expect(await prisma.campaignMediaRender.count({ where: { bookingId: id } })).toBe(2);
    const co = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`);
    expect(co.status).toBe(200);
    const mu = await request(app).get(`/v1/admin/campaigns/${id}/media-urls`).set("Authorization", `Bearer ${admin}`);
    expect(mu.status).toBe(200);
    expect(mu.body.data.media.map((m: any) => m.role).sort()).toEqual(["creative", "thumbnail"]);
    const custom = mu.body.data.items.find((x: any) => x.custom);
    expect(custom.files.map((f: any) => f.role).sort()).toEqual(["creative", "thumbnail"]);
    expect(custom.files.every((f: any) => /\/v-[0-9a-f-]{36}\?/.test(f.url))).toBe(true);
    expect(mu.body.data.items.find((x: any) => !x.custom).files.every((f: any) => f.url.includes("/preview?"))).toBe(true);

    // Back to the campaign's text → the variants are dropped.
    await webhook("payment.captured", { id: "pay_ov", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR", status: "captured" });
    await request(app).post(`/v1/admin/campaigns/${id}/request-changes`).set("Authorization", `Bearer ${admin}`).send({ note: "Tone it down" });
    const itemAId = again.body.data.items.find((i: any) => i.accountName === "Bollywood Society").id;
    const reset = await request(app).put(`/v1/client/campaigns/${id}/items/${itemAId}/text`).set("Authorization", `Bearer ${tokA}`).send({ caption: null, superText: null });
    expect(reset.status).toBe(200);
    expect(reset.body.data.items.find((i: any) => i.id === itemAId)).toMatchObject({ captionOverride: null, superTextOverride: null, renderStatus: null });
    expect(await prisma.campaignMediaRender.count({ where: { bookingId: id } })).toBe(0);
    // "" = no overlay on this account: a variant with no text.
    const none = await request(app).put(`/v1/client/campaigns/${id}/items/${itemAId}/text`).set("Authorization", `Bearer ${tokA}`).send({ caption: null, superText: "" });
    expect(none.body.data.items.find((i: any) => i.id === itemAId)).toMatchObject({ superTextOverride: "", renderStatus: "queued" });
    expect((await prisma.campaignMediaRender.findFirstOrThrow({ where: { bookingId: id } })).overlayText).toBeNull();
  });

  it("per-account text guards: staff see file roles, variants follow dropped accounts and retry, overlays are capped, one ffmpeg job per tick", async () => {
    const conn = await prisma.metaConnection.findFirstOrThrow();
    const fb = await prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "6666", name: "Filme Flicks", followerCount: 10 } });
    const put = (cards: unknown[]) => request(app).put("/v1/admin/campaign-rate-cards").set("Authorization", `Bearer ${admin}`).send({ cards });
    expect(
      (await put([
        { targetType: "meta_asset", targetId: assetId, format: "reel", pricePaise: 100_000, entertainmentPricePaise: 120_000 },
        { targetType: "meta_asset", targetId: fb.id, format: "reel", pricePaise: 100_000 }, // brand only
      ])).status,
    ).toBe(200);
    const id = (await request(app).post("/v1/client/campaigns").set("Authorization", `Bearer ${tokA}`).send(info())).body.data.id;
    const video = await upload(tokA, Buffer.concat([MP4_HEAD, Buffer.alloc(2000, 1)]), "video/mp4");
    const cover = await upload(tokA, JPEG, "image/jpeg");
    expect(
      (await request(app).put(`/v1/client/campaigns/${id}/creative`).set("Authorization", `Bearer ${tokA}`)
        .send({ format: "reel", mediaIds: [video.id], caption: "Campaign caption", superText: "FLAT 50% OFF", superTextStyle: "bottom", thumbnailMediaId: cover.id })).status,
    ).toBe(200);
    await renderNext({ ignoreLoad: true });
    await renderNext({ ignoreLoad: true });
    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    const cards: string[] = cat.body.data.flatMap((a: any) => a.offers.map((o: any) => o.rateCardId));
    const items = await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: cards });
    // Items come back in a stable order (same-instant createMany rows used to shuffle).
    expect(items.body.data.items.map((i: any) => i.accountName)).toEqual(["Bollywood Society", "Filme Flicks"]);
    const [itemA, itemB] = items.body.data.items;
    const text = (item: { id: string }, body: Record<string, unknown>) =>
      request(app).put(`/v1/client/campaigns/${id}/items/${item.id}/text`).set("Authorization", `Bearer ${tokA}`).send(body);

    // Staff see which file is the thumbnail (the media list carries `role`).
    const staff = await request(app).get(`/v1/admin/campaigns/${id}`).set("Authorization", `Bearer ${admin}`);
    expect(staff.status).toBe(200);
    expect(staff.body.data.media.map((m: any) => m.role).sort()).toEqual(["creative", "thumbnail"]);

    // The signed link only becomes a download when asked (the portal and API are different origins).
    const link = signedMediaPath(video.id, "preview");
    const plain = await request(app).get(link);
    expect(plain.status).toBe(200);
    expect(plain.headers["content-disposition"]).toBeUndefined();
    const dl = await request(app).get(`${link}&download=1`);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="[\w.-]+-post\.mp4"$/);

    // A failed per-account render is retried by the next edit, like the default render is.
    expect((await text(itemB, { caption: null, superText: "B ONLY", superTextStyle: "top" })).status).toBe(200);
    expect(await prisma.campaignMediaRender.count({ where: { bookingId: id } })).toBe(2); // creative + thumbnail
    await prisma.campaignMediaRender.updateMany({ where: { bookingId: id }, data: { status: "failed", error: "boom" } });
    expect((await text(itemA, { caption: "Own caption", hashtags: ["a"], superText: null })).status).toBe(200);
    const retried = await prisma.campaignMediaRender.findMany({ where: { bookingId: id } });
    expect(retried).toHaveLength(2);
    expect(retried.every((r) => r.status === "queued" && r.error === null)).toBe(true);

    // A queued DEFAULT render that fails still uses the tick: no second ffmpeg run for a variant.
    await prisma.campaignMedia.update({ where: { id: video.id }, data: { renderStatus: "queued" } });
    const run = vi.fn(async () => {
      throw new Error("ffmpeg exploded");
    });
    renderTools.run = run;
    expect(await renderNext({ ignoreLoad: true })).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await prisma.campaignMedia.findUniqueOrThrow({ where: { id: video.id } })).renderStatus).toBe("failed");
    expect((await prisma.campaignMediaRender.findMany({ where: { bookingId: id } })).every((r) => r.status === "queued")).toBe(true);
    renderTools.run = async (args: string[]) => {
      fs.writeFileSync(args[args.length - 1], "rendered");
    };
    await prisma.campaignMedia.update({ where: { id: video.id }, data: { renderStatus: "done" } });
    expect(await renderNext({ ignoreLoad: true })).not.toBeNull();
    expect(await renderNext({ ignoreLoad: true })).not.toBeNull();
    expect(await renderNext({ ignoreLoad: true })).toBeNull();

    // A render of a purged file is never produced and must not hold checkout hostage.
    const gone = await upload(tokA, JPEG, "image/jpeg");
    await prisma.campaignMedia.update({ where: { id: gone.id }, data: { purgedAt: new Date(), bookingId: id } });
    await prisma.campaignMediaRender.create({ data: { mediaId: gone.id, bookingId: id, overlayKey: "k".repeat(40), overlayText: "X", overlayStyle: "top", status: "queued" } });
    const co = await request(app).post(`/v1/client/campaigns/${id}/checkout`).set("Authorization", `Bearer ${tokA}`);
    expect(co.status).toBe(200);
    await prisma.campaignMediaRender.deleteMany({ where: { mediaId: gone.id } });

    // Changing the campaign type drops accounts that don't offer it — and their custom-overlay renders.
    expect((await request(app).put(`/v1/client/campaigns/${id}/info`).set("Authorization", `Bearer ${tokA}`).send({ ...info(), campaignType: "entertainment" })).body.data.items.map((i: any) => i.accountName)).toEqual(["Bollywood Society"]);
    expect(await prisma.campaignMediaRender.count({ where: { bookingId: id } })).toBe(0);
    expect((await request(app).put(`/v1/client/campaigns/${id}/info`).set("Authorization", `Bearer ${tokA}`).send({ ...info(), campaignType: "brand" })).status).toBe(200);

    // Each distinct overlay is one more render of every file, so a booking may carry only a few.
    const extra = await Promise.all(
      Array.from({ length: 8 }, (_, i) => prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: `70${i}`, name: `Page ${i}`, followerCount: 5 } })),
    );
    expect((await put(extra.map((a) => ({ targetType: "meta_asset", targetId: a.id, format: "reel", pricePaise: 100_000 })))).status).toBe(200);
    const all = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    const ten: string[] = all.body.data.flatMap((a: any) => a.offers.map((o: any) => o.rateCardId));
    expect(ten).toHaveLength(10);
    const many = await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: ten });
    expect(many.status).toBe(200);
    const list = many.body.data.items as Array<{ id: string }>;
    for (let i = 0; i < 8; i++) expect((await text(list[i], { caption: null, superText: `Text ${i}`, superTextStyle: "top" })).status).toBe(200);
    const ninth = await text(list[8], { caption: null, superText: "Text 8", superTextStyle: "top" });
    expect(ninth.status).toBe(400);
    expect(ninth.body.error.code).toBe("TOO_MANY_OVERLAYS");
    expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: list[8].id } })).superTextOverride).toBeNull(); // rolled back
    // Reusing an overlay already on the booking is free.
    expect((await text(list[8], { caption: null, superText: "Text 3", superTextStyle: "top" })).status).toBe(200);
  });

  it("an account without an entertainment price can't be booked for an entertainment campaign", async () => {
    await setRates(100_000); // brand price only
    const created = await request(app).post("/v1/client/campaigns").set("Authorization", `Bearer ${tokA}`).send({ ...info(), campaignType: "entertainment" });
    const id = created.body.data.id;
    const up = await upload(tokA, JPEG, "image/jpeg");
    await request(app).put(`/v1/client/campaigns/${id}/creative`).set("Authorization", `Bearer ${tokA}`).send({ format: "post", mediaIds: [up.id] });
    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tokA}`);
    const res = await request(app).put(`/v1/client/campaigns/${id}/items`).set("Authorization", `Bearer ${tokA}`).send({ rateCardIds: [cat.body.data[0].offers[0].rateCardId] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("RATE_CARD_UNAVAILABLE");
  });
});
