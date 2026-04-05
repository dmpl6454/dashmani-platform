// ===== Overview Stats (Internal Dashboard) =====

export interface OverviewStats {
  totalEmployees: number;
  activeTeams: number;
  presentToday: number;
  tasksCompletedThisMonth: number;
  activeProjects: number;
  pendingApprovals: number;
  contentPublishedThisMonth: number;
  contentScheduledUpcoming: number;
}

// ===== Task Analytics =====

export interface TaskStatusCount {
  status: string;
  count: number;
}

export interface TaskPriorityCount {
  priority: string;
  count: number;
}

export interface TaskAssigneeCount {
  assigneeId: string;
  assigneeName: string;
  total: number;
  done: number;
}

export interface TaskAnalytics {
  totalTasks: number;
  byStatus: TaskStatusCount[];
  byPriority: TaskPriorityCount[];
  completionRate: number;
  topAssignees: TaskAssigneeCount[];
  completedThisMonth: number;
  overdueCount: number;
}

// ===== Content Analytics =====

export interface ContentStatusCount {
  status: string;
  count: number;
}

export interface ContentPlatformCount {
  platformName: string;
  count: number;
}

export interface ContentAnalytics {
  totalPosts: number;
  byStatus: ContentStatusCount[];
  byPlatform: ContentPlatformCount[];
  publishedThisMonth: number;
  scheduledUpcoming: number;
}

// ===== Project Analytics =====

export interface ProjectHealthItem {
  projectId: string;
  projectName: string;
  clientName: string;
  status: string;
  totalTasks: number;
  completedTasks: number;
  pendingApprovals: number;
  taskCompletionPercent: number;
}

export interface ProjectAnalytics {
  totalProjects: number;
  activeProjects: number;
  projects: ProjectHealthItem[];
}

// ===== Attendance Analytics =====

export interface AttendanceDayCount {
  date: string;
  present: number;
  absent: number;
  late: number;
  leave: number;
}

export interface AttendanceAnalytics {
  totalEmployees: number;
  presentToday: number;
  absentToday: number;
  lateToday: number;
  onLeaveToday: number;
  attendanceRate: number;
  dailyBreakdown: AttendanceDayCount[];
}

// ===== Client Analytics =====

export interface ClientProjectHealth {
  projectId: string;
  projectName: string;
  status: string;
  totalTasks: number;
  completedTasks: number;
  pendingApprovals: number;
  taskCompletionPercent: number;
  totalContent: number;
  publishedContent: number;
}

export interface ClientAnalytics {
  totalProjects: number;
  activeProjects: number;
  totalTasks: number;
  completedTasks: number;
  pendingApprovals: number;
  overallCompletionPercent: number;
  projects: ClientProjectHealth[];
}
