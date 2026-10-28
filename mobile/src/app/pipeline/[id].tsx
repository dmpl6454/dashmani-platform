import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  FlatList,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Linking,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { todayIST } from "@/lib/api";
import { colors, spacing, radius } from "@/lib/theme";
import { ErrorBanner, Loading } from "@/components/ui";
import { Avatar, usePolling } from "@/components/pipeline";
import {
  PIPELINE_CLIENT_BUILD,
  DEFAULT_POLL_MS,
  classify,
  dayLabel,
  dueColors,
  dueState,
  getBootstrap,
  getDirectory,
  newClientId,
  phaseColor,
  pipe,
  segmentsOf,
  serializeMentions,
  timeLabel,
  type Bootstrap,
  type Directory,
  type Header,
  type Me,
  type Message,
  type Participant,
  type Phase,
  type ProjectDetail,
  type SyncResponse,
} from "@/lib/pipeline";

// One Pipeline project (hr.digitalsukoon.com/pipeline/[id]): its header, the stage it is in,
// and its conversation — top-level messages with one level of replies, the 8 fixed reactions,
// @mentions. New messages, edits and reactions arrive through POST /pipeline/sync while the
// screen is focused; the read marker is acked with every sync and once more on leaving.

const continuous = Platform.OS === "ios" ? ({ borderCurve: "continuous" } as any) : null;

type SheetItem = { label: string; destructive?: boolean; onPress: () => void };

export default function PipelineProject() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const pid = String(id ?? "").toLowerCase();
  const today = todayIST();

  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [dir, setDir] = useState<Directory | null>(null);
  const [header, setHeader] = useState<Header | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [msgs, setMsgs] = useState<Map<string, Message>>(new Map());
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [status, setStatus] = useState<"ok" | "archived" | "deleted">("ok");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingReplies, setLoadingReplies] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Array<{ id: string; name: string }>>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [sheet, setSheet] = useState<{ title: string; items: SheetItem[] } | null>(null);
  const [reactFor, setReactFor] = useState<Message | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);

  const rev = useRef(0);
  const hv = useRef(0);
  const maxSeq = useRef(0);
  const listRef = useRef<FlatList<Message>>(null);
  const atBottom = useRef(true);

  const myId = boot?.enabled ? boot.me.id : null;
  const phases: Phase[] = useMemo(() => (boot?.enabled ? [...boot.phases].sort((a, b) => a.position - b.position) : []), [boot]);
  const phase = phases.find((p) => p.id === header?.phaseId) ?? null;
  const nameOf = useCallback((uid: string) => dir?.byId.get(uid)?.name, [dir]);

  const merge = useCallback((incoming: Message[]) => {
    if (!incoming.length) return;
    setMsgs((prev) => {
      const next = new Map(prev);
      for (const m of incoming) {
        const old = next.get(m.id);
        if (!old || m.rev >= old.rev) next.set(m.id, m);
        if (m.seq > maxSeq.current) maxSeq.current = m.seq;
      }
      return next;
    });
  }, []);

  // ── first load ──
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [b, d, detail] = await Promise.all([
        getBootstrap(),
        getDirectory().catch(() => null),
        pipe<ProjectDetail>(`/projects/${pid}`),
      ]);
      setBoot(b);
      if (d) setDir(d);
      setHeader(detail.header);
      setParticipants(detail.participants);
      setMe(detail.me);
      rev.current = detail.threadRev;
      hv.current = detail.headerRev;
      setHasOlder(detail.hasOlder);
      setStatus(detail.header.deletedAt ? "deleted" : detail.header.archivedAt ? "archived" : "ok");
      setMsgs(new Map());
      maxSeq.current = detail.me?.lastReadSeq ?? 0;
      merge(detail.messages);
    } catch (e) {
      setLoadError(classify(e).message);
    }
  }, [pid, merge]);

  useEffect(() => {
    load();
  }, [load]);

  // ── sync loop (focused + foreground only) ──
  const sync = useCallback(async (): Promise<number> => {
    if (!header || status === "deleted") return DEFAULT_POLL_MS.project;
    try {
      const r = await pipe<SyncResponse>("/sync", {
        method: "POST",
        body: JSON.stringify({
          clientBuild: PIPELINE_CLIENT_BUILD,
          project: { id: pid, rev: rev.current, hv: hv.current, ack: { seq: maxSeq.current, open: true } },
        }),
      });
      const p = r.project;
      if (p) {
        setStatus(p.status);
        if (p.header) {
          setHeader(p.header);
          hv.current = p.hv;
        }
        if (p.participants) setParticipants(p.participants);
        if (p.me) setMe(p.me);
        merge(p.messages);
        rev.current = p.rev;
        setBanner(r.reload ? "A newer version of the app is needed for Pipeline." : null);
        if (p.hasMore) return 300; // drain the backlog in pages of 50
      }
      return (r.pollMs ?? DEFAULT_POLL_MS).project;
    } catch (e) {
      const c = classify(e);
      setBanner(c.message);
      if (c.kind === "gone") setStatus("deleted");
      return c.retryAfterMs || DEFAULT_POLL_MS.project;
    }
  }, [header, status, pid, merge]);

  const syncNow = usePolling(sync, !!header && status !== "deleted");

  // Read marker on leaving (keepalive — never blocks navigation).
  useEffect(() => {
    return () => {
      if (maxSeq.current > 0) {
        pipe(`/projects/${pid}/read`, { method: "POST", body: JSON.stringify({ seq: maxSeq.current, leaving: true }) }).catch(() => undefined);
      }
    };
  }, [pid]);

  // ── derived lists ──
  const tops = useMemo(() => [...msgs.values()].filter((m) => m.parentId === null).sort((a, b) => a.seq - b.seq), [msgs]);
  const repliesOf = useCallback(
    (rootId: string) => [...msgs.values()].filter((m) => m.parentId === rootId).sort((a, b) => a.seq - b.seq),
    [msgs],
  );

  useEffect(() => {
    if (atBottom.current && tops.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }, [tops.length]);

  // ── actions ──
  const loadOlder = async () => {
    if (loadingOlder || !tops.length) return;
    setLoadingOlder(true);
    try {
      const page = await pipe<{ messages: Message[]; hasOlder: boolean }>(`/projects/${pid}/messages?before=${tops[0].seq}&limit=30`);
      merge(page.messages);
      setHasOlder(page.hasOlder);
    } catch (e) {
      setBanner(classify(e).message);
    } finally {
      setLoadingOlder(false);
    }
  };

  const toggleReplies = async (root: Message) => {
    const open = expanded.has(root.id);
    const next = new Set(expanded);
    if (open) {
      next.delete(root.id);
      setExpanded(next);
      return;
    }
    next.add(root.id);
    setExpanded(next);
    setLoadingReplies(root.id);
    try {
      let after = 0;
      for (let i = 0; i < 10; i++) {
        const page = await pipe<{ root: Message; replies: Message[]; hasMore: boolean }>(`/messages/${root.id}/replies?after=${after}&limit=50`);
        merge([page.root, ...page.replies]);
        if (!page.hasMore || page.replies.length === 0) break;
        after = page.replies[page.replies.length - 1].seq;
      }
    } catch (e) {
      setBanner(classify(e).message);
    } finally {
      setLoadingReplies(null);
    }
  };

  const send = async () => {
    const raw = text.trim();
    if (!raw || sending) return;
    const max = boot?.enabled ? boot.limits.bodyMax : 4000;
    const body = serializeMentions(raw, picked);
    if (body.length > max) return setSendError(`Messages can be up to ${max} characters.`);
    setSending(true);
    setSendError(null);
    try {
      const r = await pipe<{ message: Message; root?: Message }>(`/projects/${pid}/messages`, {
        method: "POST",
        body: JSON.stringify({ clientId: newClientId(), body, ...(replyTo ? { parentId: replyTo.parentId ?? replyTo.id } : {}) }),
      });
      merge(r.root ? [r.root, r.message] : [r.message]);
      if (replyTo) setExpanded((s) => new Set(s).add(replyTo.parentId ?? replyTo.id));
      setText("");
      setPicked([]);
      setReplyTo(null);
      atBottom.current = true;
      syncNow();
    } catch (e) {
      const c = classify(e);
      setSendError(c.kind === "other" ? (e as Error).message || c.message : c.message);
    } finally {
      setSending(false);
    }
  };

  const react = async (m: Message, key: string) => {
    if (!myId) return;
    const on = !(m.reactions[key] ?? []).includes(myId);
    setReactFor(null);
    try {
      const r = await pipe<{ messageId: string; reactions: Message["reactions"]; rev: number }>(`/messages/${m.id}/reactions/${key}`, {
        method: "PUT",
        body: JSON.stringify({ on }),
      });
      merge([{ ...m, reactions: r.reactions, rev: r.rev }]);
    } catch (e) {
      setBanner(classify(e).message);
    }
  };

  const remove = (m: Message) =>
    Alert.alert("Delete message", "Delete this message for everyone?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const r = await pipe<{ message: Message }>(`/messages/${m.id}`, { method: "DELETE" });
            merge([r.message]);
          } catch (e) {
            setBanner(classify(e).message);
          }
        },
      },
    ]);

  const moveTo = async (to: Phase) => {
    if (!header || to.id === header.phaseId) return;
    try {
      await pipe(`/projects/${pid}/move`, {
        method: "POST",
        body: JSON.stringify({ toPhaseId: to.id, afterId: null, basePhaseId: header.phaseId }),
      });
      setHeader({ ...header, phaseId: to.id });
      syncNow();
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "MOVE_CONFLICT") {
        setBanner("Someone moved this project at the same time — showing where it is now.");
        load();
      } else setBanner(classify(e).message);
    }
  };

  const openMessageSheet = (m: Message) => {
    if (m.deletedAt || status !== "ok") return;
    const items: SheetItem[] = [
      { label: "React", onPress: () => setReactFor(m) },
      { label: "Reply", onPress: () => setReplyTo(m) },
    ];
    if (m.authorId === myId) items.push({ label: "Delete", destructive: true, onPress: () => remove(m) });
    setSheet({ title: m.authorName, items });
  };

  const openPhaseSheet = () => {
    if (status !== "ok" || !phases.length) return;
    setSheet({
      title: "Move to stage",
      items: phases.map((p) => ({ label: p.id === header?.phaseId ? `${p.name} (current)` : p.name, onPress: () => moveTo(p) })),
    });
  };

  const pickMention = (uid: string, name: string) => {
    setMentionOpen(false);
    setPicked((p) => (p.some((x) => x.id === uid) ? p : [...p, { id: uid, name }]));
    setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${name} `);
  };

  // ── render ──
  if (loadError && !header) {
    return (
      <View style={styles.fill}>
        <Stack.Screen options={{ title: "Project" }} />
        <View style={{ padding: spacing.lg }}>
          <ErrorBanner message={loadError} />
        </View>
      </View>
    );
  }
  if (!header) {
    return (
      <View style={styles.fill}>
        <Stack.Screen options={{ title: "Project" }} />
        <Loading />
      </View>
    );
  }

  const owner = nameOf(header.ownerId) ?? "—";
  const members = participants.filter((p) => p.role === "MEMBER");
  const followers = participants.length - members.length;
  const due = dueState(header.dueDate, !!phase?.isTerminal, today);
  const dc = dueColors(due);
  const readOnly = status !== "ok";

  const renderBody = (m: Message) => {
    if (m.deletedAt) return <Text style={styles.deleted}>Message deleted</Text>;
    const mentionNames = new Map(m.mentions.map((x) => [x.id, x.name]));
    const segs = segmentsOf(m.body, (uid) => mentionNames.get(uid) ?? nameOf(uid));
    return (
      <Text style={styles.body} selectable>
        {segs.map((s, i) =>
          s.kind === "text" ? (
            <Text key={i}>{s.text}</Text>
          ) : s.kind === "mention" ? (
            <Text key={i} style={styles.mention}>
              @{s.name}
            </Text>
          ) : (
            <Text key={i} style={styles.link} onPress={() => Linking.openURL(s.url).catch(() => undefined)}>
              {s.url}
            </Text>
          ),
        )}
        {m.editedAt ? <Text style={styles.edited}> (edited)</Text> : null}
      </Text>
    );
  };

  const renderReactions = (m: Message) => {
    const entries = Object.entries(m.reactions).filter(([, ids]) => (ids ?? []).length > 0);
    if (!entries.length || m.deletedAt) return null;
    const emojiOf = new Map((boot?.enabled ? boot.reactions : []).map((r) => [r.key, r.emoji]));
    return (
      <View style={styles.reactions}>
        {entries.map(([key, ids]) => {
          const mineOn = !!myId && (ids ?? []).includes(myId);
          return (
            <Pressable
              key={key}
              onPress={() => !readOnly && react(m, key)}
              style={[styles.reaction, continuous, mineOn && { backgroundColor: colors.purpleSoft, borderColor: colors.purple }]}
            >
              <Text style={styles.reactionText}>
                {emojiOf.get(key) ?? key} {(ids ?? []).length}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  };

  const renderOne = (m: Message, reply = false) => (
    <Pressable key={m.id} onLongPress={() => openMessageSheet(m)} delayLongPress={300} style={[styles.msg, reply && styles.reply]}>
      <Avatar name={m.authorName} size={reply ? 24 : 30} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.msgHead}>
          <Text style={styles.author} numberOfLines={1}>
            {m.authorName}
          </Text>
          <Text style={styles.time}>{timeLabel(m.createdAt, today)}</Text>
        </View>
        {renderBody(m)}
        {renderReactions(m)}
      </View>
    </Pressable>
  );

  const renderTop = ({ item: m }: { item: Message }) => {
    const open = expanded.has(m.id);
    const replies = open ? repliesOf(m.id) : [];
    return (
      <View style={styles.topWrap}>
        {renderOne(m)}
        <View style={styles.threadActions}>
          {m.replyCount > 0 ? (
            <Pressable onPress={() => toggleReplies(m)} hitSlop={6}>
              <Text style={styles.threadLink}>
                {open ? "Hide replies" : `${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}`}
              </Text>
            </Pressable>
          ) : null}
          {!readOnly && !m.deletedAt ? (
            <Pressable onPress={() => setReplyTo(m)} hitSlop={6}>
              <Text style={styles.threadLink}>Reply</Text>
            </Pressable>
          ) : null}
        </View>
        {loadingReplies === m.id ? <ActivityIndicator size="small" color={colors.sub} style={{ marginLeft: 44 }} /> : null}
        {replies.map((r) => renderOne(r, true))}
      </View>
    );
  };

  const headerBlock = (
    <View>
      <View style={[styles.headerCard, continuous]}>
        <Text style={styles.projTitle}>{header.title}</Text>
        <View style={styles.headRow}>
          <Pressable onPress={openPhaseSheet} disabled={readOnly} style={[styles.phasePill, continuous]}>
            <View style={[styles.dot, { backgroundColor: phaseColor(phase?.color ?? "") }]} />
            <Text style={styles.phaseText}>{phase?.name ?? "—"}</Text>
            {!readOnly ? <Ionicons name="chevron-down" size={13} color={colors.sub} /> : null}
          </Pressable>
          {header.dueDate ? (
            <View style={[styles.duePill, continuous, { backgroundColor: dc.bg }]}>
              <Text style={[styles.dueText, { color: dc.fg }]}>
                {due === "overdue" ? "Overdue · " : due === "today" ? "Due today · " : "Due "}
                {dayLabel(header.dueDate, today)}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.metaLine}>
          Owner {owner} · {members.length} {members.length === 1 ? "member" : "members"}
          {followers > 0 ? ` · ${followers} following` : ""}
        </Text>
        {members.length ? (
          <Text style={styles.metaLine} numberOfLines={2}>
            {members.map((p) => nameOf(p.userId) ?? "—").join(", ")}
          </Text>
        ) : null}
        {header.description ? <Text style={styles.desc}>{header.description}</Text> : null}
      </View>
      {status === "archived" ? <Text style={styles.notice}>This project is archived — read only.</Text> : null}
      {status === "deleted" ? <Text style={styles.notice}>This project was deleted.</Text> : null}
      {banner ? <Text style={styles.notice}>{banner}</Text> : null}
      {hasOlder ? (
        <Pressable onPress={loadOlder} style={styles.older}>
          {loadingOlder ? <ActivityIndicator size="small" color={colors.sub} /> : <Text style={styles.threadLink}>Load earlier messages</Text>}
        </Pressable>
      ) : null}
      {!tops.length ? <Text style={styles.emptyThread}>No messages yet. Start the conversation.</Text> : null}
    </View>
  );

  const pickable = (dir?.list ?? []).filter((d) => d.pickable && d.id !== myId);

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: "Project" }} />
      <FlatList
        ref={listRef}
        data={tops}
        keyExtractor={(m) => m.id}
        renderItem={renderTop}
        ListHeaderComponent={headerBlock}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.lg }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
        }}
        scrollEventThrottle={100}
        keyboardShouldPersistTaps="handled"
      />

      {!readOnly ? (
        <View style={styles.composer}>
          {replyTo ? (
            <View style={styles.replyChip}>
              <Text style={styles.replyChipText} numberOfLines={1}>
                Replying to {replyTo.authorName}
              </Text>
              <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={17} color={colors.sub} />
              </Pressable>
            </View>
          ) : null}
          {sendError ? <Text style={styles.sendError}>{sendError}</Text> : null}
          <View style={styles.inputRow}>
            <Pressable onPress={() => setMentionOpen(true)} hitSlop={8} accessibilityLabel="Mention someone">
              <Ionicons name="at" size={22} color={colors.sub} />
            </Pressable>
            <TextInput
              value={text}
              onChangeText={(t) => {
                setText(t);
                if (sendError) setSendError(null);
              }}
              placeholder={replyTo ? "Write a reply…" : "Write a message…"}
              placeholderTextColor={colors.faint}
              multiline
              style={[styles.input, continuous]}
            />
            <Pressable onPress={send} disabled={!text.trim() || sending} hitSlop={8} accessibilityLabel="Send">
              {sending ? (
                <ActivityIndicator size="small" color={colors.purple} />
              ) : (
                <Ionicons name="arrow-up-circle" size={30} color={text.trim() ? colors.purple : colors.faint} />
              )}
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Action sheet */}
      <Modal visible={!!sheet} transparent animationType="fade" onRequestClose={() => setSheet(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSheet(null)}>
          <View style={[styles.sheet, continuous]}>
            <Text style={styles.sheetTitle}>{sheet?.title}</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {sheet?.items.map((it) => (
                <Pressable
                  key={it.label}
                  onPress={() => {
                    setSheet(null);
                    it.onPress();
                  }}
                  style={({ pressed }) => [styles.sheetItem, pressed && { opacity: 0.6 }]}
                >
                  <Text style={[styles.sheetItemText, it.destructive && { color: colors.red }]}>{it.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable onPress={() => setSheet(null)} style={styles.sheetItem}>
              <Text style={[styles.sheetItemText, { fontWeight: "600" }]}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Reaction picker — the fixed 8 */}
      <Modal visible={!!reactFor} transparent animationType="fade" onRequestClose={() => setReactFor(null)}>
        <Pressable style={styles.backdrop} onPress={() => setReactFor(null)}>
          <View style={[styles.reactSheet, continuous]}>
            {(boot?.enabled ? boot.reactions : []).map((r) => (
              <Pressable key={r.key} onPress={() => reactFor && react(reactFor, r.key)} style={styles.reactBtn}>
                <Text style={{ fontSize: 28 }}>{r.emoji}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Mention picker */}
      <Modal visible={mentionOpen} transparent animationType="slide" onRequestClose={() => setMentionOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMentionOpen(false)}>
          <View style={[styles.sheet, continuous]}>
            <Text style={styles.sheetTitle}>Mention someone</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {pickable.length === 0 ? <Text style={styles.emptyThread}>Loading people…</Text> : null}
              {pickable.map((d) => (
                <Pressable key={d.id} onPress={() => pickMention(d.id, d.name)} style={({ pressed }) => [styles.sheetItem, pressed && { opacity: 0.6 }]}>
                  <Text style={styles.sheetItemText}>
                    {d.name}
                    {d.hint ? <Text style={{ color: colors.sub }}> · {d.hint}</Text> : null}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  headerCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  projTitle: { fontSize: 20, fontWeight: "700", color: colors.ink },
  headRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" },
  phasePill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.cardHigh, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 5 },
  phaseText: { fontSize: 13, fontWeight: "600", color: colors.ink },
  dot: { width: 8, height: 8, borderRadius: 4 },
  duePill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm },
  dueText: { fontSize: 12, fontWeight: "600" },
  metaLine: { fontSize: 12.5, color: colors.sub, marginTop: 8 },
  desc: { fontSize: 14, color: colors.ink, marginTop: 10, lineHeight: 20 },
  notice: { fontSize: 12.5, color: colors.sub, marginBottom: spacing.md },
  older: { alignItems: "center", paddingVertical: 10 },
  emptyThread: { fontSize: 13, color: colors.faint, textAlign: "center", paddingVertical: spacing.lg },
  topWrap: { marginBottom: spacing.md },
  msg: { flexDirection: "row", gap: 10, paddingVertical: 4 },
  reply: { marginLeft: 40, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: colors.border },
  msgHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { fontSize: 14, fontWeight: "600", color: colors.ink, flexShrink: 1 },
  time: { fontSize: 11.5, color: colors.faint },
  body: { fontSize: 15, color: colors.ink, lineHeight: 21, marginTop: 2 },
  mention: { color: colors.purple, fontWeight: "600" },
  link: { color: colors.blue, textDecorationLine: "underline" },
  edited: { fontSize: 12, color: colors.faint },
  deleted: { fontSize: 14, color: colors.faint, fontStyle: "italic", marginTop: 2 },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  reaction: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  reactionText: { fontSize: 13, color: colors.ink },
  threadActions: { flexDirection: "row", gap: 16, marginLeft: 40, marginTop: 2 },
  threadLink: { fontSize: 13, color: colors.purple, fontWeight: "600" },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.barBg, paddingHorizontal: spacing.md, paddingTop: 8, paddingBottom: 28 },
  replyChip: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6, paddingHorizontal: 4 },
  replyChipText: { flex: 1, fontSize: 12.5, color: colors.sub },
  sendError: { fontSize: 12.5, color: colors.red, marginBottom: 6, paddingHorizontal: 4 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  input: { flex: 1, maxHeight: 120, minHeight: 38, backgroundColor: colors.cardHigh, borderRadius: radius.lg, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 9, fontSize: 16, color: colors.ink },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end", padding: spacing.md },
  sheet: { backgroundColor: colors.card, borderRadius: radius.xl, paddingVertical: spacing.sm, marginBottom: spacing.lg },
  sheetTitle: { fontSize: 13, color: colors.sub, textAlign: "center", paddingVertical: 10 },
  sheetItem: { paddingVertical: 14, paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  sheetItemText: { fontSize: 17, color: colors.ink, textAlign: "center" },
  reactSheet: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.md, marginBottom: spacing.xl, gap: 6 },
  reactBtn: { padding: 8 },
});
