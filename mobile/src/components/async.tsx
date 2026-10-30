// Async state renderers — the one place that decides skeleton vs failure vs empty vs data.
//
// Rule: only a LOADED answer may claim emptiness. A failed request with nothing to show
// renders <LoadFailed/> with Retry; a failed refetch over existing data shows a slim
// ErrorBanner above the data.
//
//   <AsyncList state={tasks} grouped renderItem={…} keyExtractor={(t) => t.id}
//              empty={{ title: "No tasks", text: "…" }} />
//   <AsyncBlock state={detail}>{(d) => <…/>}</AsyncBlock>
//   <Screen scroll={false}><PagedList items={…} status={…} … /></Screen>
import React, { useContext } from "react";
import { ActivityIndicator, FlatList, Platform, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { colors, radius, spacing } from "@/lib/theme";
import type { Tone } from "@/lib/theme";
import type { ApiStatus, UseApiResult } from "@/lib/hooks/useApi";
import {
  Button,
  Empty,
  ErrorBanner,
  LoadFailed,
  Row,
  SectionTitle,
  SurfaceContext,
  type IoniconName,
} from "@/components/ui";
import { SkeletonCard, SkeletonList, SkeletonStatRow } from "@/components/skeleton";
import { ListGroup, ListItem } from "@/components/list";

const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

export type AsyncEmpty = {
  icon?: IoniconName;
  title: string;
  text?: string;
  action?: { label: string; onPress: () => void };
  tone?: Tone;
};

export type SkeletonKind = "rows" | "cards" | "stats";

// ---------- helpers ----------
function isSkeletonKind(v: unknown): v is SkeletonKind {
  return v === "rows" || v === "cards" || v === "stats";
}

function skeletonFor(s: SkeletonKind | React.ReactNode | undefined, count?: number): React.ReactNode {
  if (s === undefined || s === null) return <SkeletonList rows={count ?? 4} />;
  if (isSkeletonKind(s)) {
    if (s === "cards") {
      const n = Math.max(1, Math.floor(count ?? 3));
      return (
        <>
          {Array.from({ length: n }, (_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </>
      );
    }
    if (s === "stats") {
      return (
        <>
          <SkeletonStatRow count={2} />
          <SkeletonList rows={count ?? 3} />
        </>
      );
    }
    return <SkeletonList rows={count ?? 4} />;
  }
  return s;
}

/** Give a rendered row a key without hiding its element type (ListGroup inspects it). */
function keyed(node: React.ReactNode, key: string): React.ReactNode {
  if (React.isValidElement<Record<string, unknown>>(node)) return React.cloneElement(node, { key });
  return <React.Fragment key={key}>{node}</React.Fragment>;
}

/** Mark the last ListItem / Row of a hand-built group so it draws no hairline. */
function markLast(node: React.ReactNode): React.ReactNode {
  if (!React.isValidElement<{ last?: boolean }>(node)) return node;
  if (node.type !== ListItem && node.type !== Row) return node;
  if (node.props.last !== undefined) return node;
  return React.cloneElement(node, { last: true });
}

// ---------- AsyncList ----------
export type AsyncListProps<T> = {
  state: UseApiResult<T[]>;
  renderItem: (item: T, i: number, all: T[]) => React.ReactNode;
  keyExtractor: (item: T, i: number) => string;
  empty: AsyncEmpty;
  /** first-load placeholder (default "rows") */
  skeleton?: SkeletonKind | React.ReactNode;
  skeletonCount?: number;
  /** rows inside a grouped card (ListGroup) */
  grouped?: boolean;
  /** rendered above the list in every state (e.g. filter chips) */
  header?: React.ReactNode;
  /** rendered under the items once loaded */
  footer?: React.ReactNode;
  /** a filter is applied → an empty answer reads "No matches" (+ "Show all") */
  filterActive?: boolean;
  /** the visible (e.g. client-filtered) subset of state.data; default state.data */
  items?: T[];
  /** split the visible items into titled groups (order of first appearance) */
  sectionOf?: (item: T, i: number) => string;
  /** "Show all" action of the filtered empty state (default: empty.action's handler) */
  onClearFilter?: () => void;
};

export function AsyncList<T>({
  state,
  renderItem,
  keyExtractor,
  empty,
  skeleton,
  skeletonCount,
  grouped = false,
  header,
  footer,
  filterActive = false,
  items,
  sectionOf,
  onClearFilter,
}: AsyncListProps<T>): React.ReactElement {
  const data = state.data;
  const retry = () => {
    void state.reload();
  };

  const emptyNode = (filtered: boolean) => {
    if (filtered) {
      const clear = onClearFilter ?? empty.action?.onPress;
      return (
        <Empty
          icon="search-outline"
          title="No matches"
          text="Nothing here matches this filter."
          action={clear ? { label: "Show all", onPress: clear } : undefined}
        />
      );
    }
    return (
      <Empty icon={empty.icon} title={empty.title} text={empty.text ?? ""} action={empty.action} tone={empty.tone} />
    );
  };

  if (data === null || data === undefined) {
    let body: React.ReactNode;
    if (state.status === "failed" && !state.fetching) {
      body = (
        <LoadFailed error={state.error} code={state.errorCode} status={state.errorStatus} onRetry={retry} />
      );
    } else if (state.status === "ok" && !state.fetching) {
      body = emptyNode(false);
    } else {
      body = skeletonFor(skeleton, skeletonCount);
    }
    return (
      <View>
        {header}
        {body}
      </View>
    );
  }

  const all: T[] = Array.isArray(data) ? data : [];
  const visible: T[] = items ?? all;
  const banner = state.error ? <ErrorBanner message={state.error} onRetry={retry} /> : null;

  if (visible.length === 0) {
    const filtered = filterActive && (items === undefined || all.length > 0);
    return (
      <View>
        {header}
        {banner}
        {emptyNode(filtered)}
        {footer}
      </View>
    );
  }

  const render = (entries: Array<{ item: T; i: number }>) =>
    entries.map(({ item, i }) => keyed(renderItem(item, i, visible), keyExtractor(item, i)));

  let body: React.ReactNode;
  if (sectionOf) {
    const order: string[] = [];
    const bySection = new Map<string, Array<{ item: T; i: number }>>();
    visible.forEach((item, i) => {
      const title = sectionOf(item, i);
      let list = bySection.get(title);
      if (!list) {
        list = [];
        bySection.set(title, list);
        order.push(title);
      }
      list.push({ item, i });
    });
    body = order.map((title) => {
      const entries = bySection.get(title) ?? [];
      if (grouped) {
        return (
          <ListGroup key={`s:${title}`} title={title || undefined}>
            {render(entries)}
          </ListGroup>
        );
      }
      return (
        <View key={`s:${title}`} style={styles.section}>
          {title ? <SectionTitle variant="grouped">{title}</SectionTitle> : null}
          {render(entries)}
        </View>
      );
    });
  } else {
    const entries = visible.map((item, i) => ({ item, i }));
    body = grouped ? <ListGroup>{render(entries)}</ListGroup> : render(entries);
  }

  return (
    <View>
      {header}
      {banner}
      {body}
      {footer}
    </View>
  );
}

// ---------- AsyncBlock ----------
export type AsyncBlockProps<T> = {
  state: UseApiResult<T>;
  /** first-load placeholder (default a skeleton card) */
  skeleton?: React.ReactNode;
  /** a loaded answer that counts as empty */
  isEmpty?: (d: T) => boolean;
  /** shown for a loaded empty (or null) answer */
  empty?: React.ReactNode;
  children: (data: T) => React.ReactNode;
};

export function AsyncBlock<T>({ state, skeleton, isEmpty, empty, children }: AsyncBlockProps<T>): React.ReactElement {
  const data = state.data;
  const retry = () => {
    void state.reload();
  };

  if (data === null || data === undefined) {
    if (state.status === "failed" && !state.fetching) {
      return <LoadFailed error={state.error} code={state.errorCode} status={state.errorStatus} onRetry={retry} />;
    }
    if (state.status === "ok" && !state.fetching) return <>{empty ?? null}</>;
    return <>{skeleton ?? <SkeletonCard lines={3} />}</>;
  }

  return (
    <>
      {state.error ? <ErrorBanner message={state.error} onRetry={retry} /> : null}
      {isEmpty && isEmpty(data) && empty !== undefined ? empty : children(data)}
    </>
  );
}

// ---------- PagedList ----------
export type PagedListProps<T> = {
  items: T[];
  status: ApiStatus;
  error: string | null;
  errorCode?: string | null;
  errorStatus?: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onEndReached: () => void;
  onRetry: () => void;
  renderItem: (item: T, i: number) => React.ReactNode;
  keyExtractor: (item: T, i: number) => string;
  empty: AsyncEmpty;
  header?: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  grouped?: boolean;
  sections?: Array<{ title: string; indexes: number[] }>;
  skeletonCount?: number;
  /** "stack" (default): iOS adds the home-indicator inset itself; "none": headerless tab root */
  screenHeader?: "stack" | "none";
  testID?: string;
};

type Entry<T> = { item: T; i: number };

/** FlatList / SectionList host — mount inside <Screen scroll={false}>. */
export function PagedList<T>({
  items,
  status,
  error,
  errorCode,
  errorStatus,
  hasMore,
  loadingMore,
  onEndReached,
  onRetry,
  renderItem,
  keyExtractor,
  empty,
  header,
  onRefresh,
  refreshing = false,
  grouped = false,
  sections,
  skeletonCount,
  screenHeader = "stack",
  testID,
}: PagedListProps<T>): React.ReactElement {
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
  const bottom = Platform.OS === "ios" && screenHeader === "stack" ? 0 : insets.bottom;
  const n = items.length;

  const cell = (item: T, i: number, first: boolean, last: boolean): React.ReactElement => {
    const node = renderItem(item, i);
    if (!grouped) return <>{node}</>;
    return (
      <SurfaceContext.Provider value="card">
        <View style={[styles.groupCell, first ? styles.groupFirst : null, last ? styles.groupLast : null]}>
          {last ? markLast(node) : node}
        </View>
      </SurfaceContext.Provider>
    );
  };

  const handleEnd = () => {
    if (hasMore && !loadingMore && status !== "failed" && !error && n > 0) onEndReached();
  };

  const listHeader = (
    <View>
      {header}
      {error && n > 0 ? <ErrorBanner message={error} onRetry={onRetry} /> : null}
    </View>
  );

  let listEmpty: React.ReactElement;
  if (status === "failed") {
    listEmpty = <LoadFailed error={error} code={errorCode} status={errorStatus} onRetry={onRetry} />;
  } else if (status === "loading") {
    listEmpty = <SkeletonList rows={skeletonCount ?? 6} />;
  } else {
    listEmpty = (
      <Empty icon={empty.icon} title={empty.title} text={empty.text ?? ""} action={empty.action} tone={empty.tone} />
    );
  }

  let listFooter: React.ReactElement | null = null;
  if (n > 0) {
    if (loadingMore) {
      listFooter = (
        <View style={styles.footer} accessible accessibilityRole="progressbar" accessibilityLabel="Loading more">
          <ActivityIndicator size="small" color={colors.sub} />
          <Text maxFontSizeMultiplier={1.6} style={[styles.footerText, styles.footerTextSpaced]}>
            Loading more…
          </Text>
        </View>
      );
    } else if (hasMore && error) {
      listFooter = (
        <View style={styles.footer}>
          <Button title="Load more" onPress={onEndReached} variant="tinted" size="sm" fullWidth={false} />
        </View>
      );
    } else {
      listFooter = (
        <View style={styles.footer}>
          <Text maxFontSizeMultiplier={1.6} style={styles.footerText}>
            {`Showing ${n}${hasMore ? " · more" : ""}`}
          </Text>
        </View>
      );
    }
  }

  const refreshControl = onRefresh ? (
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.sub} colors={[colors.purple]} />
  ) : undefined;

  const common = {
    style: styles.list,
    contentContainerStyle: { padding: spacing.lg, paddingBottom: spacing.lg + bottom },
    contentInsetAdjustmentBehavior: screenHeader === "none" ? ("never" as const) : ("automatic" as const),
    keyboardShouldPersistTaps: "handled" as const,
    keyboardDismissMode: Platform.OS === "ios" ? ("interactive" as const) : ("on-drag" as const),
    onEndReachedThreshold: 0.4,
    onEndReached: handleEnd,
    ListHeaderComponent: listHeader,
    ListEmptyComponent: listEmpty,
    ListFooterComponent: listFooter,
    refreshControl,
    testID,
  };

  if (sections && sections.length > 0) {
    const data = sections
      .map((s) => ({
        title: s.title,
        data: s.indexes
          .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
          .map((i): Entry<T> => ({ item: items[i], i })),
      }))
      .filter((s) => s.data.length > 0);
    return (
      <SectionList
        {...common}
        sections={n > 0 ? data : []}
        keyExtractor={(e: Entry<T>) => keyExtractor(e.item, e.i)}
        renderItem={({ item, index, section }) => cell(item.item, item.i, index === 0, index === section.data.length - 1)}
        renderSectionHeader={({ section }) => (
          <SectionTitle variant="grouped">{String(section.title ?? "")}</SectionTitle>
        )}
        stickySectionHeadersEnabled={false}
      />
    );
  }

  return (
    <FlatList
      {...common}
      data={items}
      keyExtractor={(item: T, i: number) => keyExtractor(item, i)}
      renderItem={({ item, index }) => cell(item, index, index === 0, index === n - 1)}
    />
  );
}

// ---------- styles ----------
const styles = StyleSheet.create({
  section: { marginBottom: spacing.md },
  list: { flex: 1, backgroundColor: colors.bg },
  groupCell: { backgroundColor: colors.card, overflow: "hidden" },
  groupFirst: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  groupLast: { borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card, marginBottom: spacing.lg },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingVertical: spacing.md,
  },
  footerText: { fontSize: 13, color: colors.sub, textAlign: "center" },
  footerTextSpaced: { marginLeft: spacing.sm },
});
