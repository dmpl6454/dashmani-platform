import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtCompact, fmtDateTime } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

// The ONLY windows Meta can answer (FB: day/week/days_28; IG caps spans at 30d).
// "today" is Instagram-only and deliberately partial — FB publishes only
// completed days, so its cells show dashes under Today.
const WINDOWS = [
  { key: "day", label: "Yesterday" },
  { key: "week", label: "7d" },
  { key: "days_28", label: "28d" },
  { key: "today", label: "Today (so far)" },
] as const;
type WinKey = (typeof WINDOWS)[number]["key"];

const PLATFORMS = ["all", "facebook", "instagram"] as const;
type Platform = (typeof PLATFORMS)[number];

/** Meta earnings are USD. null ≠ 0 — IG has no earnings metric at all. */
function fmtUsd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return "$" + (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** null means "Meta does not publish this" — render a dash, never 0. */
function dashCompact(n: number | null | undefined): string {
  return n == null ? "—" : fmtCompact(n);
}

export default function AdminGrowth() {
  const [win, setWin] = useState<WinKey>("days_28");
  const [platform, setPlatform] = useState<Platform>("all");
  const [search, setSearch] = useState("");

  const { data, loading, refreshing, error, refresh } = useApi<any>(() => {
    const qs = new URLSearchParams();
    qs.set("window", win);
    if (platform !== "all") qs.set("platform", platform);
    if (search.trim()) qs.set("q", search.trim());
    return apiFetch(`/admin/meta/channels?${qs.toString()}`);
  }, [win, platform, search]);

  const items: any[] = data?.items ?? [];
  const totals = data?.totals;
  const winLabel = WINDOWS.find((w) => w.key === win)?.label ?? "";

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips
        options={WINDOWS.map((w) => w.key) as unknown as readonly WinKey[]}
        value={win}
        onChange={setWin}
        labels={Object.fromEntries(WINDOWS.map((w) => [w.key, w.label])) as any}
      />
      <Chips
        options={PLATFORMS}
        value={platform}
        onChange={setPlatform}
        labels={{ all: "All", facebook: "Facebook", instagram: "Instagram" }}
      />
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search channels…"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        style={styles.search}
      />
      <ErrorBanner message={error} />

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* Summary tiles — followers is a STOCK (now), the rest are the period's flows */}
          {totals ? (
            <>
              <View style={styles.tileRow}>
                <View style={styles.tile}>
                  <Text style={styles.tileValue}>{dashCompact(totals.views)}</Text>
                  <Text style={styles.tileLabel}>Views · {winLabel}</Text>
                </View>
                <View style={styles.tile}>
                  <Text style={styles.tileValue}>{dashCompact(totals.engagements)}</Text>
                  <Text style={styles.tileLabel}>Engage · {winLabel}</Text>
                </View>
                <View style={styles.tile}>
                  <Text style={styles.tileValue}>{dashCompact(totals.reach)}</Text>
                  <Text style={styles.tileLabel}>Reach · {winLabel}</Text>
                </View>
              </View>
              <View style={styles.tileRow}>
                <View style={styles.tile}>
                  <Text style={styles.tileValue}>{dashCompact(totals.followers)}</Text>
                  <Text style={styles.tileLabel}>Followers (now)</Text>
                </View>
                <View style={styles.tile}>
                  <Text style={[styles.tileValue, { color: colors.green }]}>{fmtUsd(totals.earningsCents)}</Text>
                  <Text style={styles.tileLabel}>Revenue · {winLabel}</Text>
                </View>
              </View>
            </>
          ) : null}

          <SectionTitle>
            Connected Channels ({data?.channelCount ?? items.length})
          </SectionTitle>
          {data?.dataThrough ? (
            <Text style={styles.dataThrough}>Data through {fmtDateTime(data.dataThrough)}</Text>
          ) : null}

          <Card>
            {items.length === 0 ? (
              <Empty icon="trending-up-outline" text="No connected channels match" />
            ) : (
              items.map((c: any, i: number) => (
                <View key={c.id} style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
                  {c.pictureUrl ? (
                    <Image source={{ uri: c.pictureUrl }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, styles.avatarFallback]}>
                      <Ionicons
                        name={c.platform === "instagram" ? "logo-instagram" : "logo-facebook"}
                        size={18}
                        color={colors.purple}
                      />
                    </View>
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={styles.name} numberOfLines={1}>
                        {c.name}
                      </Text>
                      {c.metricsError ? (
                        <Ionicons name="warning-outline" size={13} color={colors.amber} />
                      ) : null}
                    </View>
                    <Text style={styles.sub} numberOfLines={1}>
                      {c.username ? `@${c.username} · ` : ""}
                      {c.platform === "instagram" ? "Instagram" : "Facebook"}
                    </Text>
                    <View style={styles.metaRow}>
                      <Text style={styles.followers}>{dashCompact(c.followers)} followers</Text>
                      {c.followerDelta != null ? (
                        <Text
                          style={[
                            styles.delta,
                            { color: c.followerDelta >= 0 ? colors.green : colors.red },
                          ]}
                        >
                          {c.followerDelta >= 0 ? "+" : ""}
                          {fmtCompact(c.followerDelta)}
                          {c.followerDeltaDays ? ` · ${c.followerDeltaDays}d` : ""}
                        </Text>
                      ) : null}
                      {c.earningsCents != null && c.earningsCents > 0 ? (
                        <Text style={[styles.delta, { color: colors.green }]}>{fmtUsd(c.earningsCents)}</Text>
                      ) : null}
                    </View>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={styles.views}>{dashCompact(c.views28d)}</Text>
                    <Text style={styles.viewsLabel}>views</Text>
                    <Text style={styles.eng}>{dashCompact(c.engagements28d)}</Text>
                    <Text style={styles.viewsLabel}>engage</Text>
                  </View>
                </View>
              ))
            )}
          </Card>
          <Text style={styles.note}>
            A dash means Meta doesn't publish that metric for the channel — not zero. "Today (so far)" is
            Instagram-only; Facebook publishes completed days only.
          </Text>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.cardHigh,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 15,
    color: colors.ink,
    marginBottom: spacing.md,
  },
  tileRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  tile: {
    flex: 1,
    backgroundColor: colors.cardHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
  },
  tileValue: { fontSize: 18, fontWeight: "700", color: colors.ink },
  tileLabel: { fontSize: 10, color: colors.sub, marginTop: 2, textAlign: "center" },
  dataThrough: { fontSize: 11, color: colors.faint, marginBottom: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  avatar: { width: 40, height: 40, borderRadius: radius.full },
  avatarFallback: { backgroundColor: colors.purpleSoft, alignItems: "center", justifyContent: "center" },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink, flexShrink: 1 },
  sub: { fontSize: 11, color: colors.sub, marginTop: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" },
  followers: { fontSize: 11, fontWeight: "600", color: colors.ink },
  delta: { fontSize: 11, fontWeight: "700" },
  views: { fontSize: 14, fontWeight: "700", color: colors.purple },
  eng: { fontSize: 12, fontWeight: "700", color: colors.ink, marginTop: 2 },
  viewsLabel: { fontSize: 9, color: colors.sub },
  note: { fontSize: 11, color: colors.faint, marginTop: 4, lineHeight: 16 },
});
