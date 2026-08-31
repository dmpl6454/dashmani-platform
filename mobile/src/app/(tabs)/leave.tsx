import React, { useState } from "react";
import { View, Text, StyleSheet, Modal, Platform } from "react-native";
import { apiFetch, fmtDate, todayIST } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import {
  Screen, Card, SectionTitle, StatusPill, Button, Field, ErrorBanner, SuccessBanner, Empty, Loading, Chips, useApi,
} from "@/components/ui";

const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID", "WFH", "COMP_OFF"] as const;
type LeaveType = (typeof LEAVE_TYPES)[number];

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export default function LeaveScreen() {
  const [showApply, setShowApply] = useState(false);
  const [type, setType] = useState<LeaveType>("CASUAL");
  const [startDate, setStartDate] = useState(todayIST());
  const [endDate, setEndDate] = useState(todayIST());
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi(async () => {
    const [balance, requests] = await Promise.all([
      apiFetch<any>("/hr/leave-balance"),
      apiFetch<any[]>("/hr/leave-requests"),
    ]);
    return { balance, requests };
  });

  const submitLeave = async () => {
    setError(null);
    if (!isDate(startDate) || !isDate(endDate)) {
      setError("Dates must be in YYYY-MM-DD format");
      return;
    }
    if (endDate < startDate) {
      setError("End date cannot be before start date");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/leave-requests", {
        method: "POST",
        body: JSON.stringify({ startDate, endDate, type, reason: reason || undefined }),
      });
      setShowApply(false);
      setReason("");
      setSuccessMsg(`${formatStatus(type)} request submitted for approval`);
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not submit request");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading />;

  const b = data?.balance;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <SuccessBanner message={successMsg} />

      {/* Balance */}
      <SectionTitle>Leave Balance · {new Date().getFullYear()}</SectionTitle>
      <View style={styles.balanceRow}>
        {[
          { label: "Casual", d: b?.casual },
          { label: "Sick", d: b?.sick },
          { label: "Earned", d: b?.earned },
        ].map(({ label, d }) => (
          <View key={label} style={styles.balanceCard}>
            <Text style={styles.balanceValue}>{d?.balance ?? "—"}</Text>
            <Text style={styles.balanceLabel}>{label}</Text>
            <Text style={styles.balanceUsed}>
              {d ? `${d.used}/${d.total} used` : ""}
            </Text>
          </View>
        ))}
      </View>
      {b?.unpaid?.used ? (
        <Text style={styles.unpaidNote}>Unpaid leave taken this year: {b.unpaid.used} day(s)</Text>
      ) : null}

      <Button title="+ Apply for Leave / WFH / Comp-Off" onPress={() => { setError(null); setShowApply(true); }} style={{ marginVertical: spacing.md }} />

      {/* Requests */}
      <SectionTitle>My Requests</SectionTitle>
      <Card>
        {(data?.requests ?? []).length === 0 ? (
          <Empty icon="calendar-outline" text="No leave requests yet" />
        ) : (
          data!.requests.map((r: any, i: number) => (
            <View key={r.id} style={[styles.reqRow, i === data!.requests.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.reqType}>{formatStatus(r.type)}</Text>
                <Text style={styles.reqDates}>
                  {fmtDate(r.startDate)}
                  {r.endDate && r.endDate !== r.startDate ? ` → ${fmtDate(r.endDate)}` : ""}
                </Text>
                {r.reason ? (
                  <Text style={styles.reqReason} numberOfLines={2}>
                    {r.reason}
                  </Text>
                ) : null}
              </View>
              <StatusPill status={r.status} />
            </View>
          ))
        )}
      </Card>

      {/* Apply modal */}
      <Modal visible={showApply} animationType="slide" transparent onRequestClose={() => setShowApply(false)}>
        <View style={styles.modalScrim}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>New Request</Text>
            <ErrorBanner message={error} />
            <Text style={styles.fieldLabel}>Type</Text>
            <Chips
              options={LEAVE_TYPES}
              value={type}
              onChange={setType}
              labels={{ WFH: "WFH", COMP_OFF: "Comp-Off" }}
            />
            <Field label="Start date (YYYY-MM-DD)" value={startDate} onChangeText={setStartDate} placeholder="2026-09-01" keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"} />
            <Field label="End date (YYYY-MM-DD)" value={endDate} onChangeText={setEndDate} placeholder="2026-09-01" keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"} />
            <Field label="Reason" value={reason} onChangeText={setReason} placeholder="Why do you need this?" multiline autoCapitalize="sentences" />
            <Button title="Submit Request" onPress={submitLeave} loading={submitting} />
            <Button title="Cancel" onPress={() => setShowApply(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  balanceRow: { flexDirection: "row", gap: 8 },
  balanceCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: "center",
  },
  balanceValue: { fontSize: 24, fontWeight: "700", color: colors.purple },
  balanceLabel: { fontSize: 12, fontWeight: "600", color: colors.ink, marginTop: 2 },
  balanceUsed: { fontSize: 10, color: colors.sub, marginTop: 2 },
  unpaidNote: { fontSize: 12, color: colors.sub, marginTop: 8 },
  reqRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  reqType: { fontSize: 14, fontWeight: "700", color: colors.ink },
  reqDates: { fontSize: 12, color: colors.sub, marginTop: 2 },
  reqReason: { fontSize: 12, color: colors.faint, marginTop: 2 },
  modalScrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: colors.cardHigh,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.ink, marginBottom: 12 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.ink, marginBottom: 6 },
});
