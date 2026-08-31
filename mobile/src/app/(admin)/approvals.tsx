import React, { useState } from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { apiFetch, fmtDate, fmtMoney } from "@/lib/api";
import { colors, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, StatusPill, Button, Chips, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

const TABS = ["LEAVES", "EXPENSES", "EXTRA_HOURS", "NEW_EMPLOYEES", "DOCUMENTS", "JOINING"] as const;
type Tab = (typeof TABS)[number];

export default function AdminApprovals() {
  const [tab, setTab] = useState<Tab>("LEAVES");
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(async () => {
    if (tab === "LEAVES") return apiFetch("/admin/leave-requests?status=PENDING");
    if (tab === "EXPENSES") return apiFetch("/admin/expenses?status=PENDING");
    if (tab === "EXTRA_HOURS") return apiFetch("/admin/extra-hours/pending");
    if (tab === "DOCUMENTS") {
      const docs = await apiFetch<any[]>("/admin/documents");
      return (docs ?? []).filter((d: any) => (d.status ?? "PENDING") === "PENDING");
    }
    if (tab === "JOINING") {
      const rows = await apiFetch<any[]>("/admin/joining-dates");
      return (rows ?? []).filter((r: any) => !r.joiningDateApproved);
    }
    return apiFetch("/admin/employees/pending");
  }, [tab]);

  const act = async (label: string, fn: () => Promise<any>, id: string) => {
    setActing(id);
    setError(null);
    setSuccessMsg(null);
    try {
      await fn();
      setSuccessMsg(label);
      reload();
    } catch (e: any) {
      setError(e?.message || "Action failed");
    } finally {
      setActing(null);
    }
  };

  const confirmReject = (what: string, fn: () => void) => {
    Alert.alert(`Reject ${what}?`, "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reject", style: "destructive", onPress: fn },
    ]);
  };

  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips
        options={TABS}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setError(null);
          setSuccessMsg(null);
        }}
        labels={{ LEAVES: "Leaves", EXPENSES: "Expenses", EXTRA_HOURS: "Extra Hrs", NEW_EMPLOYEES: "New Joiners", DOCUMENTS: "Documents", JOINING: "Join Dates" }}
      />
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty icon="checkmark-done-outline" text="Nothing pending — all clear!" />
        </Card>
      ) : (
        items.map((item: any) => {
          const busy = acting === item.id;
          return (
            <Card key={item.id}>
              {tab === "LEAVES" && (
                <>
                  <View style={styles.headRow}>
                    <Text style={styles.who}>{item.employee?.name ?? "Employee"}</Text>
                    <StatusPill status={item.type ?? "LEAVE"} />
                  </View>
                  <Text style={styles.line}>
                    {fmtDate(item.startDate)}
                    {item.endDate && item.endDate !== item.startDate ? ` → ${fmtDate(item.endDate)}` : ""}
                  </Text>
                  {item.reason ? <Text style={styles.reason}>{item.reason}</Text> : null}
                  <View style={styles.actions}>
                    <Button
                      title="Approve"
                      small
                      loading={busy}
                      onPress={() =>
                        act("Leave approved", () => apiFetch(`/admin/leave-requests/${item.id}/approve`, { method: "POST" }), item.id)
                      }
                      style={{ flex: 1, backgroundColor: colors.green }}
                    />
                    <Button
                      title="Reject"
                      small
                      variant="danger"
                      disabled={busy}
                      onPress={() =>
                        confirmReject("leave", () =>
                          act("Leave rejected", () => apiFetch(`/admin/leave-requests/${item.id}/reject`, { method: "POST" }), item.id),
                        )
                      }
                      style={{ flex: 1 }}
                    />
                  </View>
                </>
              )}

              {tab === "EXPENSES" && (
                <>
                  <View style={styles.headRow}>
                    <Text style={styles.who}>{item.employee?.name ?? "Employee"}</Text>
                    <Text style={styles.amount}>{fmtMoney(item.amount)}</Text>
                  </View>
                  <Text style={styles.line}>
                    {item.title} · {item.category}
                  </Text>
                  {item.description ? <Text style={styles.reason}>{item.description}</Text> : null}
                  <View style={styles.actions}>
                    <Button
                      title="Approve"
                      small
                      loading={busy}
                      onPress={() =>
                        act("Expense approved", () => apiFetch(`/admin/expenses/${item.id}/approve`, { method: "POST" }), item.id)
                      }
                      style={{ flex: 1, backgroundColor: colors.green }}
                    />
                    <Button
                      title="Reject"
                      small
                      variant="danger"
                      disabled={busy}
                      onPress={() =>
                        confirmReject("expense", () =>
                          act("Expense rejected", () => apiFetch(`/admin/expenses/${item.id}/reject`, { method: "POST" }), item.id),
                        )
                      }
                      style={{ flex: 1 }}
                    />
                  </View>
                </>
              )}

              {tab === "EXTRA_HOURS" && (
                <>
                  <View style={styles.headRow}>
                    <Text style={styles.who}>{item.employee?.name ?? "Employee"}</Text>
                    <Text style={styles.amount}>{item.hours}h</Text>
                  </View>
                  <Text style={styles.line}>{fmtDate(item.date)}</Text>
                  {item.description ? <Text style={styles.reason}>{item.description}</Text> : null}
                  <View style={styles.actions}>
                    <Button
                      title="Approve"
                      small
                      loading={busy}
                      onPress={() =>
                        act("Hours approved", () => apiFetch(`/admin/extra-hours/${item.id}/approve`, { method: "POST" }), item.id)
                      }
                      style={{ flex: 1, backgroundColor: colors.green }}
                    />
                    <Button
                      title="Reject"
                      small
                      variant="danger"
                      disabled={busy}
                      onPress={() =>
                        confirmReject("extra hours", () =>
                          act("Hours rejected", () => apiFetch(`/admin/extra-hours/${item.id}/reject`, { method: "POST" }), item.id),
                        )
                      }
                      style={{ flex: 1 }}
                    />
                  </View>
                </>
              )}

              {tab === "DOCUMENTS" && (
                <>
                  <View style={styles.headRow}>
                    <Text style={styles.who}>{item.employee?.name ?? "Employee"}</Text>
                    <StatusPill status={item.status ?? "PENDING"} />
                  </View>
                  <Text style={styles.line}>{item.fileName}</Text>
                  <Text style={styles.reason}>Uploaded {fmtDate(item.createdAt)}</Text>
                  <View style={styles.actions}>
                    <Button
                      title="Approve"
                      small
                      loading={busy}
                      onPress={() =>
                        act("Document approved", () => apiFetch("/admin/documents/bulk-review", { method: "POST", body: JSON.stringify({ ids: [item.id], action: "APPROVE" }) }), item.id)
                      }
                      style={{ flex: 1, backgroundColor: colors.green }}
                    />
                    <Button
                      title="Reject"
                      small
                      variant="danger"
                      disabled={busy}
                      onPress={() =>
                        confirmReject("document", () =>
                          act("Document rejected", () => apiFetch("/admin/documents/bulk-review", { method: "POST", body: JSON.stringify({ ids: [item.id], action: "REJECT" }) }), item.id),
                        )
                      }
                      style={{ flex: 1 }}
                    />
                  </View>
                </>
              )}

              {tab === "JOINING" && (
                <>
                  <View style={styles.headRow}>
                    <Text style={styles.who}>{item.user?.name ?? "Employee"}</Text>
                    <Text style={styles.amount}>{fmtDate(item.joiningDate)}</Text>
                  </View>
                  <Text style={styles.reason}>{item.user?.email ?? ""}</Text>
                  <View style={styles.actions}>
                    <Button
                      title="Approve Joining Date"
                      small
                      loading={busy}
                      onPress={() =>
                        act("Joining date approved", () => apiFetch(`/admin/joining-dates/${item.user?.id ?? item.userId}/approve`, { method: "POST" }), item.id)
                      }
                      style={{ flex: 1, backgroundColor: colors.green }}
                    />
                  </View>
                </>
              )}

              {tab === "NEW_EMPLOYEES" && (
                <>
                  <View style={styles.headRow}>
                    <Text style={styles.who}>{item.name}</Text>
                    <StatusPill status={item.status ?? "ONBOARDING"} />
                  </View>
                  <Text style={styles.line}>{item.email ?? item.phone ?? ""}</Text>
                  <Text style={styles.reason}>Registered {fmtDate(item.createdAt)}</Text>
                  <View style={styles.actions}>
                    <Button
                      title="Approve"
                      small
                      loading={busy}
                      onPress={() =>
                        act("Employee approved", () => apiFetch(`/admin/employees/${item.id}/approve`, { method: "PUT" }), item.id)
                      }
                      style={{ flex: 1, backgroundColor: colors.green }}
                    />
                    <Button
                      title="Reject"
                      small
                      variant="danger"
                      disabled={busy}
                      onPress={() =>
                        confirmReject("registration", () =>
                          act("Registration rejected", () => apiFetch(`/admin/employees/${item.id}/reject`, { method: "PUT" }), item.id),
                        )
                      }
                      style={{ flex: 1 }}
                    />
                  </View>
                </>
              )}
            </Card>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  who: { fontSize: 15, fontWeight: "700", color: colors.ink, flex: 1 },
  amount: { fontSize: 16, fontWeight: "700", color: colors.purple },
  line: { fontSize: 13, color: colors.ink, marginTop: 6 },
  reason: { fontSize: 12, color: colors.sub, marginTop: 4 },
  actions: { flexDirection: "row", gap: 10, marginTop: spacing.md },
});
