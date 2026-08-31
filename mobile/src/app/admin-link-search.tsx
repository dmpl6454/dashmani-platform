import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, Empty, Loading, ErrorBanner, Button } from "@/components/ui";

export default function AdminLinkSearch() {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<any>(`/admin/link-search?q=${encodeURIComponent(q.trim())}`);
      setResult(res);
    } catch (e: any) {
      setError(e?.message || "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const posts: any[] = result?.posts ?? result?.links ?? [];
  const cov = result?.coverage;

  return (
    <Screen>
      <Text style={styles.intro}>
        Search uploaded links by who or what the post is about — e.g. "Salman Khan".
      </Text>
      <View style={styles.searchRow}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Person, brand or topic…"
          placeholderTextColor={colors.faint}
          style={styles.search}
          autoCapitalize="words"
          onSubmitEditing={search}
          returnKeyType="search"
        />
        <Pressable onPress={search} style={styles.searchBtn}>
          <Ionicons name="search" size={18} color="#fff" />
        </Pressable>
      </View>
      <ErrorBanner message={error} />

      {loading ? (
        <Loading />
      ) : result ? (
        <>
          {result.entity ? (
            <>
              <SectionTitle>{result.entity.canonicalName ?? q}</SectionTitle>
              <View style={styles.statRow}>
                <Stat label="Total Posts" value={result.totalPosts ?? posts.length} accent={colors.purple} />
                <Stat label="Unique" value={result.uniquePosts ?? "—"} />
                <Stat label="Duplicates" value={result.duplicatePosts ?? "—"} />
                <Stat label="Channels" value={result.channelCount ?? "—"} />
              </View>
            </>
          ) : (
            <Card><Empty icon="search-outline" text={`No entity found for "${q}" — try a different spelling`} /></Card>
          )}

          {posts.length > 0 && (
            <Card>
              {posts.slice(0, 50).map((p: any, i: number) => (
                <Pressable key={p.linkId ?? p.url ?? i} onPress={() => p.url && Linking.openURL(p.url)}>
                  <View style={[styles.row, i === Math.min(posts.length, 50) - 1 && { borderBottomWidth: 0 }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.url} numberOfLines={1}>{p.url}</Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {p.platform ?? ""} · {p.employee?.name ?? ""}{p.account?.displayName ? ` · ${p.account.displayName}` : ""} · {fmtDate(p.date ?? p.reportDate)}
                        {p.dupCount > 1 ? ` · ×${p.dupCount}` : ""}
                      </Text>
                    </View>
                    <Ionicons name="open-outline" size={14} color={colors.faint} />
                  </View>
                </Pressable>
              ))}
              {posts.length > 50 && <Text style={styles.more}>Showing 50 of {posts.length} — refine on the web portal</Text>}
            </Card>
          )}

          {cov ? (
            <Text style={styles.coverage}>
              Coverage: {cov.searchable ?? "—"} searchable of {cov.submitted ?? "—"} submitted links.
            </Text>
          ) : null}
        </>
      ) : (
        <Card><Empty icon="search-outline" text="Search for a celebrity, brand or topic" /></Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 12, color: colors.sub, marginBottom: spacing.sm },
  searchRow: { flexDirection: "row", gap: 8, marginBottom: spacing.md },
  search: {
    flex: 1, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    backgroundColor: colors.cardHigh, paddingHorizontal: 12, height: 46, fontSize: 15, color: colors.ink,
  },
  searchBtn: { width: 46, height: 46, borderRadius: radius.md, backgroundColor: colors.purple, alignItems: "center", justifyContent: "center" },
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  url: { fontSize: 12, color: colors.purple },
  meta: { fontSize: 11, color: colors.sub, marginTop: 2 },
  more: { fontSize: 11, color: colors.faint, textAlign: "center", paddingTop: 8 },
  coverage: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: 4 },
});
