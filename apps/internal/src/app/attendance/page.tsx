"use client";
import { useAttendance } from "@/lib/hooks/use-attendance";
import { AttendanceClock } from "@/components/attendance-clock";

export default function AttendancePage() {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const endDate = now.toISOString().split("T")[0];

  const { data, isLoading } = useAttendance({ startDate, endDate });
  const records = (data as any)?.data || [];

  const statusBadge: Record<string, string> = {
    PRESENT: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
    LATE: "bg-[#FFF3C4] text-[#1A1A1A]",
    ABSENT: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
    HALF_DAY: "bg-[rgba(245,166,35,0.12)] text-[#F5A623]",
    LEAVE: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  };

  return (
    <div className="space-y-6 crx-animate-fade">
      <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Attendance</h1>

      <div className="max-w-sm crx-animate-slide crx-delay-1">
        <AttendanceClock />
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-2">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Date</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Check In</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Check Out</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Overtime</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} className="p-4 text-center text-[#7A7A7A]">Loading...</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={5} className="p-4 text-center text-[#7A7A7A]">No records this month</td></tr>
              ) : (
                records.map((r: any) => (
                  <tr key={r.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="p-4 text-[#1A1A1A]">{new Date(r.date).toLocaleDateString()}</td>
                    <td className="p-4 text-[#1A1A1A]">{r.checkIn ? new Date(r.checkIn).toLocaleTimeString() : "\u2014"}</td>
                    <td className="p-4 text-[#1A1A1A]">{r.checkOut ? new Date(r.checkOut).toLocaleTimeString() : "\u2014"}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[r.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="p-4 text-[#1A1A1A]">{r.overtimeHours > 0 ? `${r.overtimeHours.toFixed(1)}h` : "\u2014"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
