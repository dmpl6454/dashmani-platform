import { prisma } from "@dashmani/db";
import { salesTeam } from "../creator/creator-sales-alert";

// Bell rows for campaign problems someone on staff must act on (G45): a creator declined or
// never answered, a creator page was unavailable at approval, a posting window passed with
// posts open. Before this they reached only the admin@ inbox email.
//
// Recipients: every ACTIVE user whose roles grant `sales:view` — the Sales role plus Admin /
// Super Admin, who carry the sales grants — i.e. the people who can review and refund bookings.
// The row links to the booking in the sales portal (/bookings/view?id=), which every recipient
// can open; `salesNotificationUrl` in packages/shared allowlists that path.
// Written straight to `notifications` (type GENERAL), like the creator-review alert, because
// dispatchNotification's GENERAL audience is admins + HR. Never throws.

const salesUrl = () => (process.env.SALES_APP_URL || "http://localhost:3006").replace(/\/+$/, "");

export async function notifyStaffBell(bookingId: string, title: string, message: string): Promise<number> {
  try {
    const team = await salesTeam();
    if (team.length === 0) return 0;
    const url = `${salesUrl()}/bookings/view?id=${bookingId}`;
    await prisma.notification.createMany({
      data: team.map((u) => ({
        userId: u.id,
        type: "GENERAL" as const,
        title: title.slice(0, 200),
        message: message.slice(0, 2000),
        metadata: { kind: "campaign_alert", bookingId, url },
      })),
    });
    return team.length;
  } catch (e) {
    console.warn("[campaign] staff bell failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}
