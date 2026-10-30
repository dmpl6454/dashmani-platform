import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, describeError, fmtMoney, MONTHS, withQuery } from "@/lib/api";
import { colors, motion, radius, spacing, toneColors, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Chips, ErrorBanner, Screen, StatusPill, useApi } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";
import { Sheet } from "@/components/sheet";
import { confirm, toast } from "@/components/feedback";

const FILTERS = ["PENDING", "APPROVED", "ALL"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, string> = { PENDING: "Pending", APPROVED: "Approved", ALL: "All" };
const FILTER_STATUS: Record<Filter, string | undefined> = {
  PENDING: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  ALL: undefined,
};
const EMPTY_COPY: Record<Filter, { title: string; text: string }> = {
  PENDING: { title: "No slips waiting", text: "Generated slips that need approval show up here." },
  APPROVED: { title: "No approved slips", text: "Approved salary slips show up here." },
  ALL: { title: "No salary slips", text: "Salary slips show up here once they're generated." },
};

type MoneyKey =
  | "basicSalary"
  | "hra"
  | "conveyance"
  | "medicalAllowance"
  | "specialAllowance"
  | "otherEarnings"
  | "pf"
  | "esi"
  | "tax"
  | "otherDeductions";

type Slip = Partial<Record<MoneyKey, number | null>> & {
  id: string;
  month?: number | null;
  year?: number | null;
  status: string;
  netSalary?: number | null;
  remarks?: string | null;
  employee?: { id?: string | null; name?: string | null } | null;
};

const EARNINGS: ReadonlyArray<readonly [string, MoneyKey]> = [
  ["Basic salary", "basicSalary"],
  ["HRA", "hra"],
  ["Conveyance", "conveyance"],
  ["Medical allowance", "medicalAllowance"],
  ["Special allowance", "specialAllowance"],
  ["Other earnings", "otherEarnings"],
];

const DEDUCTIONS: ReadonlyArray<readonly [string, MoneyKey]> = [
  ["Provident fund", "pf"],
  ["ESI", "esi"],
  ["Tax", "tax"],
  ["Other deductions", "otherDeductions"],
];

function listOf<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    for (const key of ["items", "data", "slips", "rows"]) {
      const x = rec[key];
      if (Array.isArray(x)) return x as T[];
    }
  }
  return [];
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function nameOf(s: Slip): string {
  return s.employee?.name || "Employee";
}

function monthName(m: number | null | undefined): string | null {
  return m && m >= 1 && m <= 12 ? MONTHS[m - 1] : null;
}

/** "Sep 2026" */
function periodOf(s: Slip): string {
  const m = monthName(s.month);
  return [m ? m.slice(0, 3) : null, s.year ?? null].filter((x) => x !== null).join(" ") || "—";
}

/** "September 2026" */
function longPeriodOf(s: Slip): string {
  const m = monthName(s.month);
  return [m, s.year ?? null].filter((x) => x !== null).join(" ") || "—";
}

function MonthTile({ slip }: { slip: Slip }) {
  const t = toneColors("brand");
  const m = monthName(slip.month);
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={longPeriodOf(slip)}
      style={[styles.tile, { backgroundColor: t.bg }]}
    >
      <Text maxFontSizeMultiplier={1.2} style={[styles.tileMonth, { color: t.text }]}>
        {m ? m.slice(0, 3) : "—"}
      </Text>
      {slip.year ? (
        <Text maxFontSizeMultiplier={1.2} style={[styles.tileYear, { color: t.text }]}>
          {slip.year}
        </Text>
      ) : null}
    </View>
  );
}

function waitForSheetToClose(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, motion.base + 80));
}

export default function AdminSalarySlips() {
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [selected, setSelected] = useState<Slip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filterRef = useRef<Filter>(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const list = useApi<Slip[]>(
    async () => listOf<Slip>(await apiFetch<unknown>(withQuery("/admin/salary-slips", { status: FILTER_STATUS[filter] }))),
    [filter],
  );

  const changeFilter = (f: Filter) => {
    setFilter(f);
    setError(null);
  };

  const approve = async (s: Slip) => {
    setError(null);
    if (selected) {
      setSelected(null);
      await waitForSheetToClose();
    }
    const ok = await confirm({
      title: `Approve ${fmtMoney(s.netSalary)} for ${nameOf(s)} · ${periodOf(s)}?`,
      message: "This can't be undone.",
      confirmLabel: "Approve",
    });
    if (!ok) return;

    const startFilter = filterRef.current;
    const removes = startFilter === "PENDING";
    const index = (list.data ?? []).findIndex((x) => x.id === s.id);
    list.setData((prev) => {
      const cur = prev ?? [];
      return removes ? cur.filter((x) => x.id !== s.id) : cur.map((x) => (x.id === s.id ? { ...x, status: "APPROVED" } : x));
    });

    try {
      await apiFetch(`/admin/salary-slips/${s.id}/approve`, { method: "POST" });
      toast.show({ message: "Salary slip approved", tone: "success" });
      void haptic("success");
      if (filterRef.current === startFilter) await list.reload();
    } catch (e) {
      void haptic("error");
      if (filterRef.current === startFilter) {
        list.setData((prev) => {
          const cur = prev ?? [];
          if (cur.some((x) => x.id === s.id)) return cur.map((x) => (x.id === s.id ? s : x));
          const next = cur.slice();
          next.splice(Math.min(Math.max(index, 0), next.length), 0, s);
          return next;
        });
      }
      setError(describeError(e, "Couldn't approve this slip. Please try again."));
    }
  };

  const renderSheet = (s: Slip) => {
    const earnings = EARNINGS.filter(([, k]) => k === "basicSalary" || num(s[k]) !== 0);
    const deductions = DEDUCTIONS.filter(([, k]) => num(s[k]) !== 0);
    const gross = EARNINGS.reduce((sum, [, k]) => sum + num(s[k]), 0);
    const totalDeductions = DEDUCTIONS.reduce((sum, [, k]) => sum + num(s[k]), 0);
    return (
      <>
        <View style={styles.sheetStatus}>
          <StatusPill status={s.status} />
        </View>
        <ListGroup title="Earnings">
          {earnings.map(([label, k]) => (
            <ListItem key={k} title={label} detail={fmtMoney(num(s[k]))} />
          ))}
        </ListGroup>
        {deductions.length > 0 ? (
          <ListGroup title="Deductions">
            {deductions.map(([label, k]) => (
              <ListItem key={k} title={label} detail={`− ${fmtMoney(num(s[k]))}`} />
            ))}
          </ListGroup>
        ) : null}
        <ListGroup title="Summary" footer={s.remarks || undefined}>
          <ListItem title="Gross pay" detail={fmtMoney(gross)} />
          <ListItem title="Total deductions" detail={`− ${fmtMoney(totalDeductions)}`} />
          <ListItem title="Net pay" detail={fmtMoney(s.netSalary)} />
        </ListGroup>
      </>
    );
  };

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <AsyncList
        state={list}
        grouped
        header={
          <Chips
            options={FILTERS}
            value={filter}
            onChange={changeFilter}
            labels={FILTER_LABELS}
            accessibilityLabel="Slip status"
          />
        }
        keyExtractor={(s, i) => s.id || `slip-${i}`}
        empty={{ icon: "cash-outline", ...EMPTY_COPY[filter] }}
        renderItem={(s) => (
          <ListItem
            leading={<MonthTile slip={s} />}
            title={nameOf(s)}
            subtitle={`${periodOf(s)} · Net ${fmtMoney(s.netSalary)}`}
            trailing={<StatusPill status={s.status} size="sm" />}
            onPress={() => setSelected(s)}
            accessibilityHint="Shows the salary breakdown"
          />
        )}
      />
      <Sheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? nameOf(selected) : undefined}
        subtitle={selected ? longPeriodOf(selected) : undefined}
        footer={
          selected && selected.status === "PENDING_APPROVAL" ? (
            <Button
              title={`Approve ${fmtMoney(selected.netSalary)}`}
              variant="tinted"
              tone="success"
              onPress={() => approve(selected)}
            />
          ) : undefined
        }
      >
        {selected ? renderSheet(selected) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  tileMonth: { ...type.footnote, fontWeight: "700" },
  tileYear: { ...type.caption2 },
  sheetStatus: { flexDirection: "row", marginBottom: spacing.md },
  // Keeps a colour reference to the palette for platforms without a sheet background.
  hidden: { color: colors.sub },
});
