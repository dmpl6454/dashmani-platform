import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { formatStatus, motion, radius, statusColor } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Avatar, ErrorBanner, Screen, StatusPill, useApi } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { Sheet } from "@/components/sheet";
import { AsyncList } from "@/components/async";
import { confirm, toast } from "@/components/feedback";

// InternshipApplication.status is the ApplicationStatus enum (packages/db/prisma/schema.prisma).
const STATUSES = ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "ACCEPTED", "REJECTED"] as const;
/** Decisive moves: asked for confirmation first (AD-13). */
const CONFIRM_STATUSES: readonly string[] = ["OFFERED", "ACCEPTED", "REJECTED"];
/** The API emails the applicant on these moves. */
const EMAILED_STATUSES: readonly string[] = ["SHORTLISTED", "INTERVIEW", "OFFERED", "REJECTED"];

type Internship = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  college?: string | null;
  course?: string | null;
  status?: string | null;
  createdAt: string;
};

/** Lets one bottom sheet finish closing before the next one is presented (iOS Modal stacking). */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function joinParts(parts: Array<string | null | undefined>, sep = " · "): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(sep);
}

export default function AdminInternships() {
  const [statusFor, setStatusFor] = useState<Internship | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useApi<Internship[]>(async () => {
    const rows = await apiFetch<Internship[]>("/admin/internships");
    return Array.isArray(rows) ? rows : [];
  });

  const changeStatus = async (app: Internship, status: string) => {
    setStatusFor(null);
    if (status === (app.status ?? "RECEIVED")) return;
    if (CONFIRM_STATUSES.includes(status)) {
      await pause(motion.slow);
      const rejecting = status === "REJECTED";
      const ok = await confirm({
        title: `Move ${app.name} to ${formatStatus(status)}?`,
        message: EMAILED_STATUSES.includes(status)
          ? `${app.name} gets an email about this decision.`
          : "This marks the application as decided.",
        confirmLabel: rejecting ? "Reject" : formatStatus(status),
        destructive: rejecting,
      });
      if (!ok) return;
    }
    setError(null);
    setUpdatingId(app.id);
    try {
      await apiFetch(`/admin/internships/${app.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      void haptic("success");
      toast.show({ message: `${app.name} → ${formatStatus(status)}`, tone: "success" });
      await list.reload();
    } catch (e) {
      void haptic("error");
      setError(errorMessage(e, "Could not update the application"));
    } finally {
      setUpdatingId(null);
    }
  };

  const currentStatus = statusFor?.status ?? "RECEIVED";

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      <AsyncList
        state={list}
        grouped
        header={<ErrorBanner message={error} onDismiss={() => setError(null)} />}
        keyExtractor={(a) => a.id}
        renderItem={(a) => (
          <ListItem
            leading={<Avatar name={a.name} size={32} />}
            title={a.name}
            subtitle={joinParts(
              [joinParts([a.email, a.phone]), joinParts([a.college, `Applied ${fmtDate(a.createdAt)}`])],
              "\n",
            )}
            trailing={<StatusPill status={a.status ?? "RECEIVED"} size="sm" />}
            onPress={() => setStatusFor(a)}
            disabled={updatingId === a.id}
            accessibilityHint="Changes this applicant's status"
          />
        )}
        empty={{
          icon: "school-outline",
          title: "No internship applications",
          text: "Applications from the internships page appear here.",
        }}
      />

      <Sheet visible={!!statusFor} onClose={() => setStatusFor(null)} title="Application status" subtitle={statusFor?.name}>
        <ListGroup>
          {STATUSES.map((s) => (
            <ListItem
              key={s}
              title={formatStatus(s)}
              leading={<View style={[styles.dot, { backgroundColor: statusColor(s).dot }]} />}
              selected={currentStatus === s}
              onPress={() => {
                if (statusFor) void changeStatus(statusFor, s);
              }}
            />
          ))}
        </ListGroup>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  dot: { width: 10, height: 10, borderRadius: radius.full },
});
