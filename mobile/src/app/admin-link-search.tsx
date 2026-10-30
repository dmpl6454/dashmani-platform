import React, { useRef, useState } from "react";
import { Linking, StyleSheet, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, errorMessage, fmtDay } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Card, Empty, ErrorBanner, Field, IconButton, Screen, SectionTitle } from "@/components/ui";
import { ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { SkeletonList, SkeletonStatRow } from "@/components/skeleton";
import { toast } from "@/components/feedback";

const MAX_ROWS = 50;

type Post = {
  linkId?: string | null;
  url?: string | null;
  platform?: string | null;
  employee?: { name?: string | null } | null;
  account?: { displayName?: string | null } | null;
  date?: string | null;
  reportDate?: string | null;
  dupCount?: number | null;
};

type SearchResult = {
  entity?: { canonicalName?: string | null } | null;
  posts?: Post[] | null;
  links?: Post[] | null;
  totalPosts?: number | null;
  uniquePosts?: number | null;
  duplicatePosts?: number | null;
  channelCount?: number | null;
  coverage?: { searchable?: number | null; submitted?: number | null } | null;
};

/** The answer on screen and the term it answers (so copy never reads the live input). */
type Answer = { term: string; data: SearchResult };

function openLink(url: string): void {
  Linking.openURL(url).catch(() => toast.show({ message: "Couldn't open this link", tone: "danger" }));
}

function postMeta(p: Post): string {
  const day = p.date ?? p.reportDate;
  return [
    p.platform || null,
    p.employee?.name || null,
    p.account?.displayName || null,
    day ? fmtDay(day, { weekday: false, year: true }) : null,
    p.dupCount != null && p.dupCount > 1 ? `×${p.dupCount}` : null,
  ]
    .filter((s): s is string => !!s)
    .join(" · ");
}

function count(n: number | null | undefined): string | number {
  return n == null ? "—" : n;
}

export default function AdminLinkSearch() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const search = async () => {
    const term = q.trim();
    if (!term) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<SearchResult>(`/admin/link-search?q=${encodeURIComponent(term)}`);
      if (seq === seqRef.current) setAnswer({ term, data: res });
    } catch (e) {
      if (seq === seqRef.current) setError(errorMessage(e, "Search failed"));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  };

  const result = answer?.data ?? null;
  const posts: Post[] = result?.posts ?? result?.links ?? [];
  const shown = posts.slice(0, MAX_ROWS);
  const cov = result?.coverage;

  return (
    <Screen>
      <Text maxFontSizeMultiplier={1.6} style={styles.intro}>
        Search uploaded links by who or what the post is about — e.g. &quot;Salman Khan&quot;.
      </Text>
      <Field
        value={q}
        onChangeText={setQ}
        placeholder="Person, brand or topic"
        accessibilityLabel="Search links by person, brand or topic"
        leading="search-outline"
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => void search()}
        trailing={
          <IconButton
            icon="arrow-forward"
            label="Search"
            variant="filled"
            size={36}
            glyph={18}
            onPress={() => void search()}
            disabled={!q.trim() || loading}
          />
        }
      />

      {error ? <ErrorBanner message={error} onRetry={() => void search()} style={styles.banner} /> : null}

      {loading ? (
        <>
          <SkeletonStatRow count={2} />
          <SkeletonList rows={5} />
        </>
      ) : answer && result ? (
        <>
          {result.entity ? (
            <>
              <SectionTitle>{result.entity.canonicalName ?? answer.term}</SectionTitle>
              <StatGrid columns={2} style={styles.stats}>
                <StatTile
                  label="Total posts"
                  value={result.totalPosts ?? posts.length}
                  valueColor={colors.purpleText}
                />
                <StatTile label="Unique" value={count(result.uniquePosts)} />
                <StatTile label="Duplicates" value={count(result.duplicatePosts)} />
                <StatTile label="Channels" value={count(result.channelCount)} />
              </StatGrid>
            </>
          ) : (
            <Card>
              <Empty
                icon="search-outline"
                title="No match"
                text={`No entity found for "${answer.term}" — try a different spelling`}
              />
            </Card>
          )}

          {shown.length > 0 ? (
            <ListGroup
              footer={
                posts.length > MAX_ROWS
                  ? `Showing ${MAX_ROWS} of ${posts.length} — refine on the web portal`
                  : undefined
              }
            >
              {shown.map((p, i) => {
                const url = p.url ?? "";
                const meta = postMeta(p);
                return (
                  <ListItem
                    key={p.linkId ?? (url ? `${url}#${i}` : String(i))}
                    title={url || "No URL"}
                    subtitle={meta || undefined}
                    chevron={false}
                    trailing={
                      url ? (
                        <Ionicons name="open-outline" size={16} color={colors.faint} style={styles.openIcon} />
                      ) : undefined
                    }
                    onPress={url ? () => openLink(url) : undefined}
                    accessibilityLabel={meta ? `${url || "No URL"}, ${meta}` : url || "No URL"}
                    accessibilityHint="Opens the post"
                  />
                );
              })}
            </ListGroup>
          ) : null}

          {cov ? (
            <Text maxFontSizeMultiplier={1.6} style={styles.coverage}>
              Coverage: {cov.searchable ?? "—"} searchable of {cov.submitted ?? "—"} submitted links.
            </Text>
          ) : null}
        </>
      ) : error ? null : (
        <Card>
          <Empty icon="search-outline" text="Search for a celebrity, brand or topic" />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { ...type.footnote, color: colors.sub, marginBottom: spacing.sm },
  banner: { marginTop: spacing.sm },
  stats: { marginBottom: spacing.md },
  openIcon: { marginLeft: spacing.sm },
  coverage: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.sm },
});
