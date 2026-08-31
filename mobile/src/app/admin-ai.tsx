import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";

type Msg = { role: "user" | "assistant"; text: string };

export default function AdminAi() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const send = async () => {
    const task = input.trim();
    if (!task || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: task }]);
    setBusy(true);
    try {
      const res = await apiFetch<any>("/admin/ai/assist", {
        method: "POST",
        body: JSON.stringify({ task }),
      });
      const text = typeof res === "string" ? res : res?.result ?? res?.text ?? res?.message ?? JSON.stringify(res);
      setMessages((m) => [...m, { role: "assistant", text }]);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠️ ${e?.message || "AI request failed"}` }]);
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, paddingBottom: 24 }}>
        {messages.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="sparkles" size={30} color={colors.purple} />
            <Text style={styles.emptyTitle}>AI Assistant</Text>
            <Text style={styles.emptyText}>
              Ask anything about running the agency — draft an announcement, summarize a policy, plan a campaign, write
              a job description…
            </Text>
          </View>
        )}
        {messages.map((m, i) => (
          <View key={i} style={[styles.bubble, m.role === "user" ? styles.userBubble : styles.aiBubble]}>
            <Text style={[styles.bubbleText, m.role === "user" && { color: "#fff" }]}>{m.text}</Text>
          </View>
        ))}
        {busy && (
          <View style={[styles.bubble, styles.aiBubble]}>
            <Text style={styles.bubbleText}>Thinking…</Text>
          </View>
        )}
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask the assistant…"
          placeholderTextColor={colors.faint}
          style={styles.input}
          multiline
        />
        <Pressable onPress={send} disabled={busy || !input.trim()} style={[styles.sendBtn, (busy || !input.trim()) && { opacity: 0.4 }]}>
          <Ionicons name="arrow-up" size={20} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", paddingVertical: 60, gap: 8, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
  emptyText: { fontSize: 13, color: colors.sub, textAlign: "center", lineHeight: 19 },
  bubble: { maxWidth: "86%", borderRadius: radius.lg, padding: 12, marginBottom: 10 },
  userBubble: { alignSelf: "flex-end", backgroundColor: colors.purple },
  aiBubble: { alignSelf: "flex-start", backgroundColor: colors.cardHigh, borderWidth: 1, borderColor: colors.border },
  bubbleText: { fontSize: 14, color: colors.ink, lineHeight: 20 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: spacing.md, paddingBottom: spacing.xl, backgroundColor: colors.bg },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.lg,
    backgroundColor: colors.cardHigh,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: colors.ink,
  },
  sendBtn: { width: 44, height: 44, borderRadius: radius.full, backgroundColor: colors.purple, alignItems: "center", justifyContent: "center" },
});
