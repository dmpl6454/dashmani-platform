import React, { useContext, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { apiFetch, describeError } from "@/lib/api";
import { haptic } from "@/lib/device";
import { colors, isDark, radius, sizes, spacing, type } from "@/lib/theme";
import { Empty, IconButton } from "@/components/ui";

// AI Assistant (POST /admin/ai/assist). Renders its own KeyboardAvoidingView root instead of
// <Screen> so the composer stays pinned above the keyboard; the stack header is opaque.

type Msg = { id: number; role: "user" | "assistant"; text: string; failed: boolean };

/** Compact iOS navigation bar height under the status bar (the large title collapses while typing). */
const NAV_BAR_HEIGHT = 44;
const REPLY_KEYS = ["result", "text", "message"] as const;

function replyText(res: unknown): string {
  if (typeof res === "string") return res;
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    for (const k of REPLY_KEYS) {
      const v = r[k];
      if (v !== undefined && v !== null) return typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return JSON.stringify(res) ?? "";
}

export default function AdminAi() {
  const insets = useContext(SafeAreaInsetsContext);
  const topInset = insets?.top ?? 0;
  const bottomInset = insets?.bottom ?? 0;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const nextId = useRef(0);
  const canSend = !busy && input.trim().length > 0;

  const push = (role: Msg["role"], text: string, failed = false) => {
    const id = nextId.current;
    nextId.current += 1;
    setMessages((m) => [...m, { id, role, text, failed }]);
  };

  const send = async () => {
    const task = input.trim();
    if (!task || busy) return;
    setInput("");
    push("user", task);
    setBusy(true);
    try {
      const res = await apiFetch<unknown>("/admin/ai/assist", {
        method: "POST",
        body: JSON.stringify({ task }),
      });
      push("assistant", replyText(res));
    } catch (e) {
      push("assistant", describeError(e, "AI request failed"), true);
      void haptic("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? topInset + NAV_BAR_HEIGHT : 0}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 ? (
          <Empty
            icon="sparkles"
            tone="brand"
            title="AI Assistant"
            text="Ask anything about running the agency — draft an announcement, summarize a policy, plan a campaign, write a job description…"
          />
        ) : null}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
        {busy ? (
          <View
            style={[styles.bubble, styles.aiBubble, styles.thinking]}
            accessible
            accessibilityLabel="The assistant is thinking"
            accessibilityLiveRegion="polite"
          >
            <ActivityIndicator size="small" color={colors.sub} />
            <Text maxFontSizeMultiplier={1.6} style={styles.thinkingText}>
              Thinking…
            </Text>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.inputRow, { paddingBottom: Math.max(bottomInset, spacing.md) }]}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask the assistant…"
          placeholderTextColor={colors.faint}
          keyboardAppearance={isDark ? "dark" : "light"}
          maxFontSizeMultiplier={1.6}
          accessibilityLabel="Message the AI assistant"
          style={styles.input}
          multiline
        />
        <IconButton
          icon="arrow-up"
          label="Send"
          variant="filled"
          onPress={() => void send()}
          disabled={!canSend}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const mine = msg.role === "user";
  const who = mine ? "You" : msg.failed ? "Assistant error" : "Assistant";
  return (
    <View
      style={[styles.bubble, mine ? styles.userBubble : msg.failed ? styles.failedBubble : styles.aiBubble]}
      accessible
      accessibilityLabel={`${who}: ${msg.text}`}
    >
      <Text
        selectable
        maxFontSizeMultiplier={1.6}
        style={[styles.bubbleText, mine ? styles.userText : msg.failed ? styles.failedText : null]}
      >
        {msg.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xl, flexGrow: 1 },
  bubble: { maxWidth: "86%", borderRadius: radius.xl, paddingHorizontal: 14, paddingVertical: 10, marginBottom: spacing.sm },
  userBubble: { alignSelf: "flex-end", backgroundColor: colors.purple },
  aiBubble: { alignSelf: "flex-start", backgroundColor: colors.card },
  failedBubble: { alignSelf: "flex-start", backgroundColor: colors.redSoft },
  bubbleText: { ...type.body, color: colors.ink, lineHeight: 22 },
  userText: { color: colors.inkOnAccent },
  failedText: { color: colors.redText },
  thinking: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  thinkingText: { ...type.subhead, color: colors.sub },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.barBg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    ...type.body,
    flex: 1,
    minHeight: sizes.touch,
    maxHeight: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 22,
    backgroundColor: colors.inputOnPage,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    color: colors.ink,
  },
});
