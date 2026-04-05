// OTP Auth
export interface OtpRequestPayload {
  identifier: string;
  channel: "EMAIL" | "SMS" | "WHATSAPP";
}

export interface OtpVerifyPayload {
  identifier: string;
  otp: string;
}

// Report Link
export interface ReportLinkInput {
  accountId: string;
  url: string;
  platform: string;
  description?: string;
  mediaUrl?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
}

// Submit Daily Report
export interface SubmitDailyReportRequest {
  date: string; // YYYY-MM-DD
  links: ReportLinkInput[];
  notes?: string;
  latitude?: number;
  longitude?: number;
}

// Report Link Response
export interface ReportLinkResponse {
  id: string;
  accountId: string;
  accountName: string;
  platform: string;
  platformSlug: string;
  url: string;
  description?: string | null;
  mediaUrl?: string | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  views?: number | null;
}

// Daily Report Response
export interface DailyReportResponse {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  notes?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  submittedFrom?: string | null;
  submittedAt: string;
  links: ReportLinkResponse[];
}

// Assigned Account Response
export interface AssignedAccountResponse {
  id: string;
  handle: string;
  displayName: string;
  platform: string;
  platformSlug: string;
  profileUrl?: string | null;
  followerCount: number;
  clientName?: string | null;
}

// Account Growth
export interface GrowthSnapshot {
  date: string;
  followerCount: number;
  followingCount?: number | null;
  postCount?: number | null;
  engagementRate?: number | null;
}

export interface AccountGrowthResponse {
  accountId: string;
  accountName: string;
  platform: string;
  snapshots: GrowthSnapshot[];
}

// Admin Filters
export interface AdminReportFilters {
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  accountId?: string;
}

// Notification
export interface NotificationResponse {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

// Leaderboard
export interface LeaderboardEntry {
  employeeId: string;
  employeeName: string;
  totalReports: number;
  totalLinks: number;
  currentStreak: number;
  longestStreak: number;
  avgLinksPerDay: number;
  totalEngagement: number;
}

// Team Dashboard
export interface TeamMember {
  employeeId: string;
  name: string;
  todaySubmitted: boolean;
  weekReports: number;
  totalLinks: number;
}

export interface TeamDashboardData {
  teamName: string;
  members: TeamMember[];
  submissionRate: number;
}
