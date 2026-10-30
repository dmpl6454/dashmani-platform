import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch, errorMessage, fmtDay, istDateOf, timeAgo } from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import {
  Avatar,
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Screen,
  SectionTitle,
  SegmentedControl,
  StatusPill,
  invalidate,
  useApi,
} from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonCard } from "@/components/skeleton";
import { haptic } from "@/lib/device";
import { tasksCache, useTask, type Task } from "@/lib/hooks/shared";

const STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABELS: Record<Status, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  DONE: "Done",
};

type TaskComment = NonNullable<Task["comments"]>[number];

function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}

function statusLabel(s: string): string {
  return isStatus(s) ? STATUS_LABELS[s] : formatStatus(s);
}

function cleanHandle(handle: string): string {
  return String(handle).split("?")[0].replace(/^@/, "");
}

export default function TaskDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id ?? "";
  const router = useRouter();
  const cached = useTask(id);

  // Background refresh of the shared cache (the detail renders instantly from it when present).
  const list = useApi<Task[]>(async () => {
    const tasks = await apiFetch<Task[]>("/hr/tasks");
    tasksCache.setList(tasks);
    return tasks;
  }, []);

  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const changeStatus = async (task: Task, next: Status): Promise<void> => {
    if (updating || next === task.status) return;
    const prev = task.status;
    setUpdating(true);
    setStatusError(null);
    tasksCache.patch(task.id, { status: next });
    void haptic("selection");
    try {
      await apiFetch(`/hr/tasks/${task.id}/status`, { method: "PUT", body: JSON.stringify({ status: next }) });
      invalidate("tasks");
    } catch (e: unknown) {
      tasksCache.patch(task.id, { status: prev });
      void haptic("error");
      setStatusError(errorMessage(e, "Couldn't update the status. Try again."));
    } finally {
      setUpdating(false);
    }
  };

  const postComment = async (task: Task): Promise<void> => {
    const text = comment.trim();
    if (!text || posting) return;
    setPosting(true);
    setCommentError(null);
    try {
      const created = await apiFetch<TaskComment>(`/hr/tasks/${task.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ content: text }),
      });
      const current = tasksCache.get(task.id) ?? task;
      tasksCache.patch(task.id, { comments: [...(current.comments ?? []), created] });
      setComment("");
      void haptic("success");
    } catch (e: unknown) {
      setCommentError(errorMessage(e, "Couldn't post your comment. Try again."));
    } finally {
      setPosting(false);
    }
  };

  const renderTask = (task: Task) => {
    const dueDay = task.dueDate ? istDateOf(task.dueDate) : null;
    const comments = task.comments ?? [];
    const handle = task.account?.handle ? cleanHandle(task.account.handle) : "";
    const status = task.status;

    return (
      <>
        <Card>
          <View style={styles.headRow}>
            <Text maxFontSizeMultiplier={1.6} accessibilityRole="header" style={styles.title}>
              {task.title}
            </Text>
            <StatusPill status={status} label={statusLabel(status)} />
          </View>
          {task.description ? (
            <Text maxFontSizeMultiplier={1.6} selectable style={styles.desc}>
              {task.description}
            </Text>
          ) : null}
        </Card>

        {task.priority || dueDay || task.createdBy?.name || task.account?.displayName ? (
          <ListGroup>
            {task.priority ? (
              <ListItem title="Priority" icon="flag" tint="orange" detail={formatStatus(task.priority)} />
            ) : null}
            {dueDay ? <ListItem title="Due" icon="calendar" tint="blue" detail={fmtDay(dueDay)} /> : null}
            {task.createdBy?.name ? (
              <ListItem title="Assigned by" icon="person" tint="indigo" detail={task.createdBy.name} />
            ) : null}
            {task.account?.displayName ? (
              <ListItem
                title="Account"
                subtitle={handle ? `@${handle}` : undefined}
                icon="at"
                tint="pink"
                detail={task.account.displayName}
              />
            ) : null}
          </ListGroup>
        ) : null}

        {isStatus(status) ? (
          <>
            <SectionTitle>Status</SectionTitle>
            <SegmentedControl
              options={STATUSES}
              value={status}
              labels={STATUS_LABELS}
              onChange={(next) => {
                void changeStatus(task, next);
              }}
              disabled={updating}
            />
            {statusError ? (
              <Text maxFontSizeMultiplier={1.6} accessibilityRole="alert" style={styles.inlineError}>
                {statusError}
              </Text>
            ) : null}
          </>
        ) : null}

        <SectionTitle>{comments.length > 0 ? `Comments · ${comments.length}` : "Comments"}</SectionTitle>
        <Card padded={false}>
          {comments.length === 0 ? (
            <Empty compact icon="chatbubble-outline" text="No comments yet. Ask a question or share an update." />
          ) : (
            comments.map((c, i) => {
              const author = c.author?.name ?? "Unknown";
              const body = c.body ?? c.content ?? "";
              return (
                <View
                  key={c.id}
                  style={[styles.comment, i < comments.length - 1 ? styles.hairline : null]}
                  accessible
                  accessibilityLabel={`${author}, ${timeAgo(c.createdAt)}: ${body}`}
                >
                  <Avatar name={author} size={28} />
                  <View style={styles.commentText}>
                    <View style={styles.commentHead}>
                      <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.commentAuthor}>
                        {author}
                      </Text>
                      <Text maxFontSizeMultiplier={1.6} style={styles.commentTime}>
                        {timeAgo(c.createdAt)}
                      </Text>
                    </View>
                    <Text maxFontSizeMultiplier={1.6} selectable style={styles.commentBody}>
                      {body}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </Card>

        <Card>
          <Field
            value={comment}
            onChangeText={setComment}
            placeholder="Write a comment…"
            multiline
            autoCapitalize="sentences"
            autoCorrect
            accessibilityLabel="Comment"
          />
          <Button
            title="Post"
            variant="tinted"
            size="sm"
            icon="send"
            fullWidth={false}
            onPress={() => postComment(task)}
            loading={posting}
            disabled={!comment.trim()}
            style={styles.post}
          />
          {commentError ? (
            <Text maxFontSizeMultiplier={1.6} accessibilityRole="alert" style={styles.inlineError}>
              {commentError}
            </Text>
          ) : null}
        </Card>
      </>
    );
  };

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      {cached ? (
        <>
          {list.error ? <ErrorBanner message={list.error} onRetry={() => void list.reload()} /> : null}
          {renderTask(cached)}
        </>
      ) : (
        <AsyncBlock
          state={list}
          skeleton={<SkeletonCard lines={4} />}
          isEmpty={(tasks) => !tasks.some((t) => t.id === id)}
          empty={
            <Empty
              icon="search-outline"
              title="This task isn't in your list"
              text="It may have been reassigned or removed."
              action={{ label: "Go to Tasks", onPress: () => router.replace("/(tabs)/tasks") }}
            />
          }
        >
          {(tasks) => {
            const found = tasks.find((t) => t.id === id);
            return found ? renderTask(found) : null;
          }}
        </AsyncBlock>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  title: { ...type.title2, color: colors.ink, flex: 1 },
  desc: { ...type.body, lineHeight: 24, color: colors.ink, marginTop: spacing.md },
  inlineError: { ...type.subhead, color: colors.redText, marginTop: spacing.sm },
  hairline: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  comment: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  commentText: { flex: 1, minWidth: 0 },
  commentHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm },
  commentAuthor: { ...type.subhead, fontWeight: "600", color: colors.ink, flexShrink: 1 },
  commentTime: { ...type.footnote, color: colors.tertiary },
  commentBody: { ...type.subhead, color: colors.ink, marginTop: 2, lineHeight: 20 },
  post: { alignSelf: "flex-end", marginTop: spacing.sm },
});
