import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetch, errorMessage, fmtDateTime } from "@/lib/api";
import { colors, motion, type, spacing } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Card, ErrorBanner, Field, Screen, SectionTitle, useApi } from "@/components/ui";
import { Sheet } from "@/components/sheet";
import { AsyncList } from "@/components/async";
import { confirm, toast } from "@/components/feedback";

type Announcement = {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  recipientCount?: number | null;
  sentBy?: { name?: string | null } | null;
  createdByUser?: { name?: string | null } | null;
  author?: { name?: string | null } | null;
  orgUnit?: { name?: string | null } | null;
};

// GET /admin/announcements returns a paginated envelope { items, total, page, limit }.
type AnnouncementPage = Announcement[] | { items?: Announcement[] | null };

type FormErrors = { title: string | null; message: string | null };

/** Lets one bottom sheet finish closing before the next one is presented (iOS Modal stacking). */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function joinParts(parts: Array<string | null | undefined>, sep = " · "): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(sep);
}

export default function AdminAnnouncements() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({ title: null, message: null });

  const list = useApi<Announcement[]>(async () => {
    const page = await apiFetch<AnnouncementPage>("/admin/announcements");
    if (Array.isArray(page)) return page;
    return page?.items ?? [];
  });

  const openComposer = () => {
    setFormError(null);
    setOpen(true);
  };

  const reopenComposer = async () => {
    await pause(motion.slow);
    setOpen(true);
  };

  const send = async () => {
    const t = title.trim();
    const m = message.trim();
    const errs: FormErrors = { title: t ? null : "Add a title", message: m ? null : "Write the message" };
    setFieldErrors(errs);
    if (errs.title || errs.message) return;
    setFormError(null);

    setOpen(false);
    await pause(motion.slow);
    const ok = await confirm({
      title: "Send announcement?",
      message: "Every active employee gets this as a notification.",
      confirmLabel: "Send",
    });
    if (!ok) {
      await reopenComposer();
      return;
    }

    setSending(true);
    try {
      await apiFetch("/admin/announcements", {
        method: "POST",
        body: JSON.stringify({ title: t, message: m }),
      });
      setTitle("");
      setMessage("");
      void haptic("success");
      toast.show({ message: "Announcement sent to the team", tone: "success" });
      await list.reload();
    } catch (e) {
      void haptic("error");
      setFormError(errorMessage(e, "Could not send the announcement"));
      await reopenComposer();
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      <AsyncList
        state={list}
        skeleton="cards"
        header={
          <>
            <Button
              title={sending ? "Sending…" : "New announcement"}
              icon="megaphone-outline"
              onPress={openComposer}
              loading={sending}
              disabled={sending}
            />
            <SectionTitle>Recent announcements</SectionTitle>
          </>
        }
        keyExtractor={(a) => a.id}
        renderItem={(a) => {
          const sender = a.sentBy?.name ?? a.createdByUser?.name ?? a.author?.name;
          const recipients =
            typeof a.recipientCount === "number"
              ? `${a.recipientCount} ${a.recipientCount === 1 ? "recipient" : "recipients"}`
              : null;
          return (
            <Card>
              <Text maxFontSizeMultiplier={1.6} style={styles.title}>
                {a.title}
              </Text>
              <Text maxFontSizeMultiplier={1.6} style={styles.message}>
                {a.message}
              </Text>
              <Text maxFontSizeMultiplier={1.6} style={styles.meta}>
                {joinParts([sender, a.orgUnit?.name ? `To ${a.orgUnit.name}` : null, recipients, fmtDateTime(a.createdAt)])}
              </Text>
            </Card>
          );
        }}
        empty={{
          icon: "megaphone-outline",
          title: "No announcements yet",
          text: "Announcements you send reach every active employee.",
          action: { label: "New announcement", onPress: openComposer },
        }}
      />

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="New announcement"
        subtitle="Every active employee gets this as a notification."
        footer={<Button title="Send to everyone" onPress={send} loading={sending} />}
      >
        <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />
        <Field
          label="Title"
          value={title}
          onChangeText={(v) => {
            setTitle(v);
            if (fieldErrors.title) setFieldErrors((p) => ({ ...p, title: null }));
          }}
          autoCapitalize="sentences"
          placeholder="e.g. Office closed Friday"
          error={fieldErrors.title}
          returnKeyType="next"
          required
        />
        <Field
          label="Message"
          value={message}
          onChangeText={(v) => {
            setMessage(v);
            if (fieldErrors.message) setFieldErrors((p) => ({ ...p, message: null }));
          }}
          multiline
          autoCapitalize="sentences"
          placeholder="Details…"
          error={fieldErrors.message}
          required
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...type.headline, color: colors.ink },
  message: { ...type.subhead, color: colors.sub, marginTop: spacing.xs, lineHeight: 20 },
  meta: { ...type.footnote, color: colors.tertiary, marginTop: spacing.sm },
});
