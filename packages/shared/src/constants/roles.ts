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
  /**
   * HR-only access to the internal portal: people records, attendance, leave,
   * payroll documents, hiring. Deliberately no reports / accounts / analytics /
   * clients / content, and no way to grant or edit an admin — the API enforces
   * that in middleware/role-guard.ts, because `employees.edit` alone would let
   * the holder hand out Super Admin through the employee form.
   */
  HR_MANAGER: {
    name: "HR Manager",
    description: "HR features only: employees, attendance, leave, payroll documents and hiring",
    permissions: [
      ...allGlobal("employees"),
      ...allGlobal("attendance"),
      { resource: "teams", action: "view" as const, scope: "global" as const },
      { resource: "roles", action: "view" as const, scope: "global" as const },
    ],
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

export const HR_MANAGER_ROLE_NAME = DEFAULT_ROLES.HR_MANAGER.name;

/**
 * Roles only an Admin / Super Admin may hand out or act on. An HR Manager can
 * create, edit and deactivate everyone else, but never a holder of one of these.
 */
export const PRIVILEGED_ROLE_NAMES: readonly string[] = [
  DEFAULT_ROLES.SUPER_ADMIN.name,
  DEFAULT_ROLES.ADMIN.name,
  DEFAULT_ROLES.HR_MANAGER.name,
];
