import { PrismaClient } from "@prisma/client";
import { hash } from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const roles = [
    {
      name: "Super Admin",
      description: "Full system access",
      isSystemRole: true,
      permissions: [
        "employees", "teams", "tasks", "accounts", "reports",
        "attendance", "roles", "settings", "clients", "content",
        "messages", "billing", "analytics",
      ].flatMap((resource) =>
        ["view", "create", "edit", "delete", "approve", "export", "manage"].map((action) => ({
          resource, action, scope: "global",
        }))
      ),
    },
    {
      name: "Admin",
      description: "Employee and account management",
      isSystemRole: true,
      permissions: [
        "employees", "teams", "tasks", "accounts", "reports",
        "attendance", "clients", "content", "messages", "analytics",
      ].flatMap((resource) =>
        ["view", "create", "edit", "delete", "approve", "export", "manage"].map((action) => ({
          resource, action, scope: "global",
        }))
      ),
    },
    {
      name: "Team Lead",
      description: "Manage own team",
      isSystemRole: true,
      permissions: [
        { resource: "employees", action: "view", scope: "team" },
        { resource: "teams", action: "view", scope: "team" },
        { resource: "teams", action: "edit", scope: "team" },
        { resource: "tasks", action: "view", scope: "team" },
        { resource: "tasks", action: "create", scope: "team" },
        { resource: "tasks", action: "edit", scope: "team" },
        { resource: "tasks", action: "approve", scope: "team" },
        { resource: "accounts", action: "view", scope: "team" },
        { resource: "reports", action: "view", scope: "team" },
        { resource: "reports", action: "create", scope: "team" },
        { resource: "attendance", action: "view", scope: "team" },
        { resource: "attendance", action: "create", scope: "own" },
      ],
    },
    {
      name: "Senior Employee",
      description: "View assigned accounts and create reports",
      isSystemRole: true,
      permissions: [
        { resource: "employees", action: "view", scope: "own" },
        { resource: "tasks", action: "view", scope: "own" },
        { resource: "tasks", action: "edit", scope: "own" },
        { resource: "accounts", action: "view", scope: "own" },
        { resource: "reports", action: "view", scope: "own" },
        { resource: "reports", action: "create", scope: "own" },
        { resource: "attendance", action: "view", scope: "own" },
        { resource: "attendance", action: "create", scope: "own" },
      ],
    },
    {
      name: "Employee",
      description: "View and manage own work",
      isSystemRole: true,
      permissions: [
        { resource: "employees", action: "view", scope: "own" },
        { resource: "tasks", action: "view", scope: "own" },
        { resource: "tasks", action: "edit", scope: "own" },
        { resource: "accounts", action: "view", scope: "own" },
        { resource: "attendance", action: "view", scope: "own" },
        { resource: "attendance", action: "create", scope: "own" },
      ],
    },
  ];

  for (const roleData of roles) {
    const { permissions, ...role } = roleData;
    const created = await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: role,
    });

    for (const perm of permissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_resource_action_scope: {
            roleId: created.id,
            resource: perm.resource,
            action: perm.action,
            scope: perm.scope,
          },
        },
        update: {},
        create: { roleId: created.id, ...perm },
      });
    }
  }

  const superAdminRole = await prisma.role.findUnique({ where: { name: "Super Admin" } });
  if (superAdminRole) {
    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? (() => { throw new Error("SEED_ADMIN_PASSWORD env var is required for seeding"); })();
    const passwordHash = await hash(adminPassword, 12);
    const admin = await prisma.user.upsert({
      where: { email: "admin@digitalsukoon.com" },
      update: {},
      create: {
        name: "Sudhanshu Kumar",
        email: "admin@digitalsukoon.com",
        passwordHash,
        status: "ACTIVE",
      },
    });

    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: admin.id, roleId: superAdminRole.id } },
      update: {},
      create: { userId: admin.id, roleId: superAdminRole.id },
    });

    // Tabish — full access test account (internal portal, Super Admin)
    const tabishHash = await hash("admin@123", 12);
    const tabish = await prisma.user.upsert({
      where: { email: "tabish@dashmani.com" },
      update: { passwordHash: tabishHash, status: "ACTIVE" },
      create: {
        name: "Tabish Mukaddam",
        email: "tabish@dashmani.com",
        passwordHash: tabishHash,
        status: "ACTIVE",
      },
    });

    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: tabish.id, roleId: superAdminRole.id } },
      update: {},
      create: { userId: tabish.id, roleId: superAdminRole.id },
    });
  }

  console.log("Seed completed successfully");

  // Seed platforms
  const platforms = [
    { name: "Instagram", slug: "instagram" },
    { name: "Facebook", slug: "facebook" },
    { name: "YouTube", slug: "youtube" },
    { name: "X", slug: "x" }, // formerly "Twitter/X" (slug "twitter") — deduped 2026-07-01; the real accounts live under slug "x"
    { name: "LinkedIn", slug: "linkedin" },
    { name: "Snapchat", slug: "snapchat" },
    { name: "Pinterest", slug: "pinterest" },
    { name: "Telegram", slug: "telegram" },
  ];

  for (const p of platforms) {
    await prisma.platform.upsert({
      where: { slug: p.slug },
      update: {},
      create: p,
    });
  }
  console.log("Seeded 8 platforms");

  // Seed Demo Snapchat account
  const snapchatPlatform = await prisma.platform.findUnique({ where: { slug: "snapchat" } });
  if (snapchatPlatform) {
    await prisma.socialAccount.upsert({
      where: { handle_platformId: { handle: "demo_snapchat", platformId: snapchatPlatform.id } },
      update: {},
      create: {
        handle: "demo_snapchat",
        displayName: "Demo Snapchat",
        platformId: snapchatPlatform.id,
        status: "ACTIVE",
        followerCount: 0,
      },
    });
    console.log("Seeded Demo Snapchat account");
  }

  // Seed demo client
  const clientPasswordHash = await hash("Client@123456", 12);
  await prisma.client.upsert({
    where: { email: "demo@clientcompany.com" },
    update: {},
    create: {
      companyName: "Demo Client Co.",
      contactName: "Rahul Sharma",
      email: "demo@clientcompany.com",
      passwordHash: clientPasswordHash,
      status: "ACTIVE",
    },
  });
  console.log("Seeded demo client");

  // Tabish — full access test account (client portal)
  const tabishClientHash = await hash("admin@123", 12);
  await prisma.client.upsert({
    where: { email: "tabish@dashmani.com" },
    update: { passwordHash: tabishClientHash, status: "ACTIVE" },
    create: {
      companyName: "Dashmani",
      contactName: "Tabish Mukaddam",
      email: "tabish@dashmani.com",
      passwordHash: tabishClientHash,
      status: "ACTIVE",
    },
  });
  console.log("Seeded Tabish test account (client portal)");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
