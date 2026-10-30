import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, errorMessage, fmtDay, istDateOf, todayIST } from "@/lib/api";
import { colors, formatStatus, sizes, spacing, type } from "@/lib/theme";
import { Chips, Screen, StatusPill, useApi, useInvalidation, type IoniconName } from "@/components/ui";
import { LargeTitle } from "@/components/list";
import { AsyncList } from "@/components/async";
import { toast } from "@/components/feedback";
import { haptic } from "@/lib/device";
import { tasksCache, useTaskList, type Task } from "@/lib/hooks/shared";
import type { UseApiResult } from "@/lib/hooks/useApi";

const FILTERS = ["ALL", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<Filter, string> = {
  ALL: "All",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  DONE: "Done",
};

const STATUS_LABELS: Record<string, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

/** What one tap on the status circle moves a task to. */
const NEXT_STATUS: Record<string, string> = {
  TODO: "IN_PROGRESS",
  IN_PROGRESS: "DONE",
  IN_REVIEW: "DONE",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? formatStatus(status);
}

function circleGlyph(status: string): { icon: IoniconName; color: string } {
  switch (status) {
    case "IN_PROGRESS":
      return { icon: "contrast", color: colors.warning };
    case "IN_REVIEW":
      return { icon: "checkmark-circle-outline", color: colors.purple };
    case "DONE":
      return { icon: "checkmark-circle", color: colors.green };
    case "CANCELLED":
      return { icon: "close-circle-outline", color: colors.sub };
    case "TODO":
    default:
      return { icon: "ellipse-outline", color: colors.sub };
  }
}

/** Day number of a YYYY-MM-DD string (split, never parsed as an instant). */
function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

type DueInfo = { text: string; overdue: boolean };

function dueInfo(task: Task, today: string): DueInfo | null {
  if (!task.dueDate) return null;
  const day = istDateOf(task.dueDate);
  if (!day) return null;
  const open = task.status !== "DONE" && task.status !== "CANCELLED";
  const diff = dayNumber(today) - dayNumber(day);
  if (open && diff > 0) return { text: `Overdue · ${diff} ${diff === 1 ? "day" : "days"}`, overdue: true };
  if (diff === 0) return { text: "Due today", overdue: false };
  if (diff === -1) return { text: "Due tomorrow", overdue: false };
  return { text: `Due ${fmtDay(day)}`, overdue: false };
}

type StatusCircleProps = { status: string; busy: boolean; onAdvance: () => void };

function StatusCircle({ status, busy, onAdvance }: StatusCircleProps) {
  if (busy) {
    return (
      <View style={styles.circle} accessible accessibilityLabel="Updating">
        <ActivityIndicator size="small" color={colors.sub} />
      </View>
    );
  }
  const glyph = circleGlyph(status);
  const next = NEXT_STATUS[status];
  const icon = <Ionicons name={glyph.icon} size={24} color={glyph.color} />;
  if (!next) {
    return (
      <View style={styles.circle} accessible accessibilityLabel={statusLabel(status)}>
        {icon}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onAdvance}
      accessibilityRole="button"
      accessibilityLabel={`Mark ${statusLabel(next)}`}
      style={({ pressed }) => [styles.circle, pressed ? styles.circlePressed : null]}
    >
      {icon}
    </Pressable>
  );
}

type TaskRowProps = {
  task: Task;
  today: string;
  busy: boolean;
  last: boolean;
  onOpen: () => void;
  onAdvance: () => void;
};

function TaskRow({ task, today, busy, last, onOpen, onAdvance }: TaskRowProps) {
  const done = task.status === "DONE";
  const due = dueInfo(task, today);
  const commentCount = task.comments?.length ?? 0;
  const meta: string[] = [];
  if (task.account?.displayName) meta.push(`@${task.account.displayName}`);
  if (commentCount > 0) meta.push(`${commentCount} ${commentCount === 1 ? "comment" : "comments"}`);
  const metaText = meta.join(" · ");
  const label = [task.title, statusLabel(task.status), due?.text, metaText]
    .filter((s): s is string => !!s)
    .join(", ");

  return (
    <View style={styles.row}>
      <StatusCircle status={task.status} busy={busy} onAdvance={onAdvance} />
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens the task"
        style={({ pressed }) => [styles.rowMain, last ? null : styles.hairline, pressed ? styles.pressed : null]}
      >
        <View style={styles.rowText}>
          <Text maxFontSizeMultiplier={1.6} numberOfLines={2} style={[styles.title, done ? styles.titleDone : null]}>
            {task.title}
          </Text>
          {due || metaText ? (
            <Text maxFontSizeMultiplier={1.6} numberOfLines={2} style={styles.subtitle}>
              {due ? <Text style={due.overdue ? styles.overdue : null}>{due.text}</Text> : null}
              {due && metaText ? " · " : ""}
              {metaText}
            </Text>
          ) : null}
        </View>
        <StatusPill status={task.status} label={statusLabel(task.status)} size="sm" />
        <Ionicons name="chevron-forward" size={sizes.chevron} color={colors.faint} style={styles.chevron} />
      </Pressable>
    </View>
  );
}

export default function TasksScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const state = useApi<Task[]>(
    async () => {
      const list = await apiFetch<Task[]>("/hr/tasks");
      tasksCache.setList(list);
      return list;
    },
    [],
    { refetchOnFocus: true, staleMs: 30000, keepData: true },
  );
  useInvalidation("tasks", state.reload);

  // The shared cache carries optimistic status changes made here and on the detail screen.
  const cached = useTaskList();
  const tasks = cached ?? state.data;
  const view: UseApiResult<Task[]> = { ...state, data: tasks };
  const today = todayIST();

  const counts = useMemo(() => {
    if (!tasks) return undefined;
    const c: Partial<Record<Filter, number>> = {};
    for (const f of FILTERS) {
      c[f] = f === "ALL" ? tasks.length : tasks.filter((t) => t.status === f).length;
    }
    return c;
  }, [tasks]);

  const visible = useMemo(
    () => (tasks ?? []).filter((t) => filter === "ALL" || t.status === filter),
    [tasks, filter],
  );

  const setStatus = async (task: Task, next: string, undoable: boolean): Promise<void> => {
    const prev = task.status;
    setBusy((b) => ({ ...b, [task.id]: true }));
    tasksCache.patch(task.id, { status: next });
    void haptic("selection");
    try {
      await apiFetch(`/hr/tasks/${task.id}/status`, { method: "PUT", body: JSON.stringify({ status: next }) });
      if (undoable) {
        toast.show({
          message: next === "DONE" ? "Marked done" : `Marked ${statusLabel(next).toLowerCase()}`,
          tone: "success",
          action: {
            label: "Undo",
            onPress: () => {
              void setStatus({ ...task, status: next }, prev, false);
            },
          },
        });
      }
    } catch (e: unknown) {
      tasksCache.patch(task.id, { status: prev });
      void haptic("error");
      toast.show({ message: errorMessage(e, "Couldn't update the task. Try again."), tone: "danger" });
    } finally {
      setBusy((b) => {
        const rest = { ...b };
        delete rest[task.id];
        return rest;
      });
    }
  };

  const advance = (task: Task) => {
    const next = NEXT_STATUS[task.status];
    if (!next || busy[task.id]) return;
    void setStatus(task, next, true);
  };

  return (
    <Screen header="none" onRefresh={state.refresh} refreshing={state.refreshing}>
      <LargeTitle title="Tasks" />
      <AsyncList
        state={view}
        items={visible}
        grouped
        filterActive={filter !== "ALL"}
        onClearFilter={() => setFilter("ALL")}
        header={
          <View style={styles.chips}>
            <Chips
              options={FILTERS}
              value={filter}
              onChange={setFilter}
              labels={FILTER_LABELS}
              counts={counts}
              mode="pills"
              wrap
              accessibilityLabel="Filter tasks by status"
            />
          </View>
        }
        keyExtractor={(t) => t.id}
        renderItem={(t, i, all) => (
          <TaskRow
            task={t}
            today={today}
            busy={!!busy[t.id]}
            last={i === all.length - 1}
            onOpen={() => router.push(`/task/${t.id}`)}
            onAdvance={() => advance(t)}
          />
        )}
        empty={{
          icon: "checkbox-outline",
          title: "No tasks yet",
          text: "Tasks your manager assigns to you will show up here.",
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { marginBottom: spacing.md },
  row: { flexDirection: "row", alignItems: "stretch", minHeight: sizes.rowMin, paddingLeft: spacing.xs },
  circle: {
    width: sizes.touch,
    minHeight: sizes.touch,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  circlePressed: { opacity: 0.6 },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingLeft: spacing.xs,
    paddingRight: spacing.lg,
  },
  hairline: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pressed: { backgroundColor: colors.pressOverlay },
  rowText: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  title: { ...type.body, color: colors.ink },
  titleDone: { color: colors.sub, textDecorationLine: "line-through" },
  subtitle: { ...type.subhead, color: colors.sub, marginTop: 2 },
  overdue: { color: colors.redText, fontWeight: "600" },
  chevron: { marginLeft: spacing.xs },
});
