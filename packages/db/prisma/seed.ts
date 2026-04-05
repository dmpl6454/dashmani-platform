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
        "messages", "billing",
      ].flatMap((resource) =>
        ["view", "create", "edit", "delete", "approve", "export"].map((action) => ({
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
        "attendance", "clients", "content", "messages",
      ].flatMap((resource) =>
        ["view", "create", "edit", "delete", "approve", "export"].map((action) => ({
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
    const passwordHash = await hash("Admin@123456", 12);
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
  }

  console.log("Seed completed successfully");

  // Seed platforms
  const platforms = [
    { name: "Instagram", slug: "instagram" },
    { name: "Facebook", slug: "facebook" },
    { name: "YouTube", slug: "youtube" },
    { name: "Twitter/X", slug: "twitter" },
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
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
