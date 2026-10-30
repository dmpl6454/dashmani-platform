import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ApiError, apiFetch, apiFetchPage, describeError, fmtCompact, withQuery } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Chips, Field, IconButton, Screen, useApi, useDebounce } from "@/components/ui";
import type { ApiStatus } from "@/components/ui";
import { ListItem } from "@/components/list";
import { PagedList } from "@/components/async";
import { platformIcon } from "@/lib/report-links";

// ---------- cursor pager (GET list endpoints with limit/cursor + meta.has_more) ----------
type PagedState<T> = {
  items: T[];
  status: ApiStatus;
  error: string | null;
  errorCode: string | null;
  errorStatus: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
};

function initialPaged<T>(): PagedState<T> {
  return {
    items: [],
    status: "loading",
    error: null,
    errorCode: null,
    errorStatus: null,
    hasMore: false,
    loadingMore: false,
    refreshing: false,
  };
}

function errorFields(e: unknown): { error: string; errorCode: string | null; errorStatus: number | null } {
  return {
    error: describeError(e),
    errorCode: e instanceof ApiError ? (e.code ?? null) : null,
    errorStatus: e instanceof ApiError ? (e.status ?? null) : null,
  };
}

function usePagedList<T extends { id: string }>(path: string) {
  const [state, setState] = useState<PagedState<T>>(initialPaged);
  const seqRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const itemsRef = useRef<T[]>([]);
  const busyMoreRef = useRef(false);
  const lastFailRef = useRef<"first" | "more">("first");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchFirst = useCallback(
    async (mode: "reset" | "refresh"): Promise<void> => {
      const seq = ++seqRef.current;
      busyMoreRef.current = false;
      if (mode === "reset") {
        itemsRef.current = [];
        cursorRef.current = null;
        setState(initialPaged<T>());
      } else {
        setState((s) => ({ ...s, refreshing: true, loadingMore: false }));
      }
      try {
        const page = await apiFetchPage<T>(path);
        if (!mountedRef.current || seq !== seqRef.current) return;
        itemsRef.current = page.items;
        cursorRef.current = page.meta.cursor ?? null;
        setState({
          items: page.items,
          status: "ok",
          error: null,
          errorCode: null,
          errorStatus: null,
          hasMore: page.meta.has_more && cursorRef.current !== null,
          loadingMore: false,
          refreshing: false,
        });
      } catch (e: unknown) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        lastFailRef.current = "first";
        setState((s) => ({
          ...s,
          ...errorFields(e),
          status: itemsRef.current.length > 0 ? "ok" : "failed",
          refreshing: false,
        }));
      }
    },
    [path],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = cursorRef.current;
    if (busyMoreRef.current || !cursor) return;
    const seq = seqRef.current;
    busyMoreRef.current = true;
    setState((s) => ({ ...s, loadingMore: true }));
    try {
      const page = await apiFetchPage<T>(withQuery(path, { cursor }));
      if (!mountedRef.current || seq !== seqRef.current) return;
      const seen = new Set(itemsRef.current.map((x) => x.id));
      const merged = itemsRef.current.concat(page.items.filter((x) => !seen.has(x.id)));
      itemsRef.current = merged;
      cursorRef.current = page.meta.cursor ?? null;
      setState((s) => ({
        ...s,
        items: merged,
        hasMore: page.meta.has_more && cursorRef.current !== null,
        loadingMore: false,
        error: null,
        errorCode: null,
        errorStatus: null,
      }));
    } catch (e: unknown) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      lastFailRef.current = "more";
      setState((s) => ({ ...s, ...errorFields(e), loadingMore: false }));
    } finally {
      if (seq === seqRef.current) busyMoreRef.current = false;
    }
  }, [path]);

  useEffect(() => {
    void fetchFirst("reset");
  }, [fetchFirst]);

  const refresh = useCallback(() => {
    void fetchFirst("refresh");
  }, [fetchFirst]);

  const retry = useCallback(() => {
    if (lastFailRef.current === "more" && itemsRef.current.length > 0) void loadMore();
    else void fetchFirst(itemsRef.current.length > 0 ? "refresh" : "reset");
  }, [fetchFirst, loadMore]);

  const onEndReached = useCallback(() => {
    void loadMore();
  }, [loadMore]);

  return { ...state, refresh, retry, onEndReached };
}

// ---------- screen ----------
type Platform = { id: string; name?: string | null; slug?: string | null };

type Account = {
  id: string;
  displayName?: string | null;
  handle?: string | null;
  followerCount?: number | null;
  platform?: { id?: string; name?: string | null; slug?: string | null } | null;
  assignments?: Array<{ employee?: { name?: string | null } | null } | null> | null;
};

const ALL = "all";
const PAGE_SIZE = 50;

function cleanHandle(handle: string | null | undefined): string {
  return (handle ?? "").split("?")[0].replace(/^@/, "").trim();
}

function assigneesOf(a: Account): string {
  return (a.assignments ?? [])
    .map((x) => x?.employee?.name ?? "")
    .filter(Boolean)
    .join(", ");
}

function subtitleOf(a: Account): string {
  const handle = cleanHandle(a.handle);
  const first = [
    handle ? `@${handle}` : a.platform?.name ?? "",
    a.followerCount != null ? `${fmtCompact(a.followerCount)} followers` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const assignees = assigneesOf(a);
  return `${first}\n${assignees ? `Assigned to ${assignees}` : "Unassigned"}`;
}

export default function AdminAccounts() {
  const [search, setSearch] = useState("");
  const [platformId, setPlatformId] = useState<string>(ALL);
  const query = useDebounce(search.trim(), 300);

  const platforms = useApi<Platform[]>(() => apiFetch<Platform[]>("/platforms"));
  const platformList = platforms.data ?? [];
  const platformOptions: string[] = [ALL, ...platformList.map((p) => p.id)];
  const platformLabels: Record<string, string> = { [ALL]: "All" };
  platformList.forEach((p) => {
    platformLabels[p.id] = p.name ?? "Platform";
  });

  const path = withQuery("/accounts", {
    limit: PAGE_SIZE,
    search: query,
    platformId: platformId === ALL ? undefined : platformId,
  });
  const list = usePagedList<Account>(path);

  const filterActive = query !== "" || platformId !== ALL;
  const clearFilters = () => {
    setSearch("");
    setPlatformId(ALL);
  };

  const n = list.items.length;
  const countLabel = list.hasMore ? `Showing ${n} · more` : `${n} ${n === 1 ? "account" : "accounts"}`;

  const header = (
    <View style={styles.header}>
      <Field
        value={search}
        onChangeText={setSearch}
        placeholder="Search accounts"
        leading="search-outline"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Search accounts"
        trailing={
          search ? (
            <IconButton
              icon="close-circle"
              label="Clear search"
              onPress={() => setSearch("")}
              tint={colors.tertiary}
              size={36}
              glyph={18}
            />
          ) : undefined
        }
      />
      {platformOptions.length > 2 ? (
        <Chips
          options={platformOptions}
          value={platformId}
          onChange={setPlatformId}
          labels={platformLabels}
          mode="pills"
          accessibilityLabel="Platform"
        />
      ) : null}
      {list.status === "ok" && n > 0 ? <Text style={styles.count}>{countLabel}</Text> : null}
    </View>
  );

  return (
    <Screen scroll={false}>
      <PagedList<Account>
        items={list.items}
        status={list.status}
        error={list.error}
        errorCode={list.errorCode}
        errorStatus={list.errorStatus}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        onEndReached={list.onEndReached}
        onRetry={list.retry}
        onRefresh={list.refresh}
        refreshing={list.refreshing}
        grouped
        header={header}
        keyExtractor={(a) => a.id}
        renderItem={(a) => {
          const glyph = platformIcon(a.platform?.slug ?? a.platform?.name);
          const title = a.displayName?.trim() || cleanHandle(a.handle) || "Account";
          const sub = subtitleOf(a);
          return (
            <ListItem
              icon={glyph.icon}
              tint={glyph.tint}
              title={title}
              subtitle={sub}
              lines={1}
              accessibilityLabel={[title, a.platform?.name ?? "", sub.replace("\n", ", ")].filter(Boolean).join(", ")}
            />
          );
        }}
        empty={
          filterActive
            ? {
                icon: "search-outline",
                title: "No matches",
                text: query ? `No accounts match "${query}".` : "No accounts on this platform.",
                action: { label: "Clear filters", onPress: clearFilters },
              }
            : { icon: "at-outline", title: "No accounts yet", text: "Accounts added in the portal appear here." }
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.md, marginBottom: spacing.md },
  count: { ...type.footnote, color: colors.sub },
});
