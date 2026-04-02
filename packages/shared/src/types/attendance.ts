export type AttendanceStatus = "present" | "absent" | "late" | "half_day" | "leave";

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  date: string;
  checkIn?: string;
  checkOut?: string;
  status: AttendanceStatus;
  overtimeHours: number;
  ipAddress?: string;
}

export interface CheckInRequest {
  ipAddress?: string;
}

export interface LeaveRequest {
  startDate: string;
  endDate: string;
  reason: string;
  type: "casual" | "sick" | "earned" | "unpaid";
}
