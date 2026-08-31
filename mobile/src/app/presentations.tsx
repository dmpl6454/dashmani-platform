import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDateTime } from "@/lib/api";
import { colors } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi, Row } from "@/components/ui";

export default function PresentationsScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/presentations"));

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card>
          <Empty icon="easel-outline" text="No presentations yet" />
        </Card>
      ) : (
        <Card>
          {items.map((p: any) => (
            <Row
              key={p.id}
              icon="easel-outline"
              title={p.title}
              subtitle={`${p.theme ?? "default"} theme · updated ${fmtDateTime(p.updatedAt)}`}
            />
          ))}
        </Card>
      )}
      <Text style={styles.hint}>
        Create and edit presentations (incl. AI generation) on hr.digitalsukoon.com/presentations — the editor needs a
        big screen.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: 4, lineHeight: 16 },
});
