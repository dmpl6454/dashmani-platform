import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, apiFetchPage, describeError, withQuery } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Avatar, Chips, Field, IconButton, Screen, StatusPill, useDebounce } from "@/components/ui";
import type { ApiStatus } from "@/components/ui";
import { ListItem } from "@/components/list";
import { PagedList } from "@/components/async";

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
type Employee = {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string | null;
  profileImageUrl?: string | null;
  orgUnit?: { name?: string | null } | null;
  roles?: Array<{ name?: string | null; role?: { name?: string | null } | null } | null> | null;
};

const STATUSES = ["ALL", "ACTIVE", "ONBOARDING", "INACTIVE"] as const;
type StatusFilter = (typeof STATUSES)[number];
const STATUS_LABELS: Record<StatusFilter, string> = {
  ALL: "All",
  ACTIVE: "Active",
  ONBOARDING: "Onboarding",
  INACTIVE: "Inactive",
};

const PAGE_SIZE = 50;

function roleNames(e: Employee): string {
  return (e.roles ?? [])
    .map((r) => r?.name ?? r?.role?.name ?? "")
    .filter(Boolean)
    .join(", ");
}

function subtitleOf(e: Employee): string {
  const designation = roleNames(e) || e.orgUnit?.name || "";
  const contact = e.email ?? e.phone ?? "";
  return [designation, contact].filter(Boolean).join(" · ");
}

export default function AdminEmployees() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const query = useDebounce(search.trim(), 300);

  const path = withQuery("/employees", {
    limit: PAGE_SIZE,
    search: query,
    status: status === "ALL" ? undefined : status,
  });
  const list = usePagedList<Employee>(path);

  const filterActive = query !== "" || status !== "ALL";
  const clearFilters = () => {
    setSearch("");
    setStatus("ALL");
  };

  const n = list.items.length;
  const countLabel = list.hasMore ? `Showing ${n} · more` : `${n} ${n === 1 ? "employee" : "employees"}`;

  const header = (
    <View style={styles.header}>
      <Field
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name or email"
        leading="search-outline"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Search employees"
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
      <Chips
        options={STATUSES}
        value={status}
        onChange={setStatus}
        labels={STATUS_LABELS}
        accessibilityLabel="Employee status"
      />
      {list.status === "ok" && n > 0 ? <Text style={styles.count}>{countLabel}</Text> : null}
    </View>
  );

  return (
    <Screen scroll={false}>
      <PagedList<Employee>
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
        keyExtractor={(e) => e.id}
        renderItem={(e) => {
          const name = e.name?.trim() || "Unnamed";
          const sub = subtitleOf(e);
          return (
            <ListItem
              leading={<Avatar name={name} uri={e.profileImageUrl} />}
              title={name}
              subtitle={sub || undefined}
              trailing={e.status ? <StatusPill status={e.status} size="sm" /> : undefined}
              onPress={() => router.push(`/admin-employee/${e.id}?name=${encodeURIComponent(e.name ?? "")}`)}
              accessibilityLabel={[name, sub, e.status ? STATUS_LABELS[e.status as StatusFilter] ?? e.status : ""]
                .filter(Boolean)
                .join(", ")}
              accessibilityHint="Opens the employee's profile"
            />
          );
        }}
        empty={
          filterActive
            ? {
                icon: "search-outline",
                title: "No matches",
                text: query ? `No employees match "${query}".` : "No employees have this status.",
                action: { label: "Clear filters", onPress: clearFilters },
              }
            : { icon: "people-outline", title: "No employees yet", text: "Employees added in the portal appear here." }
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.md, marginBottom: spacing.md },
  count: { ...type.footnote, color: colors.sub },
});
