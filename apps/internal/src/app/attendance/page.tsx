"use client";
import { useAttendance } from "@/lib/hooks/use-attendance";
import { AttendanceClock } from "@/components/attendance-clock";
import { Badge, Card } from "@dashmani/ui";

export default function AttendancePage() {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  const { data, isLoading } = useAttendance({ startDate, endDate });
  const records = (data as any)?.data || [];

  const statusColor: Record<string, "success" | "warning" | "danger" | "secondary" | "default"> = {
    PRESENT: "success",
    LATE: "warning",
    ABSENT: "danger",
    HALF_DAY: "warning",
    LEAVE: "secondary",
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Attendance</h2>

      <div className="max-w-sm">
        <AttendanceClock />
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-4 font-medium">Date</th>
                <th className="text-left p-4 font-medium">Check In</th>
                <th className="text-left p-4 font-medium">Check Out</th>
                <th className="text-left p-4 font-medium">Status</th>
                <th className="text-left p-4 font-medium">Overtime</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} className="p-4 text-center">Loading...</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No records this month</td></tr>
              ) : (
                records.map((r: any) => (
                  <tr key={r.id} className="border-b">
                    <td className="p-4">{new Date(r.date).toLocaleDateString()}</td>
                    <td className="p-4">{r.checkIn ? new Date(r.checkIn).toLocaleTimeString() : "—"}</td>
                    <td className="p-4">{r.checkOut ? new Date(r.checkOut).toLocaleTimeString() : "—"}</td>
                    <td className="p-4"><Badge variant={statusColor[r.status]}>{r.status}</Badge></td>
                    <td className="p-4">{r.overtimeHours > 0 ? `${r.overtimeHours.toFixed(1)}h` : "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
