import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  addDaysISO,
  apiFetch,
  describeError,
  fieldErrorMap,
  fmtRange,
  isApiError,
  isISODate,
  istDateOf,
  todayIST,
  workingDaysBetween,
} from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import {
  Button,
  Chips,
  ErrorBanner,
  Field,
  IconButton,
  Screen,
  SectionTitle,
  StatusPill,
  invalidate,
  useApi,
  useInvalidation,
} from "@/components/ui";
import { DateTile, LargeTitle, ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncBlock, AsyncList } from "@/components/async";
import { SkeletonStatRow } from "@/components/skeleton";
import { Sheet } from "@/components/sheet";
import { DateField } from "@/components/date-field";
import { toast } from "@/components/feedback";

const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID", "WFH", "COMP_OFF"] as const;
type LeaveType = (typeof LEAVE_TYPES)[number];

const CHIP_LABELS: Partial<Record<LeaveType, string>> = {
  CASUAL: "Casual",
  SICK: "Sick",
  EARNED: "Earned",
  UNPAID: "Unpaid",
  WFH: "WFH",
  COMP_OFF: "Comp-off",
};

const TYPE_TITLES: Record<string, string> = {
  CASUAL: "Casual leave",
  SICK: "Sick leave",
  EARNED: "Earned leave",
  UNPAID: "Unpaid leave",
  WFH: "Work from home",
  COMP_OFF: "Comp-off",
};

type BalanceBucket = { total: number; used: number; balance: number };
type LeaveBalance = {
  casual?: BalanceBucket;
  sick?: BalanceBucket;
  earned?: BalanceBucket;
  unpaid?: { used?: number };
};

type LeaveRequest = {
  id: string;
  type: string;
  status: string;
  startDate: string;
  endDate?: string | null;
  reason?: string | null;
};

function typeTitle(t: string): string {
  return TYPE_TITLES[t] ?? formatStatus(t);
}

function dayCount(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function requestSubtitle(r: LeaveRequest): string {
  const start = istDateOf(r.startDate);
  const end = istDateOf(r.endDate ?? r.startDate);
  const days = start && end ? workingDaysBetween(start, end) : 0;
  const parts: string[] = [fmtRange(r.startDate, r.endDate ?? null)];
  if (days > 0) parts.push(dayCount(days));
  const reason = r.reason?.trim();
  if (reason) parts.push(reason);
  return parts.join(" · ");
}

function bucketTile(label: string, b: BalanceBucket | undefined) {
  const total = b?.total ?? 0;
  const used = b?.used ?? 0;
  return (
    <StatTile
      key={label}
      compact
      label={label}
      value={b ? b.balance : "—"}
      progress={b && total > 0 ? Math.min(1, used / total) : undefined}
      hint={b ? `${used}/${total} used` : undefined}
      accessibilityLabel={b ? `${label}: ${b.balance} left, ${used} of ${total} used` : `${label}: unavailable`}
    />
  );
}

export default function LeaveScreen() {
  const params = useLocalSearchParams<{ apply?: string }>();

  const balance = useApi(() => apiFetch<LeaveBalance>("/hr/leave-balance"), [], {
    refetchOnFocus: true,
    staleMs: 30000,
  });
  const requests = useApi(() => apiFetch<LeaveRequest[]>("/hr/leave-requests"), [], {
    refetchOnFocus: true,
    staleMs: 30000,
  });
  const reloadBalance = balance.reload;
  const reloadRequests = requests.reload;

  useInvalidation("leave", () => {
    void reloadBalance();
    void reloadRequests();
  });

  // ---- apply sheet ----
  const [showApply, setShowApply] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>("CASUAL");
  const [startDate, setStartDate] = useState(todayIST());
  const [endDate, setEndDate] = useState(todayIST());
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});

  const openApply = useCallback(() => {
    const today = todayIST();
    setLeaveType("CASUAL");
    setStartDate(today);
    setEndDate(today);
    setReason("");
    setReasonTouched(false);
    setError(null);
    setFieldErrs({});
    setShowApply(true);
  }, []);

  // `/leave?apply=1` (e.g. from Home) opens the sheet once per distinct link.
  const handledApply = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (params.apply === "1" && handledApply.current !== "1") openApply();
    handledApply.current = params.apply;
  }, [params.apply, openApply]);

  const onStartChange = (v: string) => {
    setStartDate(v);
    setFieldErrs((f) => ({ ...f, startDate: "" }));
    if (isISODate(v) && (!isISODate(endDate) || endDate < v)) setEndDate(v);
  };

  const onEndChange = (v: string) => {
    setEndDate(v);
    setFieldErrs((f) => ({ ...f, endDate: "" }));
  };

  const datesValid = isISODate(startDate) && isISODate(endDate) && endDate >= startDate;
  const days = datesValid ? workingDaysBetween(startDate, endDate) : 0;
  const reasonMissing = reason.trim().length === 0;
  const reasonError = fieldErrs.reason || (reasonTouched && reasonMissing ? "Add a short reason" : null);

  const submitLeave = async () => {
    setError(null);
    setFieldErrs({});
    if (reasonMissing) {
      setReasonTouched(true);
      return;
    }
    if (!isISODate(startDate) || !isISODate(endDate)) {
      setError("Pick a start and an end date");
      return;
    }
    if (endDate < startDate) {
      setError("End date can't be before the start date");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/leave-requests", {
        method: "POST",
        body: JSON.stringify({ startDate, endDate, type: leaveType, reason: reason.trim() }),
      });
      setShowApply(false);
      toast.show({ message: `${typeTitle(leaveType)} requested · pending approval`, tone: "success" });
      void haptic("success");
      invalidate("leave");
    } catch (e: unknown) {
      void haptic("error");
      setFieldErrs(fieldErrorMap(e));
      if (isApiError(e) && e.code === "OVERLAPPING_LEAVE") {
        setError("You already have a request covering some of these dates.");
      } else if (isApiError(e) && e.code === "INVALID_DATES") {
        setError("End date can't be before the start date.");
      } else {
        setError(describeError(e, "Could not submit request"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const refresh = async () => {
    await Promise.all([balance.refresh(), requests.refresh()]);
  };

  const year = todayIST().slice(0, 4);
  const today = todayIST();

  return (
    <Screen header="none" onRefresh={refresh} refreshing={balance.refreshing || requests.refreshing}>
      <LargeTitle
        title="Leave"
        subtitle={`Balance · ${year}`}
        right={<IconButton icon="add" label="Apply for leave" onPress={openApply} variant="tinted" />}
      />

      <AsyncBlock state={balance} skeleton={<SkeletonStatRow count={3} />}>
        {(b) => (
          <View>
            <StatGrid columns={3}>
              {bucketTile("Casual", b.casual)}
              {bucketTile("Sick", b.sick)}
              {bucketTile("Earned", b.earned)}
            </StatGrid>
            {b.unpaid?.used ? (
              <Text style={styles.unpaidNote}>Unpaid leave taken this year: {dayCount(b.unpaid.used)}</Text>
            ) : null}
          </View>
        )}
      </AsyncBlock>

      <Button
        variant="primary"
        title="Apply for leave"
        icon="add"
        onPress={openApply}
        style={styles.applyButton}
      />

      <SectionTitle>My requests</SectionTitle>
      <AsyncList
        state={requests}
        grouped
        keyExtractor={(r) => r.id}
        renderItem={(r) => (
          <ListItem
            leading={<DateTile date={r.startDate} />}
            title={typeTitle(r.type)}
            subtitle={requestSubtitle(r)}
            trailing={<StatusPill status={r.status} size="sm" />}
            lines={2}
          />
        )}
        empty={{
          icon: "calendar-outline",
          title: "No leave requests yet",
          text: "Requests you make show up here with their approval status.",
          action: { label: "Apply for leave", onPress: openApply },
        }}
      />

      <Sheet
        visible={showApply}
        onClose={() => setShowApply(false)}
        title="New request"
        scroll
        footer={
          <View>
            <Button
              variant="primary"
              title="Submit request"
              onPress={submitLeave}
              loading={submitting}
              disabled={reasonMissing || !datesValid}
            />
            <ErrorBanner message={error} style={styles.sheetError} />
          </View>
        }
      >
        <Text style={styles.label}>Type</Text>
        <Chips
          options={LEAVE_TYPES}
          value={leaveType}
          onChange={setLeaveType}
          labels={CHIP_LABELS}
          mode="pills"
          wrap
          accessibilityLabel="Leave type"
        />
        <View style={styles.gap} />
        <DateField
          label="Start date"
          value={startDate}
          onChange={onStartChange}
          quick={[
            { label: "Today", value: today },
            { label: "Tomorrow", value: addDaysISO(today, 1) },
          ]}
          error={fieldErrs.startDate || null}
          required
        />
        <DateField
          label="End date"
          value={endDate}
          onChange={onEndChange}
          minimumDate={isISODate(startDate) ? startDate : undefined}
          error={fieldErrs.endDate || null}
          required
        />
        <Text style={styles.caption} accessibilityLiveRegion="polite">
          {datesValid ? `${dayCount(days)} · Sundays excluded` : "Pick valid dates · Sundays excluded"}
        </Text>
        <Field
          label="Reason"
          value={reason}
          onChangeText={setReason}
          onBlur={() => setReasonTouched(true)}
          placeholder="Why do you need this?"
          multiline
          autoCapitalize="sentences"
          required
          error={reasonError}
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  unpaidNote: { ...type.footnote, color: colors.sub, marginTop: spacing.sm },
  applyButton: { marginTop: spacing.lg, marginBottom: spacing.section },
  label: { ...type.subhead, fontWeight: "600", color: colors.ink, marginBottom: spacing.sm },
  gap: { height: spacing.lg },
  caption: { ...type.footnote, color: colors.sub, marginTop: -spacing.xs, marginBottom: spacing.md },
  sheetError: { marginTop: spacing.md, marginBottom: 0 },
});
