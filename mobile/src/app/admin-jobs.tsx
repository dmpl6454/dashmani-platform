import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { formatStatus, motion, radius, statusColor } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Avatar, Chips, ErrorBanner, Screen, StatusPill, useApi } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { Sheet } from "@/components/sheet";
import { AsyncList } from "@/components/async";
import { confirm, toast } from "@/components/feedback";

const TABS = ["APPLICATIONS", "JOBS"] as const;
type Tab = (typeof TABS)[number];

const APP_STATUSES = ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED", "REJECTED"] as const;
/** Moves that close an application: asked for confirmation first (AD-13). */
const FINAL_STATUSES: readonly string[] = ["HIRED", "REJECTED"];

type JobListing = {
  id: string;
  title: string;
  department?: string | null;
  location?: string | null;
  type?: string | null;
  status?: string | null;
  isActive?: boolean;
  createdAt: string;
  _count?: { applications?: number } | null;
  applicationCount?: number;
};

type JobApplication = {
  id: string;
  applicantName?: string | null;
  name?: string | null;
  applicantEmail?: string | null;
  email?: string | null;
  applicantPhone?: string | null;
  phone?: string | null;
  status?: string | null;
  createdAt: string;
  job?: { title?: string | null; department?: string | null } | null;
  jobListing?: { title?: string | null } | null;
};

type Entry = { kind: "job"; job: JobListing } | { kind: "app"; app: JobApplication };

/** Lets one bottom sheet finish closing before the next one is presented (iOS Modal stacking). */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function joinParts(parts: Array<string | null | undefined>, sep = " · "): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(sep);
}

function applicantName(a: JobApplication): string {
  return a.applicantName ?? a.name ?? "Applicant";
}

async function loadEntries(tab: Tab): Promise<Entry[]> {
  if (tab === "JOBS") {
    const jobs = await apiFetch<JobListing[]>("/admin/jobs");
    return (Array.isArray(jobs) ? jobs : []).map((job): Entry => ({ kind: "job", job }));
  }
  const apps = await apiFetch<JobApplication[]>("/admin/applications");
  return (Array.isArray(apps) ? apps : []).map((app): Entry => ({ kind: "app", app }));
}

export default function AdminJobs() {
  const [tab, setTab] = useState<Tab>("APPLICATIONS");
  const [statusFor, setStatusFor] = useState<JobApplication | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useApi<Entry[]>(() => loadEntries(tab), [tab]);

  const changeStatus = async (app: JobApplication, status: string) => {
    setStatusFor(null);
    if (status === (app.status ?? "RECEIVED")) return;
    const name = applicantName(app);
    if (FINAL_STATUSES.includes(status)) {
      await pause(motion.slow);
      const rejecting = status === "REJECTED";
      const ok = await confirm({
        title: `Move ${name} to ${formatStatus(status)}?`,
        message: rejecting ? "The application will be closed as rejected." : "The candidate will be marked as hired.",
        confirmLabel: rejecting ? "Reject" : "Mark hired",
        destructive: rejecting,
      });
      if (!ok) return;
    }
    setError(null);
    setUpdatingId(app.id);
    try {
      await apiFetch(`/admin/applications/${app.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      void haptic("success");
      toast.show({ message: `${name} → ${formatStatus(status)}`, tone: "success" });
      await list.reload();
    } catch (e) {
      void haptic("error");
      setError(errorMessage(e, "Could not update the application"));
    } finally {
      setUpdatingId(null);
    }
  };

  const jobItem = (job: JobListing) => {
    const count = job._count?.applications ?? job.applicationCount ?? 0;
    return (
      <ListItem
        icon="briefcase-outline"
        tint="blue"
        title={job.title}
        subtitle={joinParts(
          [
            joinParts([job.department, job.location, job.type ? formatStatus(job.type) : null]),
            `${count} ${count === 1 ? "application" : "applications"} · Posted ${fmtDate(job.createdAt)}`,
          ],
          "\n",
        )}
        trailing={<StatusPill status={job.status ?? (job.isActive ? "ACTIVE" : "CLOSED")} size="sm" />}
      />
    );
  };

  const applicationItem = (a: JobApplication) => {
    const name = applicantName(a);
    return (
      <ListItem
        leading={<Avatar name={name} size={32} />}
        title={name}
        subtitle={joinParts(
          [
            a.job?.title ?? a.jobListing?.title,
            joinParts([a.applicantEmail ?? a.email, a.applicantPhone ?? a.phone, `Applied ${fmtDate(a.createdAt)}`]),
          ],
          "\n",
        )}
        trailing={<StatusPill status={a.status ?? "RECEIVED"} size="sm" />}
        onPress={() => setStatusFor(a)}
        disabled={updatingId === a.id}
        accessibilityHint="Changes this candidate's status"
      />
    );
  };

  const currentStatus = statusFor?.status ?? "RECEIVED";

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      <AsyncList
        state={list}
        grouped
        header={
          <>
            <Chips
              options={TABS}
              value={tab}
              onChange={(t) => {
                setError(null);
                setTab(t);
              }}
              labels={{ APPLICATIONS: "Applications", JOBS: "Openings" }}
              accessibilityLabel="Show"
            />
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </>
        }
        keyExtractor={(e) => (e.kind === "job" ? `job:${e.job.id}` : `app:${e.app.id}`)}
        renderItem={(e) => (e.kind === "job" ? jobItem(e.job) : applicationItem(e.app))}
        empty={
          tab === "JOBS"
            ? { icon: "briefcase-outline", title: "No job openings", text: "Openings you post appear here." }
            : { icon: "people-outline", title: "No applications yet", text: "Applications from the careers page appear here." }
        }
      />

      <Sheet
        visible={!!statusFor}
        onClose={() => setStatusFor(null)}
        title="Application status"
        subtitle={statusFor ? applicantName(statusFor) : undefined}
      >
        <ListGroup>
          {APP_STATUSES.map((s) => (
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
