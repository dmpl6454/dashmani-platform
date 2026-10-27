/**
 * Snapchat and YouTube channels in the client catalogue: tracked social_accounts rows priced on
 * the rate card, Snapchat's 60-second Spotlight limit (account picking AND checkout), the live
 * /@handle profile link, and post links checked against the platform's host.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";
import { CAMPAIGN_UPLOAD_CHUNK_BYTES, formatLabelFor, isPlatformPostUrl, platformVideoMaxSec, todayIST } from "@dashmani/shared";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { mediaTools } from "../src/services/campaign/media.service";
import { renderTools, renderNext } from "../src/services/campaign/render.service";
import { invalidateCatalogueCache } from "../src/services/campaign/rate-card.service";
import { generateToken } from "./helpers";

const SECRET = process.env.JWT_SECRET || "dev-secret";
const MP4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypisom\0\0\0\0", "latin1"), Buffer.alloc(3000, 1)]);
let mediaDir: string;
let savedMode: string | undefined;
let videoMs = 30_000;

beforeAll(() => {
  savedMode = process.env.CAMPAIGN_PAYMENT_MODE;
  process.env.CAMPAIGN_PAYMENT_MODE = "offline";
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-snap-"));
  process.env.CAMPAIGN_MEDIA_DIR = mediaDir;
  process.env.CAMPAIGN_MIN_FREE_GB = "0";
});
afterAll(() => {
  fs.rmSync(mediaDir, { recursive: true, force: true });
  delete process.env.CAMPAIGN_MEDIA_DIR;
  delete process.env.CAMPAIGN_MIN_FREE_GB;
  if (savedMode === undefined) delete process.env.CAMPAIGN_PAYMENT_MODE;
  else process.env.CAMPAIGN_PAYMENT_MODE = savedMode;
});

describe("platform helpers", () => {
  it("knows Snapchat's formats, hosts, labels and the Spotlight limit", () => {
    expect(isPlatformPostUrl("snapchat", "https://www.snapchat.com/spotlight/W7_EDlXWTBi")).toBe(true);
    expect(isPlatformPostUrl("snapchat", "https://snapchat.com.evil.io/x")).toBe(false);
    expect(isPlatformPostUrl("snapchat", "https://www.instagram.com/reel/x")).toBe(false);
    expect(platformVideoMaxSec("snapchat", "reel")).toBe(60);
    expect(platformVideoMaxSec("instagram", "reel")).toBeNull();
    expect(formatLabelFor("snapchat", "reel")).toBe("Spotlight");
    expect(formatLabelFor("youtube", "reel")).toBe("Short");
    expect(formatLabelFor("youtube", "post")).toBe("Video");
    expect(formatLabelFor("instagram", "reel")).toBe("Reel");
  });
});

describe("Snapchat and YouTube in the catalogue", () => {
  let tok: string;
  let admin: string;
  let snapId: string;
  let ytId: string;

  beforeEach(async () => {
    invalidateCatalogueCache();
    videoMs = 30_000;
    mediaTools.probe = async () => ({ hasVideo: true, width: 1080, height: 1920, durationMs: videoMs });
    renderTools.run = async (args: string[]) => {
      fs.writeFileSync(args[args.length - 1], "rendered");
    };
    const client = await prisma.client.create({ data: { companyName: "Brand S", contactName: "Sam", email: "s@brand.test", passwordHash: "x" } });
    tok = jwt.sign({ userId: client.id, email: client.email, roles: [], type: "client" }, SECRET, { expiresIn: "15m" });
    const staff = await prisma.user.create({ data: { name: "Staff", email: "staff-snap@ds.test", passwordHash: "x", status: "ACTIVE" } });
    admin = generateToken(staff.id, staff.email, ["Admin"]);
    const snap = await prisma.platform.create({ data: { name: "Snapchat", slug: "snapchat" } });
    const yt = await prisma.platform.create({ data: { name: "YouTube", slug: "youtube" } });
    snapId = (await prisma.socialAccount.create({
      data: { handle: "@bollywoodpaps", displayName: "Bollywood Paps", platformId: snap.id, followerCount: 396_100, profileUrl: "https://t.snapchat.com/dead" },
    })).id;
    ytId = (await prisma.socialAccount.create({
      data: { handle: "Inde-News", displayName: "Inde News", platformId: yt.id, followerCount: 10_500_000, profileUrl: "https://www.youtube.com/channel/UCuUfbik" },
    })).id;
  });

  const setRates = () =>
    request(app)
      .put("/v1/admin/campaign-rate-cards")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        cards: [
          { targetType: "social_account", targetId: snapId, format: "reel", pricePaise: 100_000 },
          { targetType: "social_account", targetId: ytId, format: "reel", pricePaise: 300_000 },
        ],
      });

  it("lists priced Snapchat and YouTube channels with the live Snapchat link", async () => {
    expect((await setRates()).status).toBe(200);
    // Snapchat has no carousel: a price for one is refused.
    const bad = await request(app)
      .put("/v1/admin/campaign-rate-cards")
      .set("Authorization", `Bearer ${admin}`)
      .send({ cards: [{ targetType: "social_account", targetId: snapId, format: "carousel", pricePaise: 1 }] });
    expect(bad.status).toBe(400);

    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tok}`);
    expect(cat.status).toBe(200);
    const snap = cat.body.data.find((e: any) => e.platform === "snapchat");
    const yt = cat.body.data.find((e: any) => e.platform === "youtube");
    expect(snap).toMatchObject({ name: "Bollywood Paps", username: "bollywoodpaps", followers: 396_100, profileUrl: "https://www.snapchat.com/@bollywoodpaps", offers: [{ format: "reel", pricePaise: 100_000 }] });
    expect(yt).toMatchObject({ name: "Inde News", followers: 10_500_000, profileUrl: "https://www.youtube.com/channel/UCuUfbik" });
  });

  async function reelBooking() {
    expect((await setRates()).status).toBe(200);
    const created = await request(app)
      .post("/v1/client/campaigns")
      .set("Authorization", `Bearer ${tok}`)
      .send({ name: "Launch", brand: "Brand S", launchFrom: todayIST(), launchTo: todayIST() });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const init = await request(app).post("/v1/client/campaign-uploads").set("Authorization", `Bearer ${tok}`).send({ filename: "v.mp4", size: MP4.length, mime: "video/mp4" });
    const up = init.body.data.id;
    for (let n = 0; n < init.body.data.totalChunks; n++) {
      await request(app)
        .put(`/v1/client/campaign-uploads/${up}/chunks/${n}`)
        .set("Authorization", `Bearer ${tok}`)
        .set("Content-Type", "application/octet-stream")
        .send(MP4.subarray(n * CAMPAIGN_UPLOAD_CHUNK_BYTES, (n + 1) * CAMPAIGN_UPLOAD_CHUNK_BYTES));
    }
    expect((await request(app).post(`/v1/client/campaign-uploads/${up}/complete`).set("Authorization", `Bearer ${tok}`)).status).toBe(200);
    const cr = await request(app).put(`/v1/client/campaigns/${id}/creative`).set("Authorization", `Bearer ${tok}`).send({ format: "reel", mediaIds: [up], caption: "New drop" });
    expect(cr.status).toBe(200);
    await renderNext({ ignoreLoad: true });
    const cat = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${tok}`);
    const snapCard = cat.body.data.find((e: any) => e.platform === "snapchat").offers[0].rateCardId;
    const ytCard = cat.body.data.find((e: any) => e.platform === "youtube").offers[0].rateCardId;
    return { id, mediaId: up, snapCard, ytCard };
  }

  it("refuses Snapchat accounts for a video over 60 seconds, and allows the others", async () => {
    videoMs = 75_000;
    const b = await reelBooking();
    const snap = await request(app).put(`/v1/client/campaigns/${b.id}/items`).set("Authorization", `Bearer ${tok}`).send({ rateCardIds: [b.snapCard, b.ytCard] });
    expect(snap.status).toBe(400);
    expect(snap.body.error.code).toBe("VIDEO_TOO_LONG_FOR_PLATFORM");
    expect(snap.body.error.message).toMatch(/Snapchat takes videos up to 60 seconds and yours is 75 seconds/);
    const yt = await request(app).put(`/v1/client/campaigns/${b.id}/items`).set("Authorization", `Bearer ${tok}`).send({ rateCardIds: [b.ytCard] });
    expect(yt.status).toBe(200);
  });

  it("re-checks the length at submit, after the accounts were picked", async () => {
    const b = await reelBooking();
    const ok = await request(app).put(`/v1/client/campaigns/${b.id}/items`).set("Authorization", `Bearer ${tok}`).send({ rateCardIds: [b.snapCard] });
    expect(ok.status).toBe(200);
    await prisma.campaignMedia.update({ where: { id: b.mediaId }, data: { durationMs: 61_000 } });
    const co = await request(app).post(`/v1/client/campaigns/${b.id}/checkout`).set("Authorization", `Bearer ${tok}`);
    expect(co.status).toBe(400);
    expect(co.body.error.code).toBe("VIDEO_TOO_LONG_FOR_PLATFORM");
    await prisma.campaignMedia.update({ where: { id: b.mediaId }, data: { durationMs: 59_000 } });
    expect((await request(app).post(`/v1/client/campaigns/${b.id}/checkout`).set("Authorization", `Bearer ${tok}`)).status).toBe(200);
  });
});
