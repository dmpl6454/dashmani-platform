/**
 * Phase 3 — YouTube auto-upload. Google (OAuth token endpoint, channels.list, the resumable
 * upload endpoints, revoke) is a fake behind a stubbed global fetch; Postgres, the item state
 * machine and the rendered file on disk are real. What is locked here:
 *  • eligibility: its own switch, one video, a connected channel; the daily cap waits, never hands over;
 *  • the resumable session is saved before any byte is sent and reused — insert is never called twice;
 *  • a finished upload publishes a Shorts link; a video YouTube forced to private goes to staff
 *    and is never uploaded again;
 *  • invalid_grant marks the connection needs_reauth and hands the item to staff;
 *  • an expired session (404) is replaced by a fresh one;
 *  • the OAuth callback stores the channel and rejects a forged state; the routes are admin-only.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { encryptToken } from "../src/utils/token-crypto";
import { checkEligibility, publishItem, runPublishTick } from "../src/services/campaign/publish.service";
import { buildAuthUrl, __clearYoutubeTokenCacheForTests } from "../src/services/campaign/youtube.service";
import { YT_CHUNK_BYTES, youtubeTitle, youtubeDescription } from "../src/services/campaign/youtube-publish";
import { createTestRole, generateToken } from "./helpers";

const CHANNEL = "UCabcdefghijklmnopqrstuv";
const SESSION = "https://upload.youtube.test/session/abc";
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yt-pub-"));

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyLength: number;
  form: URLSearchParams;
}
let calls: Call[] = [];
let fileSize = 0;
let received = 0;
let tokenResponse: () => Response;
let finalVideo: Record<string, unknown>;
let sessionGone = false;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
const range = () => (received > 0 ? { range: `bytes=0-${received - 1}` } : {});

function installGoogle() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const body = init?.body;
      const bodyLength = body instanceof Uint8Array ? body.length : typeof body === "string" ? body.length : 0;
      const c: Call = { method: (init?.method ?? "GET").toUpperCase(), url, headers, bodyLength, form: new URLSearchParams(typeof body === "string" ? body : "") };
      calls.push(c);
      if (url === "https://oauth2.googleapis.com/token") {
        if (c.form.get("grant_type") === "authorization_code") {
          return json({ access_token: "AT-CODE", refresh_token: "RT-NEW", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly" });
        }
        return tokenResponse();
      }
      if (url === "https://oauth2.googleapis.com/revoke") return json({});
      if (url.startsWith("https://www.googleapis.com/youtube/v3/channels")) return json({ items: [{ id: CHANNEL, snippet: { title: "Filmy Channel" } }] });
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) return new Response(null, { status: 200, headers: { location: SESSION } });
      if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/thumbnails/set")) return json({});
      if (url === SESSION) {
        if (sessionGone) return json({ error: { message: "gone" } }, 404);
        if (headers["content-range"]?.startsWith("bytes */")) {
          return received >= fileSize ? json(finalVideo) : new Response(null, { status: 308, headers: range() });
        }
        received += bodyLength;
        return received >= fileSize ? json(finalVideo) : new Response(null, { status: 308, headers: range() });
      }
      return json({ error: { message: `unexpected ${c.method} ${url}` } }, 500);
    }),
  );
}
const inits = () => calls.filter((c) => c.url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")).length;

// ── Fixtures ───────────────────────────────────────────────────────────────────

let admin: string;
let clientId: string;
let ytAccountId: string;
let connectionId: string;
let keySeq = 0;

async function seed() {
  const role = await createTestRole("Admin", [{ resource: "reports", action: "manage", scope: "global" }]);
  const staff = await prisma.user.create({ data: { name: "Staff", email: "staff-yt@ds.test", passwordHash: "x", status: "ACTIVE" } });
  await prisma.userRole.create({ data: { userId: staff.id, roleId: role.id } });
  admin = generateToken(staff.id, staff.email, ["Admin"]);
  const client = await prisma.client.create({ data: { companyName: "Brand Y", contactName: "Yas", email: "y@brand.test", passwordHash: "x" } });
  clientId = client.id;
  const platform = await prisma.platform.create({ data: { name: "YouTube", slug: "youtube" } });
  const acct = await prisma.socialAccount.create({
    data: { handle: "filmy", displayName: "Filmy Channel", platformId: platform.id, profileUrl: `https://www.youtube.com/channel/${CHANNEL}` },
  });
  ytAccountId = acct.id;
  const conn = await prisma.youtubeConnection.create({
    data: { channelId: CHANNEL, channelTitle: "Filmy Channel", refreshTokenEnc: encryptToken("RT-1"), grantedScopes: "youtube.upload", connectedById: staff.id },
  });
  connectionId = conn.id;
}

async function booking(opts: { format?: string; kinds?: Array<"video" | "image">; status?: string; itemStatus?: string; containerId?: string | null; caption?: string; audio?: boolean } = {}) {
  const format = opts.format ?? "reel";
  const b = await prisma.campaignBooking.create({
    data: {
      clientId, name: "Diwali drop", brand: "Brand Y", status: opts.status ?? "approved", format,
      caption: opts.caption ?? "Glow up this Diwali #diwali", hashtags: ["sale"], audioIntegration: opts.audio ?? false,
      launchFrom: new Date("2026-01-01T00:00:00Z"), launchTo: new Date("2026-01-01T00:00:00Z"), totalPaise: 100_000,
    },
  });
  for (const [position, kind] of (opts.kinds ?? ["video"]).entries()) {
    keySeq++;
    const renderKey = `ytrender${keySeq}`;
    fs.writeFileSync(path.join(MEDIA_DIR, "render", `${renderKey}.${kind === "video" ? "mp4" : "jpg"}`), Buffer.alloc(fileSize, 7));
    await prisma.campaignMedia.create({
      data: {
        clientId, bookingId: b.id, position, kind, role: "creative", originalName: `f${position}`, bytes: BigInt(fileSize), storageKey: `ytkey${keySeq}`,
        ext: kind === "video" ? "mp4" : "jpg", uploadStatus: "complete", chunkSize: 1, totalChunks: 1, renderStatus: "done", renderKey,
      },
    });
  }
  const item = await prisma.campaignBookingItem.create({
    data: {
      bookingId: b.id, rateCardId: "00000000-0000-0000-0000-000000000000", targetType: "social_account", targetId: ytAccountId,
      platform: "youtube", format, accountName: "Filmy Channel", pricePaise: 100_000, status: opts.itemStatus ?? "queued", containerId: opts.containerId ?? null,
    },
  });
  return { id: b.id, itemId: item.id };
}

describe("campaign YouTube auto-upload", () => {
  beforeEach(async () => {
    process.env.CAMPAIGN_YOUTUBE_PUBLISH_ENABLED = "1";
    process.env.CAMPAIGN_PUBLISH_ENABLED = "0";
    process.env.YOUTUBE_OAUTH_CLIENT_ID = "yt-client";
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET = "yt-secret";
    process.env.CAMPAIGN_MEDIA_DIR = MEDIA_DIR;
    fs.mkdirSync(path.join(MEDIA_DIR, "render"), { recursive: true });
    calls = [];
    fileSize = 1000;
    received = 0;
    sessionGone = false;
    finalVideo = { id: "VID1", status: { privacyStatus: "public", uploadStatus: "uploaded" } };
    tokenResponse = () => json({ access_token: "AT-1", expires_in: 3600 });
    __clearYoutubeTokenCacheForTests();
    installGoogle();
    await seed();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => {
    for (const k of ["CAMPAIGN_YOUTUBE_PUBLISH_ENABLED", "CAMPAIGN_PUBLISH_ENABLED", "YOUTUBE_OAUTH_CLIENT_ID", "YOUTUBE_OAUTH_CLIENT_SECRET", "CAMPAIGN_MEDIA_DIR", "CAMPAIGN_YOUTUBE_DAILY_UPLOADS", "CAMPAIGN_YOUTUBE_PRIVACY"]) delete process.env[k];
    fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("titles from the caption's first line without hashtags, and tags Shorts", () => {
      expect(youtubeTitle("Glow up this Diwali #diwali\nmore", "X")).toBe("Glow up this Diwali");
      expect(youtubeTitle("#only #tags", "Diwali drop")).toBe("Diwali drop");
      expect(youtubeTitle("a".repeat(150), "X")).toHaveLength(100);
      expect(youtubeDescription("Hi <b>", "reel")).toBe("Hi b\n\n#Shorts");
      expect(youtubeDescription("Hi #shorts", "reel")).toBe("Hi #shorts");
      expect(youtubeDescription("Hi", "post")).toBe("Hi");
    });
  });

  describe("eligibility", () => {
    const like = (format = "reel") => ({ targetType: "social_account", targetId: ytAccountId, platform: "youtube", format });
    it("needs its own switch, one video and a connected channel", async () => {
      const video = { audioIntegration: false, media: [{ kind: "video", role: "creative" }] };
      expect((await checkEligibility(like(), video)).ok).toBe(true);
      expect((await checkEligibility(like("carousel"), video)).ok).toBe(false);
      expect((await checkEligibility(like(), { audioIntegration: false, media: [{ kind: "image", role: "creative" }] })).ok).toBe(false);
      expect((await checkEligibility(like(), { audioIntegration: true, media: video.media })).ok).toBe(false);
      expect((await checkEligibility({ ...like(), remotePostId: "VID0" }, video)).ok).toBe(false);

      process.env.CAMPAIGN_YOUTUBE_PUBLISH_ENABLED = "0";
      process.env.CAMPAIGN_PUBLISH_ENABLED = "1"; // the Meta switch does not turn YouTube on
      const off = await checkEligibility(like(), video);
      expect(off).toEqual({ ok: false, reason: "YouTube auto-upload is switched off." });

      process.env.CAMPAIGN_YOUTUBE_PUBLISH_ENABLED = "1";
      await prisma.youtubeConnection.update({ where: { id: connectionId }, data: { status: "revoked", revokedAt: new Date() } });
      const none = await checkEligibility(like(), video);
      expect(none.ok).toBe(false);
      expect(none.ok ? "" : none.reason).toContain("isn't connected");
    });

    it("the daily cap makes an item wait without spending an attempt or calling Google", async () => {
      process.env.CAMPAIGN_YOUTUBE_DAILY_UPLOADS = "1";
      const first = await booking();
      await prisma.campaignBookingItem.update({ where: { id: first.itemId }, data: { remotePostId: "VID0", postedAt: new Date(), status: "published" } });
      const b = await booking();
      expect((await publishItem(b.itemId))?.kind).toBe("wait");
      expect(inits()).toBe(0);
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } });
      expect(item).toMatchObject({ status: "queued", attempts: 0, containerId: null });
      expect(item.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
      delete process.env.CAMPAIGN_YOUTUBE_DAILY_UPLOADS;
    });
  });

  describe("resumable upload", () => {
    it("saves the session first, sends chunks across steps, never re-inits, and publishes a Shorts link", async () => {
      fileSize = YT_CHUNK_BYTES + 1000; // two chunks
      const b = await booking({ format: "reel" });
      expect((await publishItem(b.itemId))?.kind).toBe("wait"); // session opened
      let item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } });
      expect(item.containerId).toBe(`yt:${SESSION}`);
      expect(received).toBe(0);
      const init = calls.find((c) => c.url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos"))!;
      expect(init.headers["x-upload-content-length"]).toBe(String(fileSize));
      expect(init.headers.authorization).toBe("Bearer AT-1");

      expect((await publishItem(b.itemId))?.kind).toBe("wait"); // chunk 1
      expect(received).toBe(YT_CHUNK_BYTES);
      expect((await publishItem(b.itemId))?.kind).toBe("published"); // chunk 2 → done
      expect(inits()).toBe(1);
      item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } });
      expect(item).toMatchObject({ status: "published", remotePostId: "VID1", permalink: "https://www.youtube.com/shorts/VID1" });
      const last = calls.filter((c) => c.url === SESSION && c.bodyLength > 0).pop()!;
      expect(last.headers["content-range"]).toBe(`bytes ${YT_CHUNK_BYTES}-${fileSize - 1}/${fileSize}`);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("completed");
    });

    it("a lost answer to the last chunk is recovered from the session, not re-uploaded", async () => {
      const b = await booking({ format: "post", containerId: `yt:${SESSION}` });
      received = fileSize; // YouTube already has every byte
      expect((await publishItem(b.itemId))?.kind).toBe("published");
      expect(inits()).toBe(0);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } })).permalink).toBe("https://youtu.be/VID1");
    });

    it("an expired session is replaced by a fresh one", async () => {
      sessionGone = true;
      const b = await booking({ containerId: `yt:${SESSION}` });
      expect((await publishItem(b.itemId))?.kind).toBe("retry");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } })).containerId).toBeNull();
      sessionGone = false;
      await prisma.campaignBookingItem.update({ where: { id: b.itemId }, data: { nextAttemptAt: null } });
      expect((await publishItem(b.itemId))?.kind).toBe("wait");
      expect(inits()).toBe(1);
    });

    it("a video YouTube forced to private goes to staff with its link and is never uploaded again", async () => {
      finalVideo = { id: "VIDP", status: { privacyStatus: "private", uploadStatus: "uploaded" } };
      const b = await booking({ containerId: `yt:${SESSION}` });
      received = fileSize;
      expect((await publishItem(b.itemId))?.kind).toBe("manual");
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } });
      expect(item.status).toBe("manual_pending");
      expect(item.remotePostId).toBe("VIDP");
      expect(item.lastError).toContain("API audit");
      expect(item.lastError).toContain("https://www.youtube.com/shorts/VIDP");
      const res = await request(app).post(`/v1/admin/campaigns/${b.id}/items/${b.itemId}/publish-now`).set("Authorization", `Bearer ${admin}`);
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain("Already uploaded");
    });

    it("invalid_grant marks the connection needs_reauth and hands the item to staff", async () => {
      tokenResponse = () => json({ error: "invalid_grant" }, 400);
      const b = await booking();
      expect((await publishItem(b.itemId))?.kind).toBe("manual");
      expect((await prisma.youtubeConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe("needs_reauth");
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } });
      expect(item.status).toBe("manual_pending");
      expect(item.lastError).toContain("reconnect");
      expect(inits()).toBe(0);
    });

    it("the tick runs on the YouTube switch alone and leaves Meta items alone", async () => {
      const b = await booking();
      expect(await runPublishTick()).toBe(1);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.itemId } })).containerId).toBe(`yt:${SESSION}`);
      process.env.CAMPAIGN_YOUTUBE_PUBLISH_ENABLED = "0";
      calls = [];
      expect(await runPublishTick()).toBe(0);
      expect(calls).toHaveLength(0);
    });
  });

  describe("connect + routes", () => {
    it("the callback stores the channel for the staff member who started it", async () => {
      await prisma.youtubeConnection.deleteMany({});
      const url = new URL(buildAuthUrl("staff-123"));
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("scope")).toContain("youtube.upload");
      const res = await request(app).get(`/v1/youtube/oauth/callback?code=CODE1&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("/campaigns/youtube?connected=Filmy+Channel");
      const row = await prisma.youtubeConnection.findUniqueOrThrow({ where: { channelId: CHANNEL } });
      expect(row).toMatchObject({ channelTitle: "Filmy Channel", status: "active", connectedById: "staff-123" });
      expect(row.refreshTokenEnc).not.toContain("RT-NEW");
    });

    it("rejects a forged or expired state without calling Google", async () => {
      const forged = jwt.sign({ staffId: "x" }, "wrong-secret", { audience: "yt-oauth" });
      const r1 = await request(app).get(`/v1/youtube/oauth/callback?code=C&state=${forged}`);
      expect(r1.headers.location).toContain("error=expired");
      const expired = jwt.sign({ staffId: "x", exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET || "dev-secret", { audience: "yt-oauth" });
      const r2 = await request(app).get(`/v1/youtube/oauth/callback?code=C&state=${expired}`);
      expect(r2.headers.location).toContain("error=expired");
      expect(calls.filter((c) => c.url === "https://oauth2.googleapis.com/token")).toHaveLength(0);
    });

    it("lists connections without tokens and is admin-only", async () => {
      const ok = await request(app).get("/v1/admin/youtube/connections").set("Authorization", `Bearer ${admin}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data.connections[0]).toMatchObject({ channelId: CHANNEL, account: { id: ytAccountId, onRateCard: false } });
      expect(JSON.stringify(ok.body)).not.toContain("refresh");
      const employee = await prisma.user.create({ data: { name: "E", email: "e-yt@ds.test", passwordHash: "x", status: "ACTIVE" } });
      const no = await request(app).get("/v1/admin/youtube/connections").set("Authorization", `Bearer ${generateToken(employee.id, employee.email, [])}`);
      expect(no.status).toBe(403);
      const del = await request(app).delete(`/v1/admin/youtube/connections/${connectionId}`).set("Authorization", `Bearer ${admin}`);
      expect(del.status).toBe(200);
      expect((await prisma.youtubeConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe("revoked");
      expect(calls.some((c) => c.url === "https://oauth2.googleapis.com/revoke")).toBe(true);
    });
  });
});
