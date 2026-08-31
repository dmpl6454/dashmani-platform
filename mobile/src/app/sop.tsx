import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, Button, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function SopScreen() {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any>(async () => {
    const [content, status] = await Promise.allSettled([
      apiFetch<any>("/hr/sop-content"),
      apiFetch<any>("/hr/sop-status"),
    ]);
    return {
      sections: content.status === "fulfilled" ? (content.value?.sections ?? content.value ?? []) : [],
      status: status.status === "fulfilled" ? status.value : null,
    };
  });

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      await apiFetch("/hr/accept-sop", { method: "POST" });
      setSuccessMsg("SOP accepted — thank you!");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not accept");
    } finally {
      setAccepting(false);
    }
  };

  if (loading) return <Loading />;

  const sections: any[] = Array.isArray(data?.sections) ? data.sections : [];
  const accepted = data?.status?.accepted;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />

      <Card style={{ backgroundColor: accepted ? colors.greenSoft : colors.amberSoft, borderColor: "transparent" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ionicons name={accepted ? "checkmark-circle" : "alert-circle"} size={24} color={accepted ? colors.green : colors.amber} />
          <Text style={styles.statusText}>
            {accepted
              ? `Accepted on ${fmtDate(data.status.acceptedAt)}`
              : "Please read and accept the Standard Operating Procedure"}
          </Text>
        </View>
      </Card>

      {sections.map((s: any, i: number) => (
        <Card key={i}>
          <Text style={styles.secTitle}>{s.title ?? `Section ${i + 1}`}</Text>
          <Text style={styles.secBody}>{s.content ?? s.body ?? String(s)}</Text>
        </Card>
      ))}

      {!accepted && sections.length > 0 && (
        <Button title="I Have Read & Accept the SOP" onPress={accept} loading={accepting} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusText: { fontSize: 14, fontWeight: "600", color: colors.ink, flex: 1 },
  secTitle: { fontSize: 15, fontWeight: "800", color: colors.ink, marginBottom: 6 },
  secBody: { fontSize: 13, color: colors.sub, lineHeight: 20 },
});
