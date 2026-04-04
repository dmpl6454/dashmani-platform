"use client";
import { useState } from "react";
import { Button, Card, CardContent } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";
import { Clock, LogIn, LogOut } from "lucide-react";

export function AttendanceClock() {
  const [status, setStatus] = useState<"idle" | "checked_in" | "checked_out">("idle");
  const [time, setTime] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleCheckIn() {
    setLoading(true);
    setError("");
    try {
      const res: any = await apiFetch("/attendance/check-in", { method: "POST" });
      setStatus("checked_in");
      setTime(new Date(res.data.checkIn).toLocaleTimeString());
    } catch (err: any) {
      setError(err.message);
    } finally { setLoading(false); }
  }

  async function handleCheckOut() {
    setLoading(true);
    setError("");
    try {
      const res: any = await apiFetch("/attendance/check-out", { method: "POST" });
      setStatus("checked_out");
      setTime(new Date(res.data.checkOut).toLocaleTimeString());
    } catch (err: any) {
      setError(err.message);
    } finally { setLoading(false); }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <Clock className="h-5 w-5 text-brand-blue" />
          <h3 className="font-semibold">Attendance</h3>
        </div>
        {error && <p className="text-sm text-red-500 mb-3">{error}</p>}
        {time && <p className="text-sm text-muted-foreground mb-3">{status === "checked_in" ? "Checked in" : "Checked out"} at {time}</p>}
        <div className="flex gap-3">
          <Button onClick={handleCheckIn} disabled={loading || status === "checked_in"} className="flex-1">
            <LogIn className="h-4 w-4 mr-2" /> Check In
          </Button>
          <Button onClick={handleCheckOut} disabled={loading || status !== "checked_in"} variant="outline" className="flex-1">
            <LogOut className="h-4 w-4 mr-2" /> Check Out
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
