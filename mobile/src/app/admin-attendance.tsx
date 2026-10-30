import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  ApiError,
  apiFetchPage,
  daysAgoIST,
  describeError,
  fmtDay,
  fmtRange,
  fmtTime,
  istDateOf,
  todayIST,
  withQuery,
} from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Avatar, Chips, Screen, StatusPill, useApi } from "@/components/ui";
import type { ApiStatus } from "@/components/ui";
import { ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { PagedList } from "@/components/async";
import { PickerSheet } from "@/components/sheet";

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
  loadedAt: string | null;
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
    loadedAt: null,
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
          loadedAt: new Date().toISOString(),
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
type AttendanceRecord = {
  id: string;
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  status?: string | null;
  note?: string | null;
  employee?: { id?: string; name?: string | null } | null;
};

type Person = { id: string; name?: string | null; email?: string | null };

const WINDOWS = ["TODAY", "7D", "30D"] as const;
type Win = (typeof WINDOWS)[number];
const WINDOW_LABELS: Record<Win, string> = { TODAY: "Today", "7D": "7 days", "30D": "30 days" };

const STATUSES = ["ALL", "PRESENT", "LATE", "HALF_DAY", "ABSENT", "LEAVE"] as const;
type StatusFilter = (typeof STATUSES)[number];
const STATUS_LABELS: Record<StatusFilter, string> = {
  ALL: "All",
  PRESENT: "Present",
  LATE: "Late",
  HALF_DAY: "Half day",
  ABSENT: "Absent",
  LEAVE: "Leave",
};

/** One page covers the whole roster for a single day; ranged windows page by cursor. */
const TODAY_LIMIT = 500;
const RANGE_LIMIT = 100;
const EVERYONE = "__everyone__";

function firstParam(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s : undefined;
}

function isStatusFilter(v: string | undefined): v is StatusFilter {
  return v !== undefined && (STATUSES as readonly string[]).includes(v);
}

export default function AdminAttendance() {
  const params = useLocalSearchParams<{ employeeId?: string | string[]; name?: string | string[]; status?: string | string[] }>();
  const initialEmployeeId = firstParam(params.employeeId);
  const initialName = firstParam(params.name);
  const initialStatus = firstParam(params.status)?.toUpperCase();

  const [win, setWin] = useState<Win>("TODAY");
  const [status, setStatus] = useState<StatusFilter>(isStatusFilter(initialStatus) ? initialStatus : "ALL");
  const [employee, setEmployee] = useState<{ id: string; name: string } | null>(
    initialEmployeeId ? { id: initialEmployeeId, name: initialName ?? "Selected employee" } : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const today = todayIST();
  const startDate = win === "TODAY" ? today : win === "7D" ? daysAgoIST(6) : daysAgoIST(29);
  const endDate = today;

  const path = withQuery("/attendance", {
    startDate,
    endDate,
    limit: win === "TODAY" ? TODAY_LIMIT : RANGE_LIMIT,
    status: status === "ALL" ? undefined : status,
    employeeId: employee?.id,
  });
  const list = usePagedList<AttendanceRecord>(path);

  const people = useApi<Person[]>(
    async () => (await apiFetchPage<Person>(withQuery("/employees", { search: pickerQuery.trim(), limit: 50 }))).items,
    [pickerQuery],
    { enabled: pickerOpen, keepData: true },
  );
  const pickerItems: Person[] = useMemo(() => {
    const found = people.data ?? [];
    return pickerQuery.trim() ? found : [{ id: EVERYONE, name: "Everyone" }, ...found];
  }, [people.data, pickerQuery]);

  const sections = useMemo(() => {
    if (win === "TODAY") return undefined;
    const order: string[] = [];
    const byDay = new Map<string, number[]>();
    list.items.forEach((r, i) => {
      const day = istDateOf(r.date) ?? "";
      let idx = byDay.get(day);
      if (!idx) {
        idx = [];
        byDay.set(day, idx);
        order.push(day);
      }
      idx.push(i);
    });
    return order.map((day) => ({
      title: !day ? "Unknown date" : day === today ? `Today · ${fmtDay(day)}` : fmtDay(day),
      indexes: byDay.get(day) ?? [],
    }));
  }, [win, list.items, today]);

  const counts = useMemo(() => {
    const c = { present: 0, halfDay: 0, late: 0, absent: 0, leave: 0 };
    list.items.forEach((r) => {
      switch (r.status) {
        case "PRESENT":
          c.present += 1;
          break;
        case "HALF_DAY":
          c.halfDay += 1;
          break;
        case "LATE":
          c.late += 1;
          break;
        case "ABSENT":
          c.absent += 1;
          break;
        case "LEAVE":
          c.leave += 1;
          break;
        default:
          break;
      }
    });
    return c;
  }, [list.items]);

  const n = list.items.length;
  const filterActive = status !== "ALL" || employee !== null;
  const showStats = win === "TODAY" && status === "ALL" && list.status === "ok" && n > 0;
  const countLabel = list.hasMore ? `Showing ${n} · more` : `${n} ${n === 1 ? "record" : "records"}`;
  const clearFilters = () => {
    setStatus("ALL");
    setEmployee(null);
  };

  const header = (
    <View style={styles.header}>
      <Chips
        options={WINDOWS}
        value={win}
        onChange={setWin}
        labels={WINDOW_LABELS}
        mode="segmented"
        accessibilityLabel="Date range"
      />
      <ListGroup>
        <ListItem
          icon="person-outline"
          tint="blue"
          title="Employee"
          detail={employee ? employee.name : "Everyone"}
          onPress={() => setPickerOpen(true)}
          accessibilityLabel={`Employee filter: ${employee ? employee.name : "Everyone"}`}
          accessibilityHint="Choose whose attendance to show"
        />
      </ListGroup>
      <Chips
        options={STATUSES}
        value={status}
        onChange={setStatus}
        labels={STATUS_LABELS}
        mode="pills"
        accessibilityLabel="Attendance status"
      />
      {showStats ? (
        <StatGrid>
          <StatTile
            label="Present"
            value={counts.present + counts.halfDay}
            icon="checkmark-circle-outline"
            tone="success"
            hint={counts.halfDay > 0 ? `incl. ${counts.halfDay} half day` : undefined}
            compact
          />
          <StatTile label="Late" value={counts.late} icon="time-outline" tone="warning" compact />
          <StatTile label="Absent" value={counts.absent} icon="close-circle-outline" tone="danger" compact />
          <StatTile label="Leave" value={counts.leave} icon="airplane-outline" tone="info" compact />
        </StatGrid>
      ) : null}
      {list.status === "ok" && n > 0 ? (
        <Text style={styles.count}>
          {win === "TODAY" ? `${countLabel} · ${fmtDay(today)}` : `${countLabel} · ${fmtRange(startDate, endDate)}`}
        </Text>
      ) : null}
    </View>
  );

  const asOf = fmtTime(list.loadedAt);
  const empty = filterActive
    ? {
        icon: "search-outline" as const,
        title: "No matching records",
        text: win === "TODAY" ? "Nothing matches these filters today." : "Nothing matches these filters in this window.",
        action: { label: "Clear filters", onPress: clearFilters },
      }
    : win === "TODAY"
      ? {
          icon: "time-outline" as const,
          title: "No one has checked in yet",
          text: asOf !== "—" ? `as of ${asOf} IST` : "Check-ins will appear here.",
        }
      : {
          icon: "calendar-outline" as const,
          title: "No attendance records",
          text: `Nothing recorded between ${fmtRange(startDate, endDate)}.`,
        };

  return (
    <Screen scroll={false}>
      <PagedList<AttendanceRecord>
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
        sections={sections}
        header={header}
        keyExtractor={(r) => r.id}
        renderItem={(r) => {
          const name = r.employee?.name?.trim() || "Employee";
          const times = `In ${fmtTime(r.checkIn)} · Out ${fmtTime(r.checkOut)}`;
          const sub = r.note?.trim() ? `${times}\n${r.note.trim()}` : times;
          return (
            <ListItem
              leading={<Avatar name={name} size={36} />}
              title={name}
              subtitle={sub}
              trailing={r.status ? <StatusPill status={r.status} size="sm" /> : undefined}
              accessibilityLabel={[
                name,
                times,
                r.status ? STATUS_LABELS[r.status as StatusFilter] ?? r.status : "",
              ]
                .filter(Boolean)
                .join(", ")}
            />
          );
        }}
        empty={empty}
      />
      <PickerSheet<Person>
        visible={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setPickerQuery("");
        }}
        title="Show attendance for"
        items={pickerItems}
        keyOf={(p) => p.id}
        labelOf={(p) => p.name?.trim() || "Unnamed"}
        subtitleOf={(p) => (p.id === EVERYONE ? "All employees" : p.email ?? undefined)}
        iconOf={(p) => (p.id === EVERYONE ? "people-outline" : "person-outline")}
        selectedKey={employee ? employee.id : EVERYONE}
        onSelect={(p) => {
          if (p.id === EVERYONE) setEmployee(null);
          else setEmployee({ id: p.id, name: p.name?.trim() || "Unnamed" });
        }}
        searchable
        onSearch={setPickerQuery}
        loading={people.data === null && people.status === "loading"}
        error={people.status === "failed" ? people.error : null}
        onRetry={() => {
          void people.reload();
        }}
        emptyText="No employees match this search"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.md, marginBottom: spacing.md },
  count: { ...type.footnote, color: colors.sub },
});
