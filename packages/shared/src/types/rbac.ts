export type PermissionAction = "view" | "create" | "edit" | "delete" | "approve" | "export";
export type PermissionScope = "own" | "team" | "department" | "global";

export interface Permission {
  resource: string;
  action: PermissionAction;
  scope: PermissionScope;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  isSystemRole: boolean;
  permissions: Permission[];
}
