import React, { useState } from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { apiFetch, fmtDateTime } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, Field, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function AdminAnnouncements() {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any>(() => apiFetch("/admin/announcements"));

  const send = () => {
    setError(null);
    if (!title.trim() || !message.trim()) {
      setError("Title and message are required");
      return;
    }
    Alert.alert("Send announcement?", "This will notify ALL active employees.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Send",
        onPress: async () => {
          setSending(true);
          try {
            await apiFetch("/admin/announcements", {
              method: "POST",
              body: JSON.stringify({ title: title.trim(), message: message.trim() }),
            });
            setTitle("");
            setMessage("");
            setShowForm(false);
            setSuccessMsg("Announcement sent to the team");
            reload();
          } catch (e: any) {
            setError(e?.message || "Could not send");
          } finally {
            setSending(false);
          }
        },
      },
    ]);
  };

  if (loading) return <Loading />;
  // API returns a paginated envelope {items, total, page, limit}
  const items: any[] = Array.isArray(data) ? data : data?.items ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />
      {!showForm && (
        <Button title="+ New Announcement" onPress={() => { setSuccessMsg(null); setShowForm(true); }} style={{ marginBottom: spacing.md }} />
      )}

      {showForm && (
        <>
          <SectionTitle>Broadcast to Team</SectionTitle>
          <Card>
            <Field label="Title" value={title} onChangeText={setTitle} autoCapitalize="sentences" placeholder="e.g. Office closed Friday" />
            <Field label="Message" value={message} onChangeText={setMessage} multiline autoCapitalize="sentences" placeholder="Details…" />
            <Button title="Send to Everyone" onPress={send} loading={sending} />
            <Button title="Cancel" onPress={() => setShowForm(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </Card>
        </>
      )}

      <SectionTitle>Recent Announcements</SectionTitle>
      <Card>
        {items.length === 0 ? (
          <Empty icon="megaphone-outline" text="No announcements yet" />
        ) : (
          items.map((a: any, i: number) => (
            <View key={a.id} style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
              <Text style={styles.title}>{a.title}</Text>
              <Text style={styles.message}>{a.message}</Text>
              <Text style={styles.meta}>
                {a.createdByUser?.name ?? a.author?.name ?? ""} · {fmtDateTime(a.createdAt)}
              </Text>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  title: { fontSize: 14, fontWeight: "700", color: colors.ink },
  message: { fontSize: 13, color: colors.sub, marginTop: 4, lineHeight: 18 },
  meta: { fontSize: 11, color: colors.faint, marginTop: 6 },
});
