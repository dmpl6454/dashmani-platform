import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Platform } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { daysAgoIST, todayIST } from "@/lib/api";
import { colors, spacing, radius } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, Field, Chips, ErrorBanner, Loading } from "@/components/ui";
import { classify, dayLabel, getBootstrap, getDirectory, newClientId, pipe, type Bootstrap, type Directory } from "@/lib/pipeline";

// New Pipeline project (any active HR user may create one; the creator is the owner).
// POST /pipeline/projects with a client-generated clientId, so a double tap creates one project.

const continuous = Platform.OS === "ios" ? ({ borderCurve: "continuous" } as any) : null;
const DUE_PRESETS = ["none", "3d", "1w", "2w", "custom"] as const;
type DuePreset = (typeof DUE_PRESETS)[number];
const PRESET_DAYS: Partial<Record<DuePreset, number>> = { "3d": 3, "1w": 7, "2w": 14 };

export default function NewPipelineProject() {
  const router = useRouter();
  const today = todayIST();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [dir, setDir] = useState<Directory | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [phaseId, setPhaseId] = useState<string>("");
  const [preset, setPreset] = useState<DuePreset>("none");
  const [custom, setCustom] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(newClientId);

  useEffect(() => {
    getBootstrap()
      .then((b) => {
        setBoot(b);
        if (b?.enabled) setPhaseId([...b.phases].sort((a, c) => a.position - c.position)[0]?.id ?? "");
      })
      .catch((e) => setError(classify(e).message));
    getDirectory().then(setDir).catch(() => undefined);
  }, []);

  const dueDate = useMemo(() => {
    if (preset === "none") return null;
    if (preset === "custom") return /^\d{4}-\d{2}-\d{2}$/.test(custom.trim()) ? custom.trim() : null;
    return daysAgoIST(-(PRESET_DAYS[preset] ?? 0));
  }, [preset, custom]);

  if (!boot) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Stack.Screen options={{ title: "New project" }} />
        {error ? <View style={{ padding: spacing.lg }}><ErrorBanner message={error} /></View> : <Loading />}
      </View>
    );
  }
  if (!boot.enabled) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "New project" }} />
        <ErrorBanner message="Pipeline is paused. It will come back on its own." />
      </Screen>
    );
  }

  const phases = [...boot.phases].sort((a, b) => a.position - b.position);
  const max = boot.limits.membersPerRequestMax;
  const people = (dir?.list ?? [])
    .filter((d) => d.pickable && d.id !== boot.me.id)
    .filter((d) => !query.trim() || d.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 40);

  const toggle = (id: string) =>
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : m.length >= max ? m : [...m, id]));

  const create = async () => {
    setError(null);
    if (!title.trim()) return setError("Give the project a title.");
    if (preset === "custom" && !dueDate) return setError("Enter the due date as YYYY-MM-DD, or pick another option.");
    if (dueDate && dueDate < today) return setError("The due date is in the past.");
    setBusy(true);
    try {
      const r = await pipe<{ card: { id: string } }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          clientId,
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(phaseId ? { phaseId } : {}),
          ...(dueDate ? { dueDate } : {}),
          ...(members.length ? { memberIds: members } : {}),
        }),
      });
      router.replace(`/pipeline/${r.card.id}`);
    } catch (e) {
      const c = classify(e);
      setError(c.kind === "other" ? (e as Error).message || c.message : c.message);
      setBusy(false);
    }
  };

  const phaseLabels = Object.fromEntries(phases.map((p) => [p.id, p.name]));
  return (
    <Screen>
      <Stack.Screen options={{ title: "New project" }} />
      <ErrorBanner message={error} />

      <Field label="Title" value={title} onChangeText={setTitle} placeholder="e.g. Diwali launch — Brand X" autoCapitalize="sentences" />
      <Field label="Description (optional)" value={description} onChangeText={setDescription} multiline autoCapitalize="sentences" />

      <SectionTitle>Stage</SectionTitle>
      <Chips options={phases.map((p) => p.id)} value={phaseId} onChange={setPhaseId} labels={phaseLabels} />

      <SectionTitle>Due date</SectionTitle>
      <Chips
        options={DUE_PRESETS}
        value={preset}
        onChange={setPreset}
        labels={{ none: "None", "3d": "In 3 days", "1w": "In a week", "2w": "In 2 weeks", custom: "Pick a date" }}
      />
      {preset === "custom" ? (
        <Field label="Due date (YYYY-MM-DD)" value={custom} onChangeText={setCustom} placeholder={daysAgoIST(-10)} keyboardType="numbers-and-punctuation" />
      ) : null}
      {dueDate ? <Text style={styles.hint}>Due {dayLabel(dueDate, today)}</Text> : null}

      <SectionTitle right={<Text style={styles.count}>{members.length}/{max}</Text>}>Members</SectionTitle>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search people"
        placeholderTextColor={colors.faint}
        style={[styles.search, continuous]}
        autoCapitalize="none"
      />
      <Card style={{ padding: 0 }}>
        {!dir ? (
          <Loading />
        ) : people.length === 0 ? (
          <Text style={styles.none}>No one matches.</Text>
        ) : (
          people.map((d, i) => {
            const on = members.includes(d.id);
            return (
              <Pressable key={d.id} onPress={() => toggle(d.id)} style={[styles.person, i > 0 && styles.divider]}>
                <Text style={styles.personName} numberOfLines={1}>
                  {d.name}
                  {d.hint ? <Text style={{ color: colors.sub }}> · {d.hint}</Text> : null}
                </Text>
                <Ionicons name={on ? "checkmark-circle" : "ellipse-outline"} size={22} color={on ? colors.purple : colors.faint} />
              </Pressable>
            );
          })
        )}
      </Card>
      <Text style={styles.hint}>You are the owner. Members are notified; anyone on the team can still open the project.</Text>

      <Button title="Create project" onPress={create} loading={busy} style={{ marginTop: spacing.lg }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12.5, color: colors.sub, marginTop: -4, marginBottom: spacing.md },
  count: { fontSize: 12, color: colors.faint },
  search: { backgroundColor: colors.cardHigh, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: colors.ink, marginBottom: spacing.sm },
  none: { fontSize: 13, color: colors.faint, padding: spacing.lg },
  person: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: spacing.lg, gap: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  personName: { flex: 1, fontSize: 15, color: colors.ink },
});
