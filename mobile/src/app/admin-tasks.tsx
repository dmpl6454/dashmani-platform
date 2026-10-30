// Admin · Tasks — every task in the workspace, filterable by status, with create / edit,
// status changes and comments. All sheets are the shared DS Sheet / PickerSheet.
//
// API (paths unchanged): GET /tasks, POST /tasks, PUT /tasks/:id, PUT /tasks/:id/status,
// GET /tasks/:id/comments, POST /tasks/:id/comments, GET /accounts, GET /employees.
import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type TextInput } from "react-native";
import {
  addDaysISO,
  apiFetch,
  apiFetchPage,
  describeError,
  fieldErrorMap,
  fmtDay,
  isISODate,
  istDateOf,
  timeAgo,
  todayIST,
  withQuery,
} from "@/lib/api";
import { colors, formatStatus, motion, sizes, spacing, statusTone, toneColors, type } from "@/lib/theme";
import type { Tone } from "@/lib/theme";
import { haptic } from "@/lib/device";
import {
  Avatar,
  Badge,
  Button,
  Chips,
  ErrorBanner,
  Field,
  Screen,
  SectionTitle,
  StatusPill,
  useApi,
  type IoniconName,
} from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { PickerSheet, Sheet } from "@/components/sheet";
import { AsyncList } from "@/components/async";
import { DateField } from "@/components/date-field";
import { confirm, toast } from "@/components/feedback";

// ---------- constants & types ----------
const FILTERS = ["ALL", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
type Filter = (typeof FILTERS)[number];
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
type Priority = (typeof PRIORITIES)[number];
const STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"] as const;
type TaskStatus = (typeof STATUSES)[number];

/** /tasks is cursor-paginated (limit max 500); the whole list is loaded so the chips can count. */
const LIST_LIMIT = 500;
const PICKER_LIMIT = 50;
const NONE_ID = "__none";

const STATUS_ICON: Record<TaskStatus, IoniconName> = {
  TODO: "ellipse-outline",
  IN_PROGRESS: "play-circle-outline",
  IN_REVIEW: "eye-outline",
  DONE: "checkmark-circle-outline",
  CANCELLED: "close-circle-outline",
};

const PRIORITY_TONE: Record<Priority, Tone> = {
  CRITICAL: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
};

type Person = { id: string; name: string; email?: string | null };

type Account = {
  id: string;
  handle?: string | null;
  displayName?: string | null;
  platform?: { name?: string | null; slug?: string | null } | null;
};

type AdminTask = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
  dueDate?: string | null;
  assignee?: Person | null;
  account?: Account | null;
  _count?: { comments?: number } | null;
};

type TaskComment = {
  id: string;
  body?: string | null;
  content?: string | null;
  createdAt: string;
  author?: { name?: string | null } | null;
};

type Choice = { id: string; label: string };

// ---------- helpers ----------
function isTaskStatus(s: string): s is TaskStatus {
  return (STATUSES as readonly string[]).includes(s);
}

function isPriority(s: string | null | undefined): s is Priority {
  return typeof s === "string" && (PRIORITIES as readonly string[]).includes(s);
}

function statusIcon(s: string): IoniconName {
  return isTaskStatus(s) ? STATUS_ICON[s] : "ellipse-outline";
}

function statusTint(s: string): string {
  return toneColors(statusTone(s)).fg;
}

function accountLabel(a: Account): string {
  return a.displayName || a.handle || "Account";
}

function accountSubtitle(a: Account): string | undefined {
  const handle = (a.handle || "").split("?")[0];
  const parts = [handle ? `@${handle}` : "", a.platform?.name ?? ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function taskSubtitle(t: AdminTask): string {
  const parts: string[] = [t.assignee?.name ? t.assignee.name : "Unassigned"];
  if (t.dueDate) parts.push(`Due ${fmtDay(t.dueDate)}`);
  if (t.account) parts.push(accountLabel(t.account));
  const n = t._count?.comments ?? 0;
  if (n > 0) parts.push(n === 1 ? "1 comment" : `${n} comments`);
  return parts.join(" · ");
}

/** Server-searched options for a PickerSheet (stale answers are dropped). */
function useRemoteOptions<T>(path: string) {
  const [items, setItems] = useState<T[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const lastQuery = useRef("");

  const search = useCallback(
    async (q: string) => {
      lastQuery.current = q;
      seq.current += 1;
      const id = seq.current;
      setQuery(q);
      setLoading(true);
      setError(null);
      try {
        const page = await apiFetchPage<T>(withQuery(path, { search: q, limit: PICKER_LIMIT }));
        if (id === seq.current) setItems(page.items);
      } catch (e) {
        if (id === seq.current) setError(describeError(e, "Couldn't load the list."));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [path],
  );

  const retry = useCallback(() => {
    void search(lastQuery.current);
  }, [search]);

  return { items, query, loading, error, search, retry };
}

// ---------- screen ----------
export default function AdminTasks() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [truncated, setTruncated] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusFor, setStatusFor] = useState<AdminTask | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [editing, setEditing] = useState<AdminTask | null>(null);

  const tasks = useApi<AdminTask[]>(async () => {
    const page = await apiFetchPage<AdminTask>(withQuery("/tasks", { limit: LIST_LIMIT }));
    setTruncated(page.meta.has_more);
    return page.items;
  }, []);

  const all = tasks.data;
  const counts = useMemo(() => {
    if (!all) return undefined;
    const c: Partial<Record<Filter, number>> = { ALL: all.length };
    FILTERS.forEach((f) => {
      if (f !== "ALL") c[f] = all.filter((t) => t.status === f).length;
    });
    return c;
  }, [all]);
  const visible = useMemo(
    () => (all ? (filter === "ALL" ? all : all.filter((t) => t.status === filter)) : undefined),
    [all, filter],
  );

  const openCreate = () => {
    setEditing(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  const openEdit = (t: AdminTask) => {
    setEditing(t);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  const onSaved = (message: string) => {
    setFormOpen(false);
    toast.show({ message, tone: "success" });
    void tasks.reload();
  };

  const setBusy = (id: string, on: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const applyStatus = async (task: AdminTask, status: TaskStatus) => {
    setStatusError(null);
    setBusy(task.id, true);
    try {
      await apiFetch(`/tasks/${task.id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      tasks.mutate((prev) => (prev ? prev.map((x) => (x.id === task.id ? { ...x, status } : x)) : prev));
      void haptic("success");
      toast.show({ message: `Marked ${formatStatus(status)}`, tone: "success" });
      void tasks.reload();
    } catch (e) {
      void haptic("error");
      setStatusError(`Couldn't update "${task.title}": ${describeError(e)}`);
    } finally {
      setBusy(task.id, false);
    }
  };

  const askThenApply = async (task: AdminTask, status: TaskStatus) => {
    const cancelling = status === "CANCELLED";
    const ok = await confirm({
      title: cancelling ? "Cancel this task?" : "Mark this task as done?",
      message: task.title,
      confirmLabel: cancelling ? "Cancel Task" : "Mark Done",
      cancelLabel: cancelling ? "Keep Task" : "Not Yet",
      destructive: cancelling,
    });
    if (ok) await applyStatus(task, status);
  };

  const onPickStatus = (status: TaskStatus) => {
    const task = statusFor;
    if (!task || status === task.status) return;
    if (status === "DONE" || status === "CANCELLED") {
      // Let the picker sheet finish closing before the confirm sheet is presented.
      setTimeout(() => {
        void askThenApply(task, status);
      }, motion.slow);
      return;
    }
    void applyStatus(task, status);
  };

  return (
    <Screen onRefresh={tasks.refresh} refreshing={tasks.refreshing}>
      <Button title="New task" icon="add" onPress={openCreate} style={styles.newButton} />
      <ErrorBanner message={statusError} onDismiss={() => setStatusError(null)} />
      <AsyncList<AdminTask>
        state={tasks}
        grouped
        header={
          <View style={styles.chips}>
            <Chips
              options={FILTERS}
              value={filter}
              onChange={setFilter}
              labels={{ ALL: "All", TODO: "To do", IN_PROGRESS: "In progress", IN_REVIEW: "In review", DONE: "Done" }}
              counts={counts}
              mode="pills"
              accessibilityLabel="Filter tasks by status"
            />
          </View>
        }
        items={visible}
        filterActive={filter !== "ALL"}
        onClearFilter={() => setFilter("ALL")}
        keyExtractor={(t) => t.id}
        empty={{
          icon: "checkbox-outline",
          title: "No tasks yet",
          text: "Create a task to assign work on an account.",
          action: { label: "New task", onPress: openCreate },
        }}
        footer={
          truncated ? (
            <Text style={styles.footnote}>Showing the first {LIST_LIMIT} tasks. Use the web portal to see older ones.</Text>
          ) : null
        }
        renderItem={(t, i, rows) => {
          const busy = busyIds.has(t.id);
          const pr = isPriority(t.priority) ? t.priority : null;
          const last = i === rows.length - 1;
          // The status button is a sibling of the row's Pressable, not a child: on iOS an accessible
          // parent hides its subtree from VoiceOver, so a nested button could never be focused.
          return (
            <View style={styles.taskRow}>
              <View style={styles.taskMain}>
                <ListItem
                  title={t.title}
                  subtitle={taskSubtitle(t)}
                  icon={statusIcon(t.status)}
                  tint={statusTint(t.status)}
                  lines={2}
                  chevron={false}
                  last={last}
                  onPress={() => openEdit(t)}
                  accessibilityHint="Opens the task to edit it or read comments"
                  trailing={
                    pr ? (
                      <View style={styles.trailing}>
                        <Badge value={formatStatus(pr)} tone={PRIORITY_TONE[pr]} accessibilityLabel={`${formatStatus(pr)} priority`} />
                      </View>
                    ) : undefined
                  }
                />
              </View>
              <View style={[styles.statusCell, last ? null : styles.hairline]}>
                {busy ? (
                  <ActivityIndicator color={colors.sub} accessibilityLabel="Updating status" />
                ) : (
                  <Pressable
                    onPress={() => {
                      setStatusError(null);
                      setStatusFor(t);
                    }}
                    hitSlop={8}
                    style={styles.statusHit}
                    accessibilityRole="button"
                    accessibilityLabel={`${t.title}. Status: ${formatStatus(t.status)}. Change status`}
                  >
                    <StatusPill status={t.status} size="sm" />
                  </Pressable>
                )}
              </View>
            </View>
          );
        }}
      />

      <PickerSheet<TaskStatus>
        visible={statusFor !== null}
        onClose={() => setStatusFor(null)}
        title="Change status"
        items={[...STATUSES]}
        keyOf={(s) => s}
        labelOf={(s) => formatStatus(s)}
        iconOf={(s) => STATUS_ICON[s]}
        tintOf={(s) => statusTint(s)}
        selectedKey={statusFor?.status ?? null}
        searchable={false}
        onSelect={onPickStatus}
      />

      <TaskFormSheet key={formKey} visible={formOpen} task={editing} onClose={() => setFormOpen(false)} onSaved={onSaved} />
    </Screen>
  );
}

// ---------- create / edit sheet ----------
type TaskFormSheetProps = {
  visible: boolean;
  /** null → create */
  task: AdminTask | null;
  onClose: () => void;
  onSaved: (message: string) => void;
};

const UNASSIGNED: Person = { id: NONE_ID, name: "Unassigned" };

function TaskFormSheet({ visible, task, onClose, onSaved }: TaskFormSheetProps) {
  const isEdit = task !== null;
  const today = todayIST();
  const descRef = useRef<TextInput>(null);

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<Priority>(isPriority(task?.priority) ? task.priority : "MEDIUM");
  const [dueDate, setDueDate] = useState<string>(task ? (task.dueDate ? istDateOf(task.dueDate) ?? "" : "") : today);
  const [account, setAccount] = useState<Choice | null>(
    task?.account ? { id: task.account.id, label: accountLabel(task.account) } : null,
  );
  const [assignee, setAssignee] = useState<Choice | null>(
    task?.assignee ? { id: task.assignee.id, label: task.assignee.name } : null,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<"account" | "assignee" | null>(null);

  const accounts = useRemoteOptions<Account>("/accounts");
  const employees = useRemoteOptions<Person>("/employees");

  const openPicker = (which: "account" | "assignee") => {
    setPicker(which);
    if (which === "account") void accounts.search("");
    else void employees.search("");
  };

  const save = async () => {
    const errs: Record<string, string> = {};
    const cleanTitle = title.trim();
    if (cleanTitle.length < 2) errs.title = "Title must be at least 2 characters";
    if (!account) errs.accountId = "Pick an account — tasks belong to an account";
    if (!dueDate) {
      if (!isEdit) errs.dueDate = "Pick a due date";
    } else if (!isISODate(dueDate)) {
      errs.dueDate = "Pick a valid date";
    }
    setErrors(errs);
    setSubmitError(null);
    if (Object.keys(errs).length > 0 || !account) {
      void haptic("warning");
      return;
    }
    setSaving(true);
    try {
      if (task) {
        await apiFetch(`/tasks/${task.id}`, {
          method: "PUT",
          body: JSON.stringify({
            title: cleanTitle,
            description: description.trim() || null,
            priority,
            dueDate: dueDate || null,
            accountId: account.id,
            assigneeId: assignee ? assignee.id : null,
          }),
        });
      } else {
        await apiFetch("/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: cleanTitle,
            description: description.trim() || undefined,
            priority,
            dueDate,
            accountId: account.id,
            assigneeId: assignee ? assignee.id : undefined,
          }),
        });
      }
      void haptic("success");
      onSaved(isEdit ? "Task updated" : "Task created");
    } catch (e) {
      void haptic("error");
      const fe = fieldErrorMap(e);
      setErrors(fe);
      const known = ["title", "description", "dueDate", "accountId", "assigneeId"].some((k) => fe[k]);
      setSubmitError(known ? "Check the highlighted fields." : describeError(e, "Couldn't save the task."));
    } finally {
      setSaving(false);
    }
  };

  const employeeItems = employees.query === "" ? [UNASSIGNED, ...employees.items] : employees.items;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={isEdit ? "Edit task" : "New task"}
      detent="large"
      dismissable={!saving}
      footer={
        <View>
          {submitError ? (
            <Text style={styles.errorText} accessibilityLiveRegion="polite">
              {submitError}
            </Text>
          ) : null}
          <Button title={isEdit ? "Save changes" : "Create task"} onPress={save} loading={saving} />
        </View>
      }
    >
      <Field
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="What needs doing?"
        autoCapitalize="sentences"
        returnKeyType="next"
        blurOnSubmit={false}
        onSubmitEditing={() => descRef.current?.focus()}
        error={errors.title}
        required
        maxLength={200}
      />
      <Field
        ref={descRef}
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="Optional details"
        multiline
        autoCapitalize="sentences"
        error={errors.description}
        maxLength={5000}
      />

      <SectionTitle variant="grouped">Priority</SectionTitle>
      <View style={styles.block}>
        <Chips
          options={PRIORITIES}
          value={priority}
          onChange={setPriority}
          labels={{ LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" }}
          mode="segmented"
          accessibilityLabel="Priority"
        />
      </View>

      <DateField
        label="Due date"
        value={dueDate}
        onChange={setDueDate}
        error={errors.dueDate}
        required={!isEdit}
        quick={[
          { label: "Today", value: today },
          { label: "Tomorrow", value: addDaysISO(today, 1) },
          { label: "In a week", value: addDaysISO(today, 7) },
        ]}
      />

      <ListGroup title="Account">
        <ListItem
          icon="at-outline"
          tint={account ? "brand" : "orange"}
          title={account ? account.label : "Choose account"}
          subtitle={account ? undefined : "Required — the account this task is for"}
          chevron
          onPress={() => openPicker("account")}
          accessibilityLabel={account ? `Account: ${account.label}. Change account` : "Choose account"}
        />
      </ListGroup>
      {errors.accountId ? <Text style={styles.errorText}>{errors.accountId}</Text> : null}

      <ListGroup title="Assignee">
        <ListItem
          icon="person-outline"
          tint={assignee ? "blue" : "gray"}
          title={assignee ? assignee.label : "Unassigned"}
          chevron
          onPress={() => openPicker("assignee")}
          accessibilityLabel={assignee ? `Assignee: ${assignee.label}. Change assignee` : "Choose assignee"}
        />
      </ListGroup>
      {errors.assigneeId ? <Text style={styles.errorText}>{errors.assigneeId}</Text> : null}

      {task ? <TaskComments taskId={task.id} /> : null}

      <PickerSheet<Account>
        visible={picker === "account"}
        onClose={() => setPicker(null)}
        title="Choose account"
        items={accounts.items}
        keyOf={(a) => a.id}
        labelOf={accountLabel}
        subtitleOf={accountSubtitle}
        selectedKey={account?.id ?? null}
        onSelect={(a) => {
          setAccount({ id: a.id, label: accountLabel(a) });
          setErrors((prev) => ({ ...prev, accountId: "" }));
        }}
        onSearch={(q) => {
          void accounts.search(q);
        }}
        loading={accounts.loading}
        error={accounts.error}
        onRetry={accounts.retry}
        emptyText={accounts.query ? "No accounts match that search" : "No accounts yet"}
      />
      <PickerSheet<Person>
        visible={picker === "assignee"}
        onClose={() => setPicker(null)}
        title="Choose assignee"
        items={employeeItems}
        keyOf={(p) => p.id}
        labelOf={(p) => p.name}
        subtitleOf={(p) => (p.id === NONE_ID ? "No one yet" : p.email ?? undefined)}
        selectedKey={assignee?.id ?? NONE_ID}
        onSelect={(p) => {
          setAssignee(p.id === NONE_ID ? null : { id: p.id, label: p.name });
          setErrors((prev) => ({ ...prev, assigneeId: "" }));
        }}
        onSearch={(q) => {
          void employees.search(q);
        }}
        loading={employees.loading}
        error={employees.error}
        onRetry={employees.retry}
        emptyText={employees.query ? "No employees match that search" : "No employees yet"}
      />
    </Sheet>
  );
}

// ---------- comments ----------
function TaskComments({ taskId }: { taskId: string }) {
  const comments = useApi<TaskComment[]>(() => apiFetch<TaskComment[]>(`/tasks/${taskId}/comments`), [taskId]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const post = async () => {
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    setPostError(null);
    try {
      const created = await apiFetch<TaskComment>(`/tasks/${taskId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: text }),
      });
      comments.mutate((prev) => [...(prev ?? []), created]);
      setDraft("");
      void haptic("success");
    } catch (e) {
      void haptic("error");
      setPostError(describeError(e, "Couldn't post the comment."));
    } finally {
      setPosting(false);
    }
  };

  return (
    <View style={styles.comments}>
      <SectionTitle variant="grouped">Comments</SectionTitle>
      <AsyncList<TaskComment>
        state={comments}
        skeletonCount={2}
        keyExtractor={(c) => c.id}
        empty={{ icon: "chatbubbles-outline", title: "No comments yet", text: "Notes from the team show up here." }}
        renderItem={(c) => {
          const author = c.author?.name || "Unknown";
          return (
            <View style={styles.commentRow}>
              <Avatar name={author} size={28} />
              <View style={styles.commentText}>
                <View style={styles.commentHead}>
                  <Text style={styles.commentAuthor} numberOfLines={1}>
                    {author}
                  </Text>
                  <Text style={styles.commentTime}>{timeAgo(c.createdAt)}</Text>
                </View>
                <Text style={styles.commentBody}>{c.body ?? c.content ?? ""}</Text>
              </View>
            </View>
          );
        }}
      />
      <Field
        value={draft}
        onChangeText={setDraft}
        placeholder="Add a comment…"
        multiline
        autoCapitalize="sentences"
        accessibilityLabel="New comment"
        maxLength={5000}
      />
      <Button
        title="Post"
        variant="tinted"
        size="sm"
        onPress={post}
        loading={posting}
        disabled={!draft.trim()}
        fullWidth={false}
      />
      {postError ? <Text style={styles.errorText}>{postError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  newButton: { marginBottom: spacing.md },
  chips: { marginBottom: spacing.md },
  taskRow: { flexDirection: "row", alignItems: "stretch" },
  taskMain: { flex: 1, minWidth: 0 },
  trailing: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginLeft: spacing.sm },
  statusCell: { justifyContent: "center", alignItems: "flex-end", paddingRight: spacing.lg },
  hairline: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  statusHit: { minHeight: sizes.touch, justifyContent: "center" },
  footnote: { ...type.footnote, color: colors.tertiary, marginTop: spacing.sm, textAlign: "center" },
  block: { marginBottom: spacing.lg },
  errorText: { ...type.footnote, color: colors.redText, marginBottom: spacing.sm },
  comments: { marginTop: spacing.section, gap: spacing.sm },
  commentRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  commentText: { flex: 1 },
  commentHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm },
  commentAuthor: { ...type.subhead, fontWeight: "600", color: colors.ink, flexShrink: 1 },
  commentTime: { ...type.footnote, color: colors.tertiary },
  commentBody: { ...type.subhead, color: colors.ink, marginTop: 2 },
});
