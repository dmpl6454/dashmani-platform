// Where a notification goes when tapped, and how it is drawn.
// NotificationType (packages/db/prisma/schema.prisma): REPORT_REMINDER, REPORT_SUBMITTED,
// REPORT_MISSED, GROWTH_MILESTONE, ACCOUNT_ASSIGNED, LEAVE_REQUEST, LEAVE_APPROVED,
// LEAVE_REJECTED, SALARY_SLIP, DOCUMENT_UPLOADED, PROFILE_PICTURE, PERFORMANCE_REVIEW,
// BUG_REPORT_UPDATE, INCENTIVE_AWARDED, EXTRA_HOURS_APPROVED, GENERAL, ANNOUNCEMENT,
// TASK_ASSIGNED, PIPELINE. ANNOUNCEMENT / GENERAL (without a known id) expand inline (null).
import type { IoniconName } from "@/components/ui";
import type { TintKey } from "@/lib/theme";

export type NotificationLike = {
  type?: string | null;
  metadata?: Record<string, unknown> | null;
};

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!meta || typeof meta !== "object") return null;
  const v = meta[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** In-app route for a notification, or null when it has no destination (expand inline). */
export function routeForNotification(n: NotificationLike): string | null {
  if (!n) return null;
  const type = (n.type || "").toUpperCase();
  const meta = n.metadata ?? null;

  // Pipeline rows carry metadata.path ("/pipeline/<id>", the path the HR web bell opens).
  const path = meta ? meta.path : undefined;
  if (typeof path === "string") {
    const m = /^\/pipeline(?:\/([0-9a-f-]{36}))?\/?$/i.exec(path);
    if (m) return m[1] ? `/pipeline/${m[1]}` : "/pipeline";
  }
  if (type === "PIPELINE") return "/pipeline";

  const taskId = metaString(meta, "taskId");
  if (taskId) return `/task/${encodeURIComponent(taskId)}`;
  if (type.startsWith("TASK")) return "/(tabs)/tasks";

  if (type.startsWith("LEAVE") || metaString(meta, "leaveRequestId")) return "/(tabs)/leave";
  if (type.startsWith("SALARY")) return "/salary-slips";
  if (type.startsWith("REPORT_") || type === "ACCOUNT_ASSIGNED") return "/(tabs)/report";
  if (metaString(meta, "incentiveId") || type.startsWith("INCENTIVE")) return "/incentives";
  if (metaString(meta, "reviewId") || type === "PERFORMANCE_REVIEW") return "/reviews";
  if (metaString(meta, "bugId") || type.startsWith("BUG")) return "/bug-report";
  if (metaString(meta, "documentId") || type.startsWith("DOCUMENT")) return "/documents";
  if (metaString(meta, "extraHourId") || type.startsWith("EXTRA_HOURS")) return "/extra-hours";
  if (metaString(meta, "expenseId")) return "/expenses";
  if (metaString(meta, "complaintId")) return "/complaints";
  if (type === "PROFILE_PICTURE") return "/profile";

  // GROWTH_MILESTONE, GENERAL, ANNOUNCEMENT and anything unknown: no destination.
  return null;
}

/** Icon + tile tint for a notification type. */
export function notificationGlyph(type: string | null | undefined): { icon: IoniconName; tint: TintKey } {
  const t = (type || "").toUpperCase();
  switch (t) {
    case "REPORT_REMINDER":
      return { icon: "time", tint: "orange" };
    case "REPORT_SUBMITTED":
      return { icon: "checkmark-circle", tint: "green" };
    case "REPORT_MISSED":
      return { icon: "alert-circle", tint: "red" };
    case "GROWTH_MILESTONE":
      return { icon: "trending-up", tint: "green" };
    case "ACCOUNT_ASSIGNED":
      return { icon: "person-circle", tint: "blue" };
    case "LEAVE_REQUEST":
      return { icon: "airplane", tint: "teal" };
    case "LEAVE_APPROVED":
      return { icon: "airplane", tint: "green" };
    case "LEAVE_REJECTED":
      return { icon: "airplane", tint: "red" };
    case "SALARY_SLIP":
      return { icon: "wallet", tint: "green" };
    case "DOCUMENT_UPLOADED":
      return { icon: "document-text", tint: "blue" };
    case "PROFILE_PICTURE":
      return { icon: "person-circle", tint: "indigo" };
    case "PERFORMANCE_REVIEW":
      return { icon: "star", tint: "yellow" };
    case "BUG_REPORT_UPDATE":
      return { icon: "bug", tint: "red" };
    case "INCENTIVE_AWARDED":
      return { icon: "trophy", tint: "orange" };
    case "EXTRA_HOURS_APPROVED":
      return { icon: "time", tint: "teal" };
    case "ANNOUNCEMENT":
      return { icon: "megaphone", tint: "brand" };
    case "TASK_ASSIGNED":
      return { icon: "checkbox", tint: "blue" };
    case "PIPELINE":
      return { icon: "git-branch", tint: "indigo" };
    case "GENERAL":
    default:
      return { icon: "notifications", tint: "gray" };
  }
}
