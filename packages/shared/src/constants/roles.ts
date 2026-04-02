import type { Permission } from "../types/rbac";

const allGlobal = (resource: string): Permission[] => [
  { resource, action: "view", scope: "global" },
  { resource, action: "create", scope: "global" },
  { resource, action: "edit", scope: "global" },
  { resource, action: "delete", scope: "global" },
  { resource, action: "approve", scope: "global" },
  { resource, action: "export", scope: "global" },
];

export const DEFAULT_ROLES = {
  SUPER_ADMIN: {
    name: "Super Admin",
    description: "Full system access",
    permissions: [
      "employees", "teams", "tasks", "accounts", "reports",
      "attendance", "roles", "settings", "clients", "content",
      "messages", "billing",
    ].flatMap(allGlobal),
  },
  ADMIN: {
    name: "Admin",
    description: "Employee and account management, no system settings",
    permissions: [
      "employees", "teams", "tasks", "accounts", "reports",
      "attendance", "clients", "content", "messages",
    ].flatMap(allGlobal),
  },
  TEAM_LEAD: {
    name: "Team Lead",
    description: "Manage own team, view team data",
    permissions: [
      { resource: "employees", action: "view" as const, scope: "team" as const },
      { resource: "teams", action: "view" as const, scope: "team" as const },
      { resource: "teams", action: "edit" as const, scope: "team" as const },
      { resource: "tasks", action: "view" as const, scope: "team" as const },
      { resource: "tasks", action: "create" as const, scope: "team" as const },
      { resource: "tasks", action: "edit" as const, scope: "team" as const },
      { resource: "tasks", action: "approve" as const, scope: "team" as const },
      { resource: "accounts", action: "view" as const, scope: "team" as const },
      { resource: "reports", action: "view" as const, scope: "team" as const },
      { resource: "reports", action: "create" as const, scope: "team" as const },
      { resource: "attendance", action: "view" as const, scope: "team" as const },
      { resource: "attendance", action: "edit" as const, scope: "own" as const },
    ],
  },
  SENIOR_EMPLOYEE: {
    name: "Senior Employee",
    description: "View assigned accounts and create reports",
    permissions: [
      { resource: "employees", action: "view" as const, scope: "own" as const },
      { resource: "tasks", action: "view" as const, scope: "own" as const },
      { resource: "tasks", action: "edit" as const, scope: "own" as const },
      { resource: "accounts", action: "view" as const, scope: "own" as const },
      { resource: "reports", action: "view" as const, scope: "own" as const },
      { resource: "reports", action: "create" as const, scope: "own" as const },
      { resource: "attendance", action: "view" as const, scope: "own" as const },
      { resource: "attendance", action: "create" as const, scope: "own" as const },
    ],
  },
  EMPLOYEE: {
    name: "Employee",
    description: "View and manage own work",
    permissions: [
      { resource: "employees", action: "view" as const, scope: "own" as const },
      { resource: "tasks", action: "view" as const, scope: "own" as const },
      { resource: "tasks", action: "edit" as const, scope: "own" as const },
      { resource: "accounts", action: "view" as const, scope: "own" as const },
      { resource: "attendance", action: "view" as const, scope: "own" as const },
      { resource: "attendance", action: "create" as const, scope: "own" as const },
    ],
  },
} as const;
