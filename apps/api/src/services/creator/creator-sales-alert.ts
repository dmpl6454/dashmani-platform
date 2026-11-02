import { prisma } from "@dashmani/db";
import { sendEmail } from "../email.service";
import { esc } from "./creator-email";

// "A creator is waiting for review" for the sales team: everyone active who holds `sales:view`
// (the Sales role, and Admin / Super Admin, who carry the sales grants) gets a bell notification
// and one email linking to the creator in the sales portal (sales.digitalsukoon.com/creators).
// Written straight to `notifications` (type GENERAL) rather than through dispatchNotification,
// whose GENERAL audience is admins + HR — the people who approve creators are the sales team.
// Fire-and-forget: a failure here never affects the creator's submit.

const salesUrl = () => (process.env.SALES_APP_URL || "http://localhost:3006").replace(/\/+$/, "");

/** Active internal users whose roles grant sales:view. */
export async function salesTeam(): Promise<Array<{ id: string; email: string; name: string }>> {
  return prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      roles: { some: { role: { permissions: { some: { resource: "sales", action: "view" } } } } },
    },
    select: { id: true, email: true, name: true },
    orderBy: { email: "asc" },
  });
}

export async function notifySalesTeamCreatorSubmitted(creator: {
  id: string;
  name: string;
  email: string;
  publishable: number;
  resubmitted: boolean;
}): Promise<{ notified: number; emailed: boolean }> {
  const team = await salesTeam();
  if (team.length === 0) return { notified: 0, emailed: false };
  const url = `${salesUrl()}/creators/view?id=${creator.id}`;
  const pages = `${creator.publishable} page${creator.publishable === 1 ? "" : "s"}`;
  const title = creator.resubmitted ? "Creator resubmitted for review" : "Creator submitted for review";
  const message = `${creator.name} (${creator.email}) sent their creator profile with ${pages} for review. Open it in the sales portal → Creators to approve or reject it.`;

  await prisma.notification.createMany({
    data: team.map((u) => ({ userId: u.id, type: "GENERAL" as const, title, message, metadata: { kind: "creator_review", creatorId: creator.id, url } })),
  });

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f6;font-family:'Segoe UI',Arial,sans-serif;color:#111">
<div style="max-width:620px;margin:0 auto;background:#fff">
<div style="background:#000;color:#fff;padding:20px 28px"><div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">Digital Sukoon Sales</div><h1 style="margin:6px 0 0;font-size:19px;font-weight:700">${esc(title)}</h1></div>
<div style="padding:24px 28px;font-size:14px;line-height:1.6">
<p style="margin:0 0 12px"><strong>${esc(creator.name)}</strong> (${esc(creator.email)}) sent their creator profile with ${esc(pages)} for review.</p>
<p style="margin:0 0 20px">Check their pages, switch on the ones we can book, and approve or reject the profile.</p>
<a href="${esc(url)}" style="display:inline-block;background:#403cfa;color:#fff;text-decoration:none;padding:11px 20px;font-weight:700">Review in the sales portal</a>
</div>
<div style="padding:16px 28px;font-size:12px;color:#777;border-top:1px solid #eee">You get this because your account has access to the sales portal.</div>
</div></body></html>`;
  const sent = await sendEmail({ to: team.map((u) => u.email).join(", "), subject: `[Sales] ${title}: ${creator.name}`, html, fromName: "Digital Sukoon Sales" });
  return { notified: team.length, emailed: sent != null };
}
