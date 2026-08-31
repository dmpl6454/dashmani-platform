import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { apiFetch, fmtDate, fmtDateTime } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, SectionTitle, StatusPill, Button, Field, ErrorBanner, Loading, Chips, Empty, useApi } from "@/components/ui";

const STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: task, loading, refreshing, refresh, setData } = useApi<any>(async () => {
    const tasks = await apiFetch<any[]>("/hr/tasks");
    return tasks.find((t) => t.id === id) ?? null;
  }, [id]);

  const changeStatus = async (status: string) => {
    if (!task || status === task.status) return;
    setUpdating(true);
    setError(null);
    try {
      await apiFetch(`/hr/tasks/${task.id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      setData({ ...task, status });
    } catch (e: any) {
      setError(e?.message || "Could not update status");
    } finally {
      setUpdating(false);
    }
  };

  const postComment = async () => {
    if (!comment.trim() || !task) return;
    setPosting(true);
    setError(null);
    try {
      const created = await apiFetch<any>(`/hr/tasks/${task.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ content: comment.trim() }),
      });
      setData({ ...task, comments: [...(task.comments ?? []), created] });
      setComment("");
    } catch (e: any) {
      setError(e?.message || "Could not post comment");
    } finally {
      setPosting(false);
    }
  };

  if (loading) return <Loading />;
  if (!task)
    return (
      <Screen>
        <Card>
          <Empty icon="alert-circle-outline" text="Task not found" />
        </Card>
      </Screen>
    );

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <Card>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Text style={[styles.title, { flex: 1 }]}>{task.title}</Text>
          <StatusPill status={task.status} />
        </View>
        {task.description ? <Text style={styles.desc}>{task.description}</Text> : null}
        <View style={styles.metaBlock}>
          {task.priority ? <Text style={styles.meta}>Priority: {formatStatus(task.priority)}</Text> : null}
          {task.dueDate ? <Text style={styles.meta}>Due: {fmtDate(task.dueDate)}</Text> : null}
          {task.createdBy?.name ? <Text style={styles.meta}>Assigned by: {task.createdBy.name}</Text> : null}
          {task.account?.displayName ? (
            <Text style={styles.meta}>
              Account: {task.account.displayName}
              {task.account.handle ? ` (@${String(task.account.handle).split("?")[0].replace(/^@/, "")})` : ""}
            </Text>
          ) : null}
        </View>
      </Card>

      <SectionTitle>Update Status</SectionTitle>
      <Chips options={STATUSES} value={task.status} onChange={changeStatus} />
      {updating ? <Text style={styles.updating}>Updating…</Text> : null}

      <SectionTitle>Comments ({task.comments?.length ?? 0})</SectionTitle>
      <Card>
        {(task.comments ?? []).length === 0 ? (
          <Empty icon="chatbubble-outline" text="No comments yet" />
        ) : (
          task.comments.map((c: any) => (
            <View key={c.id} style={styles.comment}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={styles.commentAuthor}>{c.author?.name ?? "Unknown"}</Text>
                <Text style={styles.commentTime}>{fmtDateTime(c.createdAt)}</Text>
              </View>
              <Text style={styles.commentBody}>{c.body ?? c.content ?? ""}</Text>
            </View>
          ))
        )}
        <View style={{ marginTop: spacing.md }}>
          <Field value={comment} onChangeText={setComment} placeholder="Write a comment…" multiline autoCapitalize="sentences" />
          <Button title="Post Comment" onPress={postComment} loading={posting} disabled={!comment.trim()} small />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: "800", color: colors.ink },
  desc: { fontSize: 14, color: colors.ink, marginTop: 10, lineHeight: 20 },
  metaBlock: { marginTop: 12, gap: 4 },
  meta: { fontSize: 13, color: colors.sub },
  updating: { fontSize: 12, color: colors.purple, marginBottom: spacing.sm },
  comment: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  commentAuthor: { fontSize: 13, fontWeight: "700", color: colors.ink },
  commentTime: { fontSize: 11, color: colors.faint },
  commentBody: { fontSize: 13, color: colors.ink, marginTop: 4, lineHeight: 18 },
});
