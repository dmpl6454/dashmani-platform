export type ContentStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "SCHEDULED"
  | "PUBLISHED"
  | "FAILED"
  | "REJECTED";

export interface ContentPost {
  id: string;
  title: string;
  caption?: string;
  mediaUrls: string[];
  projectId: string;
  accountId?: string;
  status: ContentStatus;
  scheduledAt?: string;
  publishedAt?: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContentPostRequest {
  title: string;
  caption?: string;
  mediaUrls?: string[];
  projectId: string;
  accountId?: string;
  scheduledAt?: string;
}

export interface UpdateContentPostRequest {
  title?: string;
  caption?: string | null;
  mediaUrls?: string[];
  projectId?: string;
  accountId?: string | null;
  scheduledAt?: string | null;
}
