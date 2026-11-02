import { prisma } from "@dashmani/db";
import { AppError } from "../../middleware/error-handler";
import { signedMediaPath } from "./media-url";
import { resolveItemFiles } from "./booking.service";

const TTL_SEC = 4 * 3600;

/**
 * Signed links to preview a booking's creative and download the files to post. `media` is the
 * booking's files with the DEFAULT overlay; `items` carries, per account, the exact files to post
 * there (its own render when that account customised its overlay). Served to the staff portal
 * (/admin/campaigns/:id/media-urls) and the sales portal (/sales/bookings/:id/media-urls).
 */
export async function bookingMediaUrls(bookingId: string) {
  const media = await prisma.campaignMedia.findMany({
    where: { bookingId, purgedAt: null, uploadStatus: "complete" },
    orderBy: [{ role: "asc" }, { position: "asc" }],
    select: { id: true, kind: true, role: true, renderStatus: true },
  });
  if (!media.length) {
    const exists = await prisma.campaignBooking.count({ where: { id: bookingId } });
    if (!exists) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  }
  const files = await resolveItemFiles(bookingId);
  return {
    media: media.map((m) => ({
      id: m.id,
      kind: m.kind,
      role: m.role,
      renderStatus: m.renderStatus,
      preview: signedMediaPath(m.id, "preview", TTL_SEC),
      original: signedMediaPath(m.id, "original", TTL_SEC),
    })),
    items: [...files.entries()].map(([itemId, list]) => ({
      itemId,
      custom: list.some((f) => f.custom),
      files: list.map((f) => ({
        mediaId: f.mediaId,
        kind: f.kind,
        role: f.role,
        status: f.status,
        url: f.status === "done" ? signedMediaPath(f.mediaId, f.renderId ? `v-${f.renderId}` : "preview", TTL_SEC) : null,
      })),
    })),
  };
}
