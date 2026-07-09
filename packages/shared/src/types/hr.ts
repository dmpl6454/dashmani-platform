// OTP Auth
export interface OtpRequestPayload {
  identifier: string;
  channel: "EMAIL" | "SMS" | "WHATSAPP";
}

export interface OtpVerifyPayload {
  identifier: string;
  otp: string;
}

// Self-Registration
export interface RegisterEmployeeRequest {
  name: string;
  email: string;
  phone?: string;
  password: string;
}

// Password Login
export interface PasswordLoginRequest {
  identifier: string; // email or phone
  password: string;
}

// Employee Profile
export interface EmployeeProfileData {
  designation?: string | null;
  salary?: number | null;
  bankAccountHolderName?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  ifscCode?: string | null;
  mailingAddress?: string | null;
  aadhaarNumber?: string | null;
  panNumber?: string | null;
  familyContact1Name?: string | null;
  familyContact1Phone?: string | null;
  familyContact1Relation?: string | null;
  familyContact2Name?: string | null;
  familyContact2Phone?: string | null;
  familyContact2Relation?: string | null;
}

export interface EmployeeProfileResponse extends EmployeeProfileData {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone?: string | null;
  profileImageUrl?: string | null;
  status: string;
}

// Report Link
export interface ReportLinkInput {
  accountId: string;
  url?: string;
  platform: string;
  description?: string;
  mediaUrl?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
  isScheduled?: boolean;
  scheduledFor?: string;
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
  url?: string | null;
  description?: string | null;
  mediaUrl?: string | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  views?: number | null;
  isScheduled: boolean;
  scheduledFor?: string | null;
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
  // Present ONLY on the POST /hr/reports submit response — counts of links the
  // server silently de-duplicated, split by reason (in-submission = the same link
  // pasted/typed twice; crossDay = already submitted on a previous day). Optional
  // so every READ path / admin reuse of this type is unaffected. Lets the submit
  // screen explain a lower saved count instead of it reading as data loss.
  dedupe?: { inSubmission: number; crossDay: number; total: number };
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
  page?: number;
  pageSize?: number;
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
