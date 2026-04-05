export interface Client {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  logoUrl?: string;
  status: "ACTIVE" | "INACTIVE" | "ONBOARDING";
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  clientId: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile {
  id: string;
  projectId: string;
  name: string;
  url: string;
  size: number;
  mimeType?: string;
  uploadedById: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  fileUrl?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "REVISION_REQUESTED";
  requestedById: string;
  respondedAt?: string;
  clientNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateClientRequest {
  companyName: string;
  contactName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  clientId: string;
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  status?: "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";
  startDate?: string | null;
  endDate?: string | null;
}

export interface CreateApprovalRequest {
  title: string;
  description?: string;
  fileUrl?: string;
}

export interface RespondApprovalRequest {
  status: "APPROVED" | "REJECTED" | "REVISION_REQUESTED";
  clientNote?: string;
}

export interface ClientLoginRequest {
  email: string;
  password: string;
}
