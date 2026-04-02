export const RESOURCES = [
  "employees", "teams", "tasks", "accounts", "reports",
  "attendance", "roles", "settings", "clients", "content",
  "messages", "billing",
] as const;

export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = ["view", "create", "edit", "delete", "approve", "export"] as const;
export const SCOPES = ["own", "team", "department", "global"] as const;
