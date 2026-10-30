import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, fmtDay, istDateOf, MONTHS, todayIST } from "@/lib/api";
import { colors, formatStatus, radius, spacing, type } from "@/lib/theme";
import { Button, Card, IconButton, Screen, useApi } from "@/components/ui";
import { DateTile, ListGroup, ListItem } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonCard } from "@/components/skeleton";

const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

type CalendarDay = {
  date: string;
  isWeekend?: boolean | null;
  isHoliday?: boolean | null;
  isLeave?: boolean | null;
  leaveStatus?: string | null;
};

type Holiday = { id?: string | null; date: string; name: string; type?: string | null };

type CalendarData = {
  days?: CalendarDay[] | null;
  holidays?: Holiday[] | null;
  workingDays?: number | null;
};

type YM = { y: number; m: number };

/** The current IST month. */
function currentYM(): YM {
  const t = todayIST();
  return { y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) };
}

export default function CalendarScreen() {
  const [ym, setYm] = useState<YM>(currentYM);
  const today = todayIST();

  const state = useApi<CalendarData>(
    () => apiFetch<CalendarData>(`/hr/calendar?year=${ym.y}&month=${ym.m}`),
    [ym.y, ym.m],
  );

  const shift = (d: number) => {
    let m = ym.m + d;
    let y = ym.y;
    if (m < 1) {
      m = 12;
      y--;
    }
    if (m > 12) {
      m = 1;
      y++;
    }
    setYm({ y, m });
  };

  const now = currentYM();
  const isCurrentMonth = ym.y === now.y && ym.m === now.m;
  // Monday-first offset for the 1st of the month (calendar arithmetic, no time zone involved)
  const first = new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay(); // 0=Sun
  const lead = (first + 6) % 7;
  const monthName = `${MONTHS[ym.m - 1]} ${ym.y}`;

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <View style={styles.nav}>
        <IconButton icon="chevron-back" label="Previous month" variant="tinted" size={36} glyph={18} onPress={() => shift(-1)} />
        <View style={styles.navCenter}>
          <Text style={styles.month} accessibilityRole="header">
            {monthName}
          </Text>
          {!isCurrentMonth ? (
            <Button title="This month" variant="plain" size="sm" fullWidth={false} onPress={() => setYm(currentYM())} />
          ) : null}
        </View>
        <IconButton icon="chevron-forward" label="Next month" variant="tinted" size={36} glyph={18} onPress={() => shift(1)} />
      </View>

      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonCard lines={6} />
            <SkeletonCard lines={3} />
          </>
        }
      >
        {(data) => {
          const days = data.days ?? [];
          const holidays = data.holidays ?? [];
          return (
            <>
              <Card>
                <View style={styles.grid}>
                  {DOW.map((d) => (
                    <Text key={d} style={styles.dow}>
                      {d}
                    </Text>
                  ))}
                  {Array.from({ length: lead }).map((_, i) => (
                    <View key={`x${i}`} style={styles.cell} />
                  ))}
                  {days.map((d) => {
                    const ymd = istDateOf(d.date) ?? String(d.date).slice(0, 10);
                    const dayNum = Number(ymd.slice(8, 10));
                    const isToday = ymd === today;
                    const leaveApproved = !!d.isLeave && (d.leaveStatus === "APPROVED" || !d.leaveStatus);
                    const leavePending = !!d.isLeave && d.leaveStatus === "PENDING";
                    const label = [
                      fmtDay(ymd, { weekday: true }),
                      isToday ? "today" : null,
                      d.isHoliday ? "holiday" : null,
                      leaveApproved ? "approved leave" : null,
                      leavePending ? "leave pending" : null,
                    ]
                      .filter((s): s is string => !!s)
                      .join(", ");
                    return (
                      <View
                        key={d.date}
                        accessible
                        accessibilityLabel={label}
                        style={[
                          styles.cell,
                          d.isHoliday ? { backgroundColor: colors.yellowSoft } : null,
                          leaveApproved ? { backgroundColor: colors.purpleSoft } : null,
                          leavePending ? { backgroundColor: colors.amberSoft } : null,
                          isToday ? styles.today : null,
                        ]}
                      >
                        <Text
                          style={[
                            styles.dayNum,
                            d.isWeekend ? { color: colors.sub } : null,
                            isToday ? styles.todayNum : null,
                          ]}
                        >
                          {dayNum}
                        </Text>
                        {d.isHoliday ? <View style={[styles.dot, { backgroundColor: colors.yellow }]} /> : null}
                        {d.isLeave ? (
                          <View style={[styles.dot, { backgroundColor: leavePending ? colors.amber : colors.purple }]} />
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </Card>

              <Card>
                <View style={styles.legendRow}>
                  <View style={[styles.dot, { backgroundColor: colors.yellow }]} />
                  <Text style={styles.legend}>Holiday</Text>
                </View>
                <View style={styles.legendRow}>
                  <View style={[styles.dot, { backgroundColor: colors.purple }]} />
                  <Text style={styles.legend}>Approved leave</Text>
                </View>
                <View style={styles.legendRow}>
                  <View style={[styles.dot, { backgroundColor: colors.amber }]} />
                  <Text style={styles.legend}>Pending leave</Text>
                </View>
                <Text style={styles.workdays}>
                  {data.workingDays ?? "—"} working days this month · Sundays off
                </Text>
              </Card>

              {holidays.length > 0 ? (
                <ListGroup title="Holidays this month">
                  {holidays.map((h, i) => (
                    <ListItem
                      key={h.id ?? `${h.date}-${i}`}
                      leading={<DateTile date={h.date} />}
                      title={h.name}
                      subtitle={h.type ? formatStatus(h.type) : undefined}
                    />
                  ))}
                </ListGroup>
              ) : null}
            </>
          );
        }}
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  navCenter: { flex: 1, alignItems: "center" },
  month: { ...type.headline, color: colors.ink },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  dow: { ...type.caption2, width: `${100 / 7}%`, textAlign: "center", fontWeight: "700", color: colors.sub, marginBottom: 6 },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  today: { borderWidth: 2, borderColor: colors.purple },
  dayNum: { ...type.footnote, ...type.numeric, fontWeight: "600", color: colors.ink },
  todayNum: { color: colors.purpleText, fontWeight: "700" },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 2 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: 6 },
  legend: { ...type.subhead, color: colors.ink },
  workdays: { ...type.footnote, color: colors.sub, marginTop: 6 },
});
