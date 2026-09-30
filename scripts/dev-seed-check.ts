/**
 * Supplemental LOCAL dev seed — fills the pages the main seed leaves empty
 * (Projects, Content, Expense Claims) so the redesign can be reviewed with
 * every page populated. Idempotent: skips a section that already has rows.
 * Refuses to run against anything but a localhost database.
 *
 *   cd packages/db && npx tsx ../../scripts/dev-seed-check.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function assertLocal() {
  const url = process.env.DATABASE_URL || "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error(`Refusing to run: DATABASE_URL is not localhost (${url.replace(/:[^:@/]*@/, ":***@")})`);
  }
}

const pick = <T,>(arr: T[], i: number) => arr[i % arr.length];
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);
const daysAhead = (n: number) => new Date(Date.now() + n * 864e5);

async function main() {
  assertLocal();

  const clients = await prisma.client.findMany({ take: 10 });
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    take: 20,
  });
  const accounts = await prisma.socialAccount.findMany({ take: 20 });

  if (clients.length === 0 || users.length === 0) {
    throw new Error("Need at least one client and one active user — run the base seed first.");
  }

  /* ── Projects ── */
  let projects = await prisma.project.findMany();
  if (projects.length === 0) {
    const seed = [
      { name: "Festive Campaign — Q4", status: "ACTIVE",    healthScore: 86, startDate: daysAgo(40), endDate: daysAhead(50) },
      { name: "Brand Refresh 2026",    status: "ACTIVE",    healthScore: 72, startDate: daysAgo(20), endDate: daysAhead(80) },
      { name: "Always-On Social",      status: "PAUSED",    healthScore: 54, startDate: daysAgo(120), endDate: null },
      { name: "Product Launch Sprint", status: "COMPLETED", healthScore: 94, startDate: daysAgo(200), endDate: daysAgo(15) },
      { name: "Influencer Collab Wave",status: "ACTIVE",    healthScore: 63, startDate: daysAgo(8),  endDate: daysAhead(60) },
    ] as const;
    await prisma.$transaction(
      seed.map((p, i) =>
        prisma.project.create({
          data: {
            name: p.name,
            description: `${p.name} — managed workstream for ${pick(clients, i).name ?? "the client"}.`,
            clientId: pick(clients, i).id,
            status: p.status as any,
            healthScore: p.healthScore,
            startDate: p.startDate ?? undefined,
            endDate: p.endDate ?? undefined,
          },
        })
      )
    );
    projects = await prisma.project.findMany();
    console.log(`Seeded ${projects.length} projects`);
  } else {
    console.log(`Projects already present (${projects.length}) — skipped`);
  }

  /* ── Content posts ── */
  const contentCount = await prisma.contentPost.count();
  if (contentCount === 0 && projects.length > 0) {
    const statuses = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED", "REJECTED"] as const;
    const formats = ["Reel", "Carousel", "Static Post", "Story"];
    const titles = [
      "Diwali teaser — behind the scenes", "5 tips carousel", "Founder reel: our story",
      "New collection drop", "Customer spotlight", "Weekend giveaway",
      "How-to: styling guide", "Trend recap of the week", "Product close-up",
      "Team introduction", "Poll: which do you prefer?", "Festive countdown",
    ];
    const rows = titles.map((title, i) => {
      const status = pick(statuses, i);
      return {
        title,
        caption: `${title} — ${pick(formats, i)} crafted for maximum reach. #DigitalSukoon #content`,
        mediaUrls: [],
        projectId: pick(projects, i).id,
        accountId: accounts.length ? pick(accounts, i).id : null,
        status: status as any,
        format: pick(formats, i),
        aspectRatio: i % 2 ? "9:16" : "1:1",
        hashtags: ["DigitalSukoon", "socialmedia", pick(formats, i).toLowerCase()],
        scheduledAt: status === "SCHEDULED" ? daysAhead((i % 6) + 1) : null,
        publishedAt: status === "PUBLISHED" ? daysAgo((i % 10) + 1) : null,
        createdById: pick(users, i).id,
      };
    });
    await prisma.$transaction(rows.map((r) => prisma.contentPost.create({ data: r })));
    console.log(`Seeded ${rows.length} content posts`);
  } else {
    console.log(`Content posts already present (${contentCount}) — skipped`);
  }

  /* ── Expense claims ── */
  const expenseCount = await prisma.expenseClaim.count();
  if (expenseCount === 0) {
    const cats = ["TRAVEL", "MEALS", "SOFTWARE", "EQUIPMENT", "OTHER"];
    const states = ["PENDING", "APPROVED", "REJECTED"] as const;
    const reviewer = users[0];
    const rows = [
      { title: "Client meeting cab fare",       amount: 640,  category: "TRAVEL" },
      { title: "Team lunch — campaign wrap",     amount: 2450, category: "MEALS" },
      { title: "Canva Pro annual",               amount: 3999, category: "SOFTWARE" },
      { title: "Ring light + tripod",            amount: 1899, category: "EQUIPMENT" },
      { title: "Domain renewal",                 amount: 1200, category: "SOFTWARE" },
      { title: "Shoot location travel",          amount: 3100, category: "TRAVEL" },
      { title: "Coffee with prospect",           amount: 420,  category: "MEALS" },
    ];
    await prisma.$transaction(
      rows.map((r, i) => {
        const status = pick(states, i);
        const reviewed = status !== "PENDING";
        return prisma.expenseClaim.create({
          data: {
            employeeId: pick(users, i + 1).id,
            title: r.title,
            amount: r.amount,
            category: r.category,
            description: `${r.title} — submitted for reimbursement.`,
            status: status as any,
            reviewedBy: reviewed ? reviewer.id : null,
            reviewedAt: reviewed ? daysAgo(i) : null,
            reviewNotes: status === "REJECTED" ? "Missing receipt — please resubmit." : reviewed ? "Approved." : null,
            createdAt: daysAgo(i + 2),
          },
        });
      })
    );
    console.log(`Seeded ${rows.length} expense claims`);
  } else {
    console.log(`Expense claims already present (${expenseCount}) — skipped`);
  }

  console.log("Supplemental dev seed complete.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
