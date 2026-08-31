import React, { useState } from "react";
import { View, Text, StyleSheet, Modal, FlatList, Pressable, ScrollView } from "react-native";
import { apiFetch, todayIST, fmtDate } from "@/lib/api";
import { colors, radius, spacing, formatStatus, statusColor } from "@/lib/theme";
import {
  Screen, Card, SectionTitle, StatusPill, Button, Field, Chips, Empty, Loading, ErrorBanner, SuccessBanner, useApi,
} from "@/components/ui";

const FILTERS = ["ALL", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"] as const;

export default function AdminTasks() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [showCreate, setShowCreate] = useState(false);
  const [statusFor, setStatusFor] = useState<any | null>(null);
  const [commentsFor, setCommentsFor] = useState<any | null>(null);
  const [comments, setComments] = useState<any[] | null>(null);
  const [newComment, setNewComment] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // create form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("MEDIUM");
  const [dueDate, setDueDate] = useState(todayIST());
  const [accountId, setAccountId] = useState<string | undefined>();
  const [assigneeId, setAssigneeId] = useState<string | undefined>();
  const [picker, setPicker] = useState<"account" | "assignee" | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: tasks, loading, refreshing, refresh, reload } = useApi<any[]>(
    () => apiFetch(`/tasks?pageSize=100${filter !== "ALL" ? `&status=${filter}` : ""}`),
    [filter],
  );
  const { data: accounts } = useApi<any[]>(() => apiFetch("/accounts?pageSize=100"));
  const { data: employees } = useApi<any[]>(() => apiFetch("/employees?pageSize=100"));

  const createTask = async () => {
    setError(null);
    if (title.trim().length < 2) return setError("Title must be at least 2 characters");
    if (!accountId) return setError("Pick an account — tasks are account-scoped");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return setError("Due date must be YYYY-MM-DD");
    setCreating(true);
    try {
      await apiFetch("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          dueDate,
          accountId,
          assigneeId,
        }),
      });
      setShowCreate(false);
      setTitle("");
      setDescription("");
      setAssigneeId(undefined);
      setSuccessMsg("Task created");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not create task");
    } finally {
      setCreating(false);
    }
  };

  const changeStatus = async (task: any, status: string) => {
    setStatusFor(null);
    try {
      await apiFetch(`/tasks/${task.id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      setSuccessMsg(`Status → ${formatStatus(status)}`);
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not update status");
    }
  };

  const openComments = async (task: any) => {
    setCommentsFor(task);
    setComments(null);
    try {
      setComments(await apiFetch<any[]>(`/tasks/${task.id}/comments`));
    } catch {
      setComments([]);
    }
  };

  const postComment = async () => {
    if (!newComment.trim() || !commentsFor) return;
    setPostingComment(true);
    try {
      const created = await apiFetch<any>(`/tasks/${commentsFor.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ content: newComment.trim() }),
      });
      setComments((c) => [...(c ?? []), created]);
      setNewComment("");
    } catch (e: any) {
      setError(e?.message || "Could not post comment");
    } finally {
      setPostingComment(false);
    }
  };

  const accLabel = (id?: string) => {
    const a = (accounts ?? []).find((x: any) => x.id === id);
    return a ? `${a.displayName || a.handle}` : "Pick account *";
  };
  const empLabel = (id?: string) => {
    const e = (employees ?? []).find((x: any) => x.id === id);
    return e ? e.name : "Unassigned";
  };

  const items = tasks ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />
      <Button title="+ New Task" onPress={() => { setSuccessMsg(null); setShowCreate(true); }} style={{ marginBottom: spacing.md }} />
      <Chips options={FILTERS} value={filter} onChange={setFilter} labels={{ ALL: "All" }} />

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty icon="checkbox-outline" text="No tasks" />
        </Card>
      ) : (
        items.map((t: any) => {
          const pr = statusColor(t.priority ?? "");
          return (
            <Card key={t.id}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.title, { flex: 1 }]} numberOfLines={2}>
                  {t.title}
                </Text>
                <Pressable onPress={() => setStatusFor(t)}>
                  <StatusPill status={t.status} />
                </Pressable>
              </View>
              <View style={styles.metaRow}>
                {t.priority ? (
                  <View style={[styles.prBadge, { backgroundColor: pr.bg }]}>
                    <Text style={[styles.prText, { color: pr.fg }]}>{formatStatus(t.priority)}</Text>
                  </View>
                ) : null}
                {t.assignee?.name ? <Text style={styles.meta}>→ {t.assignee.name}</Text> : <Text style={styles.meta}>Unassigned</Text>}
                {t.dueDate ? <Text style={styles.meta}>Due {fmtDate(t.dueDate)}</Text> : null}
                {t.account?.displayName ? (
                  <Text style={styles.meta} numberOfLines={1}>
                    @{t.account.displayName}
                  </Text>
                ) : null}
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <Text style={styles.tapHint}>Tap the status pill to change it</Text>
                <Pressable onPress={() => openComments(t)} hitSlop={8}>
                  <Text style={styles.commentsLink}>Comments</Text>
                </Pressable>
              </View>
            </Card>
          );
        })
      )}

      {/* Create modal */}
      <Modal visible={showCreate} animationType="slide" transparent onRequestClose={() => setShowCreate(false)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.sheetTitle}>New Task</Text>
              <ErrorBanner message={error} />
              <Field label="Title" value={title} onChangeText={setTitle} autoCapitalize="sentences" placeholder="What needs doing?" />
              <Field label="Description (optional)" value={description} onChangeText={setDescription} multiline autoCapitalize="sentences" />
              <Text style={styles.fieldLabel}>Priority</Text>
              <Chips options={PRIORITIES} value={priority} onChange={setPriority} />
              <Field label="Due date (YYYY-MM-DD)" value={dueDate} onChangeText={setDueDate} />
              <Text style={styles.fieldLabel}>Account (required)</Text>
              <Pressable style={styles.pickerBtn} onPress={() => setPicker("account")}>
                <Text style={[styles.pickerText, !accountId && { color: colors.faint }]}>{accLabel(accountId)}</Text>
              </Pressable>
              <Text style={styles.fieldLabel}>Assignee</Text>
              <Pressable style={styles.pickerBtn} onPress={() => setPicker("assignee")}>
                <Text style={[styles.pickerText, !assigneeId && { color: colors.faint }]}>{empLabel(assigneeId)}</Text>
              </Pressable>
              <Button title="Create Task" onPress={createTask} loading={creating} style={{ marginTop: spacing.md }} />
              <Button title="Cancel" onPress={() => setShowCreate(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Account / assignee picker */}
      <Modal visible={picker !== null} animationType="slide" transparent onRequestClose={() => setPicker(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>{picker === "account" ? "Pick Account" : "Pick Assignee"}</Text>
            <FlatList
              data={picker === "account" ? (accounts ?? []) : (employees ?? [])}
              keyExtractor={(x: any) => x.id}
              style={{ maxHeight: 400 }}
              ListHeaderComponent={
                picker === "assignee" ? (
                  <Pressable
                    style={styles.optRow}
                    onPress={() => {
                      setAssigneeId(undefined);
                      setPicker(null);
                    }}
                  >
                    <Text style={[styles.optName, { color: colors.sub }]}>Unassigned</Text>
                  </Pressable>
                ) : null
              }
              renderItem={({ item }) => (
                <Pressable
                  style={styles.optRow}
                  onPress={() => {
                    if (picker === "account") setAccountId(item.id);
                    else setAssigneeId(item.id);
                    setPicker(null);
                  }}
                >
                  <Text style={styles.optName}>{picker === "account" ? item.displayName || item.handle : item.name}</Text>
                  <Text style={styles.optSub} numberOfLines={1}>
                    {picker === "account"
                      ? `@${(item.handle || "").split("?")[0]} · ${item.platform?.name ?? ""}`
                      : item.email ?? ""}
                  </Text>
                </Pressable>
              )}
            />
            <Button title="Close" onPress={() => setPicker(null)} variant="ghost" small />
          </View>
        </View>
      </Modal>

      {/* Comments */}
      <Modal visible={!!commentsFor} animationType="slide" transparent onRequestClose={() => setCommentsFor(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle} numberOfLines={1}>{commentsFor?.title}</Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {comments === null ? (
                <Text style={styles.commentMeta}>Loading…</Text>
              ) : comments.length === 0 ? (
                <Text style={styles.commentMeta}>No comments yet</Text>
              ) : (
                comments.map((c: any) => (
                  <View key={c.id} style={styles.commentRow}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={styles.commentAuthor}>{c.author?.name ?? "Unknown"}</Text>
                      <Text style={styles.commentMeta}>{fmtDate(c.createdAt)}</Text>
                    </View>
                    <Text style={styles.commentBody}>{c.body ?? c.content ?? ""}</Text>
                  </View>
                ))
              )}
            </ScrollView>
            <Field value={newComment} onChangeText={setNewComment} placeholder="Add a comment…" autoCapitalize="sentences" />
            <Button title="Post" onPress={postComment} loading={postingComment} disabled={!newComment.trim()} small />
            <Button title="Close" onPress={() => setCommentsFor(null)} variant="ghost" small style={{ marginTop: spacing.sm }} />
          </View>
        </View>
      </Modal>

      {/* Status changer */}
      <Modal visible={!!statusFor} animationType="fade" transparent onRequestClose={() => setStatusFor(null)}>
        <View style={[styles.scrim, { justifyContent: "center", padding: spacing.xl }]}>
          <View style={[styles.sheet, { borderRadius: radius.xl }]}>
            <Text style={styles.sheetTitle}>Update Status</Text>
            <Text style={styles.statusTaskTitle} numberOfLines={2}>
              {statusFor?.title}
            </Text>
            {STATUSES.map((s) => (
              <Pressable key={s} style={styles.optRow} onPress={() => changeStatus(statusFor, s)}>
                <StatusPill status={s} />
              </Pressable>
            ))}
            <Button title="Cancel" onPress={() => setStatusFor(null)} variant="ghost" small style={{ marginTop: spacing.sm }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 15, fontWeight: "700", color: colors.ink },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" },
  meta: { fontSize: 12, color: colors.sub },
  prBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  prText: { fontSize: 10, fontWeight: "700" },
  tapHint: { fontSize: 10, color: colors.faint },
  commentsLink: { fontSize: 13, color: colors.purple, fontWeight: "500" },
  commentRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  commentAuthor: { fontSize: 13, fontWeight: "600", color: colors.ink },
  commentMeta: { fontSize: 12, color: colors.faint },
  commentBody: { fontSize: 13, color: colors.ink, marginTop: 3, lineHeight: 18 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.cardHigh,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    maxHeight: "88%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: colors.ink, marginBottom: 12 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.ink, marginBottom: 6 },
  pickerBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.cardHigh,
    paddingHorizontal: 12,
    height: 46,
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  pickerText: { fontSize: 15, color: colors.ink },
  optRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  optName: { fontSize: 14, fontWeight: "600", color: colors.ink },
  optSub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  statusTaskTitle: { fontSize: 13, color: colors.sub, marginBottom: 10 },
});
