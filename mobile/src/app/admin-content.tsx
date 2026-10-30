import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetchPage, fmtDateTime, withQuery } from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import { useApi } from "@/lib/hooks/useApi";
import { Chips, Screen, StatusPill } from "@/components/ui";
import { ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";

const FILTERS = ["ALL", "DRAFT", "PENDING_APPROVAL", "APPROVED", "PUBLISHED"] as const;
type Filter = (typeof FILTERS)[number];

const PAGE_LIMIT = 100;

type ContentPost = {
  id: string;
  title?: string | null;
  caption?: string | null;
  status?: string | null;
  format?: string | null;
  scheduledFor?: string | null;
  platform?: { name?: string | null } | string | null;
  project?: { name?: string | null } | null;
};

function platformName(p: ContentPost): string {
  if (!p.platform) return "";
  if (typeof p.platform === "string") return p.platform;
  return p.platform.name ?? "";
}

function subtitleOf(p: ContentPost): string | undefined {
  const first = [platformName(p), p.format ? formatStatus(p.format) : ""].filter(Boolean).join(" · ");
  const second = [
    p.scheduledFor ? `Scheduled ${fmtDateTime(p.scheduledFor)}` : "",
    p.project?.name ? `Project: ${p.project.name}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [first, second].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export default function AdminContent() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [hasMore, setHasMore] = useState(false);
  const state = useApi<ContentPost[]>(
    async () => {
      const page = await apiFetchPage<ContentPost>(
        withQuery("/content", { limit: PAGE_LIMIT, status: filter !== "ALL" ? filter : null }),
      );
      setHasMore(page.meta.has_more);
      return page.items;
    },
    [filter],
  );

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        header={
          <Chips
            options={FILTERS}
            value={filter}
            onChange={setFilter}
            labels={{ ALL: "All", PENDING_APPROVAL: "Pending" }}
            accessibilityLabel="Filter by status"
          />
        }
        filterActive={filter !== "ALL"}
        onClearFilter={() => setFilter("ALL")}
        keyExtractor={(p) => p.id}
        empty={{ icon: "images-outline", title: "No content posts", text: "Posts planned on the web portal show up here." }}
        footer={
          hasMore ? (
            <Text maxFontSizeMultiplier={1.6} style={styles.note}>
              {`Showing the latest ${PAGE_LIMIT} posts. See the full calendar on the web portal.`}
            </Text>
          ) : null
        }
        renderItem={(p) => (
          <ListItem
            icon="images-outline"
            tint="pink"
            title={p.title ?? p.caption ?? "Untitled"}
            subtitle={subtitleOf(p)}
            trailing={p.status ? <StatusPill size="sm" status={p.status} /> : undefined}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.sm },
});
