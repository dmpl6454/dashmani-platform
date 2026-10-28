import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, Image, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtCompact, fmtDate, fmtDateTime } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

// Overview — the phone-sized version of portal.digitalsukoon.com/overview (GET /admin/overview,
// open to every internal user). Same accuracy rules as the web page:
//  • a figure nobody reported is null and renders "—", never 0, with the reason beside it;
//  • reach exists only for Meta's own 7-day and 28-day windows (unique people cannot be summed);
//  • every window ends on the last CLOSED day (the server's dataThroughDay), which is said on screen;
//  • revenue is USD (Meta pays in dollars).

const PERIODS = ["7", "14", "30", "90"] as const;
type Period = (typeof PERIODS)[number];

type Channel = {
  id: string;
  metaId: string;
  name: string;
  username: string | null;
  platform: "facebook" | "instagram";
  pictureUrl?: string | null;
  followers: number | null;
  views: number | null;
  earningsCents: number | null;
};

const dash = (n: number | null | undefined) => (n == null ? "—" : fmtCompact(n));

function fmtUsd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const d = cents / 100;
  if (d >= 1000) return "$" + fmtCompact(Math.round(d));
  return "$" + d.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Facebook opens by its numeric Page id (always present, permanent); Instagram by username (no id URL exists). */
function metaUrl(c: { platform: string; metaId: string; username: string | null }): string | null {
  if (c.platform === "facebook") return /^\d+$/.test(c.metaId) ? `https://www.facebook.com/${c.metaId}` : null;
  return c.username ? `https://www.instagram.com/${encodeURIComponent(c.username)}/` : null;
}

function Trend({ trend }: { trend?: { pct: number | null; reliable: boolean } | null }) {
  if (!trend || trend.pct == null) return null;
  const up = trend.pct >= 0;
  return (
    <Text style={[styles.trend, { color: up ? colors.green : colors.red }]}>
      {up ? "▲" : "▼"} {Math.abs(trend.pct).toFixed(1)}%{trend.reliable ? "" : "*"}
    </Text>
  );
}

function Kpi({ label, value, note, trend }: { label: string; value: string; note?: string; trend?: any }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.kpiValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Trend trend={trend} />
      {note ? <Text style={styles.kpiNote} numberOfLines={3}>{note}</Text> : null}
    </View>
  );
}

export default function AdminOverview() {
  const [period, setPeriod] = useState<Period>("30");
  const [tab, setTab] = useState<"all" | "facebook" | "instagram">("all");

  const { data: o, loading, refreshing, error, refresh } = useApi<any>(
    () => apiFetch(`/admin/overview?days=${period}`),
    [period],
  );

  const k = o?.kpis;
  const days = o?.period?.days ?? Number(period);
  const reachNote =
    k?.reach?.value == null
      ? `Meta publishes no ${days}-day reach — pick 7 or 30 days.`
      : `Unique accounts summed across channels (Meta's ${k.reach.window === "week" ? "7-day" : "28-day"} window).`;
  const followersNote =
    k?.followers?.delta != null
      ? `${k.followers.delta >= 0 ? "+" : ""}${fmtCompact(k.followers.delta)} over ${k.followers.deltaDays}d · measured over ${k.followers.channelsWithHistory ?? 0}/${o?.channels?.total ?? "—"} channels`
      : "Follower history doesn't cover this period yet.";
  const revenueNote =
    k?.revenue?.value != null ? `${k.revenue.earning ?? 0} Pages earned · USD` : "No channel reported earnings.";

  const top: Channel[] =
    (tab === "facebook" ? o?.topChannelsFacebook : tab === "instagram" ? o?.topChannelsInstagram : o?.topChannels) ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={PERIODS} value={period} onChange={setPeriod} labels={{ "7": "7 days", "14": "14 days", "30": "30 days", "90": "90 days" }} />
      <ErrorBanner message={error} />

      {loading && !o ? (
        <Loading />
      ) : o ? (
        <>
          <Text style={styles.window}>
            {fmtDate(o.period?.start)} – {fmtDate(o.period?.end)} · figures through {fmtDate(o.period?.dataThroughDay)}
            {o.channels ? ` · ${o.channels.total} channels (${o.channels.complete} complete for the period${o.channels.errored ? `, ${o.channels.errored} with errors` : ""})` : ""}
          </Text>

          <View style={styles.kpiGrid}>
            <Kpi label="Views" value={dash(k?.views?.value)} trend={k?.views?.trend} note={k?.views?.value == null ? "No channel reported views." : undefined} />
            <Kpi label="Engagements" value={dash(k?.engagements?.value)} trend={k?.engagements?.trend} />
            <Kpi label="Total reach" value={dash(k?.reach?.value)} note={reachNote} />
            <Kpi label="Followers (now)" value={dash(k?.followers?.value)} note={followersNote} />
            <Kpi label="Revenue" value={fmtUsd(k?.revenue?.value)} trend={k?.revenue?.trend} note={revenueNote} />
          </View>
          <Text style={styles.foot}>
            ▲▼ compare with the {days} days before. * = the earlier period isn't fully covered, so treat that trend as rough. A dash means
            nothing was reported — not zero.
          </Text>

          <SectionTitle>Top channels · views</SectionTitle>
          <Chips options={["all", "facebook", "instagram"] as const} value={tab} onChange={setTab} labels={{ all: "All", facebook: "Facebook", instagram: "Instagram" }} />
          <Card>
            {top.length === 0 ? (
              <Empty icon="stats-chart-outline" text="No channel reported views for this period" />
            ) : (
              top.map((c, i) => {
                const url = metaUrl(c);
                return (
                  <Pressable key={c.id} disabled={!url} onPress={() => url && Linking.openURL(url)}>
                    <View style={[styles.row, i === top.length - 1 && { borderBottomWidth: 0 }]}>
                      <Text style={styles.rank}>{i + 1}</Text>
                      {c.pictureUrl ? (
                        <Image source={{ uri: c.pictureUrl }} style={styles.avatar} />
                      ) : (
                        <View style={[styles.avatar, styles.avatarFallback]}>
                          <Ionicons name={c.platform === "instagram" ? "logo-instagram" : "logo-facebook"} size={16} color={colors.purple} />
                        </View>
                      )}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
                        <Text style={styles.sub} numberOfLines={1}>
                          {dash(c.followers)} followers{c.earningsCents ? ` · ${fmtUsd(c.earningsCents)}` : ""}
                        </Text>
                      </View>
                      <Text style={styles.views}>{dash(c.views)}</Text>
                      {url ? <Ionicons name="open-outline" size={14} color={colors.faint} /> : null}
                    </View>
                  </Pressable>
                );
              })
            )}
          </Card>

          <SectionTitle>Latest posts</SectionTitle>
          <Card>
            {(o.latestPosts ?? []).length === 0 ? (
              <Empty icon="images-outline" text="No posts synced yet" />
            ) : (
              (o.latestPosts as any[]).slice(0, 8).map((p, i, arr) => (
                <Pressable key={p.id} disabled={!p.permalink} onPress={() => p.permalink && Linking.openURL(p.permalink)}>
                  <View style={[styles.row, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                    {p.thumbnailUrl ? (
                      <Image source={{ uri: p.thumbnailUrl }} style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, styles.avatarFallback]}>
                        <Ionicons name="image-outline" size={16} color={colors.purple} />
                      </View>
                    )}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.name} numberOfLines={2}>{p.title || "(no caption)"}</Text>
                      <Text style={styles.sub} numberOfLines={1}>
                        {p.channel?.platform === "instagram" ? "IG" : "FB"} · {p.channel?.name} · {fmtDateTime(p.postedAt)}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.views}>{dash(p.views)}</Text>
                      <Text style={styles.viewsLabel}>views</Text>
                    </View>
                  </View>
                </Pressable>
              ))
            )}
          </Card>
          <Text style={styles.foot}>Synced from the connected Meta account about every 3 hours.</Text>

          <SectionTitle>What's trending</SectionTitle>
          <Card>
            {(o.trending ?? []).length === 0 ? (
              <Empty icon="flame-outline" text="Nothing trending this week" />
            ) : (
              (o.trending as any[]).slice(0, 8).map((t, i, arr) => (
                <View key={t.id} style={[styles.row, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                  <Text style={styles.rank}>{i + 1}</Text>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>{t.name}</Text>
                    <Text style={styles.sub}>{t.count.toLocaleString("en-IN")} posts this week</Text>
                  </View>
                  {t.changePct == null ? (
                    <Text style={[styles.trend, { color: colors.purple }]}>new</Text>
                  ) : (
                    <Text style={[styles.trend, { color: t.changePct >= 0 ? colors.green : colors.red }]}>
                      {t.changePct >= 0 ? "▲" : "▼"} {Math.abs(t.changePct).toFixed(0)}%
                    </Text>
                  )}
                </View>
              ))
            )}
          </Card>
          <Text style={styles.foot}>
            From captions harvested from our connected channels' feeds, not only the links the team submitted. The change compares each
            topic's share of this week's captions with last week's
            {o.trendingWindow ? ` (${o.trendingWindow.captionsThisWeek.toLocaleString("en-IN")} vs ${o.trendingWindow.captionsLastWeek.toLocaleString("en-IN")} captions)` : ""}.
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  window: { fontSize: 12, color: colors.sub, marginBottom: spacing.md, lineHeight: 17 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  kpi: {
    flexBasis: "48%",
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 96,
  },
  kpiLabel: { fontSize: 12, color: colors.sub, fontWeight: "600" },
  kpiValue: { fontSize: 24, fontWeight: "700", color: colors.ink, marginTop: 4, fontVariant: ["tabular-nums"] },
  kpiNote: { fontSize: 11, color: colors.faint, marginTop: 4, lineHeight: 15 },
  trend: { fontSize: 12, fontWeight: "700", marginTop: 2 },
  foot: { fontSize: 11, color: colors.faint, marginTop: 6, lineHeight: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rank: { width: 18, fontSize: 13, fontWeight: "700", color: colors.sub, textAlign: "center" },
  avatar: { width: 34, height: 34, borderRadius: radius.full },
  thumb: { width: 44, height: 44, borderRadius: 8 },
  avatarFallback: { backgroundColor: colors.purpleSoft, alignItems: "center", justifyContent: "center" },
  name: { fontSize: 14, fontWeight: "600", color: colors.ink },
  sub: { fontSize: 11, color: colors.sub, marginTop: 2 },
  views: { fontSize: 14, fontWeight: "700", color: colors.purple, fontVariant: ["tabular-nums"] },
  viewsLabel: { fontSize: 9, color: colors.sub },
});
