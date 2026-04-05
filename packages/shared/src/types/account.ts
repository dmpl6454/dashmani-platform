export interface Platform {
  id: string;
  name: string;
  slug: string;
  iconUrl?: string;
}

export interface SocialAccount {
  id: string;
  handle: string;
  displayName: string;
  platformId: string;
  clientName?: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  profileUrl?: string;
  followerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountAssignment {
  id: string;
  accountId: string;
  employeeId: string;
  assignedBy: string;
  assignedAt: string;
  unassignedAt?: string;
  reason?: string;
}

export interface CreateAccountRequest {
  handle: string;
  displayName: string;
  platformId: string;
  clientName?: string;
  profileUrl?: string;
}

export interface UpdateAccountRequest {
  handle?: string;
  displayName?: string;
  clientName?: string | null;
  profileUrl?: string | null;
  status?: "ACTIVE" | "PAUSED" | "ARCHIVED";
  followerCount?: number;
}

export interface AssignAccountRequest {
  employeeId: string;
  reason?: string;
}
