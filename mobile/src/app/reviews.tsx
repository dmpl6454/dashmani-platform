import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

function Stars({ rating }: { rating: number }) {
  return (
    <Text style={{ fontSize: 14 }}>
      {"★".repeat(Math.max(0, Math.min(5, rating)))}
      <Text style={{ color: colors.faint }}>{"★".repeat(Math.max(0, 5 - rating))}</Text>
    </Text>
  );
}

export default function ReviewsScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/performance-reviews"));

  if (loading) return <Loading />;

  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card>
          <Empty icon="star-outline" text="No performance reviews yet" />
        </Card>
      ) : (
        items.map((r: any) => (
          <Card key={r.id}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.period}>{r.period}</Text>
              <Stars rating={r.rating ?? 0} />
            </View>
            {r.strengths ? (
              <View style={styles.block}>
                <Text style={styles.blockLabel}>Strengths</Text>
                <Text style={styles.blockText}>{r.strengths}</Text>
              </View>
            ) : null}
            {r.improvements ? (
              <View style={styles.block}>
                <Text style={styles.blockLabel}>Areas to improve</Text>
                <Text style={styles.blockText}>{r.improvements}</Text>
              </View>
            ) : null}
            {r.comments ? (
              <View style={styles.block}>
                <Text style={styles.blockLabel}>Comments</Text>
                <Text style={styles.blockText}>{r.comments}</Text>
              </View>
            ) : null}
            <Text style={styles.date}>{fmtDate(r.createdAt)}</Text>
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  period: { fontSize: 15, fontWeight: "800", color: colors.ink },
  block: { marginTop: 10 },
  blockLabel: { fontSize: 11, fontWeight: "700", color: colors.sub, textTransform: "uppercase" },
  blockText: { fontSize: 13, color: colors.ink, marginTop: 3, lineHeight: 18 },
  date: { fontSize: 11, color: colors.faint, marginTop: 10 },
});
