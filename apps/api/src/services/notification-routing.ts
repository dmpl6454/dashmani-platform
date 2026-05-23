import { NotificationType } from "@dashmani/db";

// Each type lists which audiences it should reach.
// "ADMINS"      = users with Super Admin or Admin role
// "RECIPIENT"   = a specific user passed by the caller (e.g. the employee whose leave was approved)
// "ALL_EMPLOYEES" = handled by announcement.service.ts directly — skip in dispatchNotification
export const NOTIFICATION_AUDIENCE: Record<NotificationType, Array<"ADMINS" | "RECIPIENT" | "ALL_EMPLOYEES">> = {
  // Admin-only (operational)
  REPORT_SUBMITTED:     ["ADMINS"],
  REPORT_MISSED:        ["ADMINS"],

  // Employee-only (personal/HR outcomes)
  REPORT_REMINDER:      ["RECIPIENT"],
  GROWTH_MILESTONE:     ["RECIPIENT"],
  ACCOUNT_ASSIGNED:     ["RECIPIENT"],
  LEAVE_APPROVED:       ["RECIPIENT"],
  LEAVE_REJECTED:       ["RECIPIENT"],
  SALARY_SLIP:          ["RECIPIENT"],
  DOCUMENT_UPLOADED:    ["RECIPIENT"],
  PROFILE_PICTURE:      ["RECIPIENT"],
  PERFORMANCE_REVIEW:   ["RECIPIENT"],
  INCENTIVE_AWARDED:    ["RECIPIENT"],
  EXTRA_HOURS_APPROVED: ["RECIPIENT"],

  // Admins only — raised by employee, admins need to act
  LEAVE_REQUEST:        ["ADMINS"],

  // Both — admin + originating employee
  BUG_REPORT_UPDATE:    ["ADMINS", "RECIPIENT"],

  // Broadcasts — handled by announcement.service.ts, not dispatchNotification
  ANNOUNCEMENT:         ["ALL_EMPLOYEES"],

  // Default for job apps, expense claims, complaints, registrations, etc.
  GENERAL:              ["ADMINS"],

  // Task assigned to a specific employee
  TASK_ASSIGNED:        ["RECIPIENT"],
};
