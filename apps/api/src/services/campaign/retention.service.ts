import fsp from "fs/promises";
import path from "path";
import { prisma, Prisma } from "@dashmani/db";
import { notifyAdminByEmail } from "../email.service";
import { campaignConfig, mediaSubdirs } from "./config";
import { purgeMediaFiles, ensureMediaDirs } from "./media.service";
import { transitionBooking } from "./booking.service";

// Housekeeping for campaign media on the server's disk:
//  • unpaid checkouts expire after CAMPAIGN_UNPAID_EXPIRY_HOURS (24h); untouched drafts after 30 days
//  • uploads never attached to a campaign are deleted after 48h; abandoned uploads after 24h
//  • finished campaigns' files are deleted CAMPAIGN_RETENTION_DAYS (14) after they finish
//  • render files no row points at any more are deleted
//  • an admin is emailed when free disk space is low
// Rows are kept (with purged_at set) so the history and the links stay visible.

const HOUR = 3600_000;
const FINISHED = ["completed", "partially_published", "refunded", "rejected", "cancelled", "expired"];

async function purgeRows(where: Prisma.CampaignMediaWhereInput, reason: string) {
  const rows = await prisma.campaignMedia.findMany({ where: { ...where, purgedAt: null }, take: 500 });
  for (const m of rows) {
    await purgeMediaFiles(m);
    await prisma.campaignMedia.update({
      where: { id: m.id },
      data: { purgedAt: new Date(), ...(m.uploadStatus === "uploading" ? { uploadStatus: "rejected", rejectReason: reason } : {}) },
    });
  }
  return rows.length;
}

let lastLowDiskAlert = 0;

export async function runCampaignRetention(now = new Date()) {
  const stats = { expired: 0, orphans: 0, abandoned: 0, finished: 0, strayRenders: 0 };

  const unpaid = await prisma.campaignBooking.findMany({
    where: {
      OR: [
        { status: "awaiting_payment", updatedAt: { lt: new Date(+now - campaignConfig.unpaidExpiryHours() * HOUR) } },
        { status: "draft", updatedAt: { lt: new Date(+now - 30 * 24 * HOUR) } },
      ],
    },
    select: { id: true, status: true },
    take: 500,
  });
  for (const b of unpaid) {
    // A payment can still be in flight for an awaiting_payment booking: only expire it when no
    // payment row is captured (the webhook accepts a late capture from `expired` anyway).
    try {
      await transitionBooking(b.id, [b.status as "draft" | "awaiting_payment"], "expired", { type: "system" }, { note: "Not paid in time" });
      stats.expired++;
    } catch {
      /* moved on concurrently */
    }
  }

  stats.orphans = await purgeRows({ bookingId: null, uploadStatus: "complete", createdAt: { lt: new Date(+now - 48 * HOUR) } }, "unused");
  stats.abandoned = await purgeRows({ uploadStatus: "uploading", createdAt: { lt: new Date(+now - 24 * HOUR) } }, "Upload was not finished");
  stats.finished = await purgeRows(
    {
      booking: { status: { in: FINISHED }, updatedAt: { lt: new Date(+now - campaignConfig.retentionDays() * 24 * HOUR) } },
    },
    "retention",
  );

  // Render files whose key no row references (re-renders after a creative edit).
  await ensureMediaDirs();
  const files = await fsp.readdir(mediaSubdirs.render());
  for (const f of files) {
    const full = path.join(mediaSubdirs.render(), f);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || +now - st.mtimeMs < 6 * HOUR) continue;
    const key = f.replace(/(\.partial)?\.(mp4|jpg)$/, "");
    const used =
      (await prisma.campaignMedia.count({ where: { renderKey: key, purgedAt: null } })) +
      (await prisma.campaignMediaRender.count({ where: { renderKey: key, media: { purgedAt: null } } }));
    if (!used) {
      await fsp.rm(full, { force: true });
      stats.strayRenders++;
    }
  }

  const s = await fsp.statfs(mediaSubdirs.tmp());
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < campaignConfig.minFreeBytes() * 2 && +now - lastLowDiskAlert > 24 * HOUR) {
    lastLowDiskAlert = +now;
    void notifyAdminByEmail("Campaign uploads: server disk is getting full", [
      { label: "Free space", value: `${(free / 1024 ** 3).toFixed(1)} GB` },
      { label: "Uploads pause below", value: `${(campaignConfig.minFreeBytes() / 1024 ** 3).toFixed(1)} GB` },
    ]).catch(() => undefined);
  }
  return stats;
}
