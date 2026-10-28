import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius } from "@/lib/theme";
import { Screen, Card, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";
import { BOOKING_STATUS, rupees } from "@/lib/campaigns";

// Campaign bookings — the internal portal's /campaigns queue (GET /admin/campaigns, Admin /
// Super Admin only): self-serve client bookings to review, post and deliver.

type Row = {
  id: string;
  name: string;
  brand: string;
  client: string;
  status: string;
  format: string | null;
  campaignType: string;
  totalPaise: number;
  launchFrom: string | null;
  launchTo: string | null;
  paidAt: string | null;
  updatedAt: string;
  itemCount: number;
  liveCount: number;
};

const FILTERS = ["todo", "changes", "done", "closed", "all"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<Filter, string> = {
  todo: "To do",
  changes: "Waiting on client",
  done: "Delivered",
  closed: "Rejected / refunded",
  all: "All",
};
const MATCH: Record<Filter, (s: string) => boolean> = {
  todo: (s) => ["paid_pending_review", "approved", "publishing"].includes(s),
  changes: (s) => ["changes_requested", "awaiting_payment"].includes(s),
  done: (s) => ["completed", "partially_published"].includes(s),
  closed: (s) => ["rejected", "refunded"].includes(s),
  all: () => true,
};

export default function AdminCampaigns() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("todo");
  const { data, loading, refreshing, error, refresh } = useApi<Row[]>(() => apiFetch("/admin/campaigns"));
  const rows = (data ?? []).filter((r) => MATCH[filter](r.status));
  const counts = Object.fromEntries(FILTERS.map((f) => [f, (data ?? []).filter((r) => MATCH[f](r.status)).length])) as Record<Filter, number>;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={FILTERS} value={filter} onChange={setFilter} labels={Object.fromEntries(FILTERS.map((f) => [f, `${FILTER_LABEL[f]} ${counts[f]}`])) as Record<Filter, string>} />
      <ErrorBanner message={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        <Card>
          {rows.length === 0 ? (
            <Empty icon="megaphone-outline" text={filter === "todo" ? "Nothing to review or post right now" : "No campaigns here"} />
          ) : (
            rows.map((r, i) => {
              const st = BOOKING_STATUS[r.status] ?? { label: r.status, color: colors.sub };
              return (
                <Pressable key={r.id} onPress={() => router.push(`/admin-campaign/${r.id}`)}>
                  <View style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.name} numberOfLines={1}>{r.name}</Text>
                      <Text style={styles.sub} numberOfLines={1}>
                        {r.client} · {r.itemCount} account{r.itemCount === 1 ? "" : "s"}
                        {r.liveCount ? ` · ${r.liveCount} live` : ""}
                      </Text>
                      <Text style={styles.sub} numberOfLines={1}>
                        {r.launchFrom ? `${fmtDate(r.launchFrom)} – ${fmtDate(r.launchTo)}` : "No dates"} · {rupees(r.totalPaise)}
                        {r.paidAt ? " · paid online" : ""}
                      </Text>
                    </View>
                    <View style={[styles.pill, { backgroundColor: st.color + "26" }]}>
                      <Text style={[styles.pillText, { color: st.color }]}>{st.label}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={15} color={colors.faint} />
                  </View>
                </Pressable>
              );
            })
          )}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: 15, fontWeight: "600", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, maxWidth: 130 },
  pillText: { fontSize: 11, fontWeight: "700" },
});
