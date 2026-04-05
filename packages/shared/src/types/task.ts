export interface Task {
  id: string;
  title: string;
  description?: string;
  status: "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELLED";
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  assigneeId?: string;
  createdById: string;
  accountId?: string;
  dueDate?: string;
  completedAt?: string;
  dependsOnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  assigneeId?: string;
  accountId?: string;
  dueDate?: string;
  dependsOnId?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  assigneeId?: string | null;
  accountId?: string | null;
  dueDate?: string | null;
  dependsOnId?: string | null;
}
