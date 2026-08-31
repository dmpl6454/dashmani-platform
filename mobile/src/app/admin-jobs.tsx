import React, { useState } from "react";
import { View, Text, StyleSheet, Modal, Pressable } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, StatusPill, Button, Chips, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

const TABS = ["APPLICATIONS", "JOBS"] as const;
const APP_STATUSES = ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED", "REJECTED"] as const;

export default function AdminJobs() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("APPLICATIONS");
  const [statusFor, setStatusFor] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(
    () => apiFetch(tab === "JOBS" ? "/admin/jobs" : "/admin/applications"),
    [tab],
  );

  const changeStatus = async (app: any, status: string) => {
    setStatusFor(null);
    setError(null);
    try {
      await apiFetch(`/admin/applications/${app.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      setSuccessMsg(`Application → ${formatStatus(status)}`);
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not update");
    }
  };

  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={TABS} value={tab} onChange={setTab} labels={{ APPLICATIONS: "Applications", JOBS: "Openings" }} />
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty icon="briefcase-outline" text={tab === "JOBS" ? "No job openings" : "No applications"} />
        </Card>
      ) : tab === "JOBS" ? (
        items.map((j: any) => (
          <Card key={j.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.title, { flex: 1 }]} numberOfLines={2}>
                {j.title}
              </Text>
              <StatusPill status={j.status ?? (j.isActive ? "ACTIVE" : "CLOSED")} />
            </View>
            <Text style={styles.meta}>
              {j.department ?? ""} {j.location ? `· ${j.location}` : ""} {j.type ? `· ${formatStatus(j.type)}` : ""}
            </Text>
            <Text style={styles.meta}>
              {(j._count?.applications ?? j.applicationCount ?? 0) + " application(s)"} · Posted {fmtDate(j.createdAt)}
            </Text>
          </Card>
        ))
      ) : (
        items.map((a: any) => (
          <Card key={a.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.title} numberOfLines={1}>
                  {a.name ?? a.applicantName}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {a.jobListing?.title ?? a.job?.title ?? ""}
                </Text>
              </View>
              <Pressable onPress={() => setStatusFor(a)}>
                <StatusPill status={a.status ?? "RECEIVED"} />
              </Pressable>
            </View>
            <Text style={styles.meta}>
              {a.email ?? ""} {a.phone ? `· ${a.phone}` : ""}
            </Text>
            <Text style={styles.meta}>Applied {fmtDate(a.createdAt)}</Text>
            <Text style={styles.tapHint}>Tap the status pill to move this candidate forward</Text>
          </Card>
        ))
      )}

      <Modal visible={!!statusFor} animationType="fade" transparent onRequestClose={() => setStatusFor(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Application Status</Text>
            <Text style={styles.sheetSub}>{statusFor?.name ?? ""}</Text>
            {APP_STATUSES.map((s) => (
              <Pressable key={s} style={styles.optRow} onPress={() => changeStatus(statusFor, s)}>
                <StatusPill status={s} />
              </Pressable>
            ))}
            <Button title="Cancel" onPress={() => setStatusFor(null)} variant="ghost" small style={{ marginTop: spacing.sm }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 15, fontWeight: "700", color: colors.ink },
  meta: { fontSize: 12, color: colors.sub, marginTop: 3 },
  tapHint: { fontSize: 10, color: colors.faint, marginTop: 6 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: spacing.xl },
  sheet: { backgroundColor: "#fff", borderRadius: radius.xl, padding: spacing.lg, maxHeight: "80%" },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: colors.ink },
  sheetSub: { fontSize: 13, color: colors.sub, marginTop: 4, marginBottom: 8 },
  optRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});
