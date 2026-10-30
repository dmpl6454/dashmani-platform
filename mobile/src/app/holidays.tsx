import React, { useMemo } from "react";
import { apiFetch, fmtDay, istDateOf, todayIST } from "@/lib/api";
import { formatStatus } from "@/lib/theme";
import { Screen, useApi } from "@/components/ui";
import { DateTile, ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";

type Holiday = {
  id: string;
  name: string;
  date: string;
  type?: string | null;
  description?: string | null;
};

function dayOf(v: string): string {
  return istDateOf(v) ?? String(v).slice(0, 10);
}

export default function HolidaysScreen() {
  const state = useApi<Holiday[]>(() => apiFetch<Holiday[]>("/hr/holidays"));
  const today = todayIST();

  // Upcoming first (soonest first), then past (most recent first).
  const ordered = useMemo(() => {
    if (!state.data) return undefined;
    const withDay = state.data.map((h) => ({ h, ymd: dayOf(h.date) }));
    const upcoming = withDay.filter((x) => x.ymd >= today).sort((a, b) => a.ymd.localeCompare(b.ymd));
    const past = withDay.filter((x) => x.ymd < today).sort((a, b) => b.ymd.localeCompare(a.ymd));
    return [...upcoming, ...past].map((x) => x.h);
  }, [state.data, today]);

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        items={ordered}
        grouped
        skeleton="rows"
        keyExtractor={(h) => h.id}
        sectionOf={(h) => (dayOf(h.date) >= today ? "Upcoming" : "Past")}
        empty={{
          icon: "sunny-outline",
          title: "No holidays yet",
          text: "Holidays for this year show up here once HR adds them.",
        }}
        renderItem={(h) => {
          const ymd = dayOf(h.date);
          const upcoming = ymd >= today;
          const parts = [fmtDay(ymd, { year: true })];
          if (h.type) parts.push(formatStatus(h.type));
          if (h.description?.trim()) parts.push(h.description.trim());
          return (
            <ListItem
              leading={<DateTile date={ymd} tone={upcoming ? "warning" : "neutral"} />}
              title={h.name}
              subtitle={parts.join(" · ")}
              lines={2}
            />
          );
        }}
      />
    </Screen>
  );
}
