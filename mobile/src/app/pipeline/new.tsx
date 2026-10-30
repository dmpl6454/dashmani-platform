import React, { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { addDaysISO, todayIST } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Chips, Empty, ErrorBanner, Field, Screen, SectionTitle, useApi } from "@/components/ui";
import { AsyncBlock, AsyncList } from "@/components/async";
import { ListItem } from "@/components/list";
import { SkeletonForm } from "@/components/skeleton";
import { DateField } from "@/components/date-field";
import { toast } from "@/components/feedback";
import {
  classify,
  dayLabel,
  getBootstrap,
  getDirectory,
  newClientId,
  pipe,
  type Bootstrap,
  type DirectoryEntry,
} from "@/lib/pipeline";

// New Pipeline project (any active HR user may create one; the creator is the owner).
// POST /pipeline/projects with a client-generated clientId, so a double tap creates one project.

type LiveBootstrap = Extract<Bootstrap, { enabled: true }>;

export default function NewPipelineProject() {
  const boot = useApi(() => getBootstrap(), []);
  const live = boot.data && boot.data.enabled ? boot.data : null;

  if (live) {
    return (
      <>
        <Stack.Screen options={{ title: "New project" }} />
        <NewProjectForm boot={live} />
      </>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: "New project" }} />
      <AsyncBlock
        state={boot}
        skeleton={<SkeletonForm fields={4} />}
        empty={
          <Empty
            icon="lock-closed-outline"
            title="Pipeline needs the employee portal"
            text="Sign in to the employee portal to create projects."
          />
        }
      >
        {() => <Empty icon="pause-circle-outline" title="Pipeline is paused" text="It will come back on its own." />}
      </AsyncBlock>
    </Screen>
  );
}

function NewProjectForm({ boot }: { boot: LiveBootstrap }) {
  const router = useRouter();
  const today = todayIST();
  const phases = useMemo(() => [...boot.phases].sort((a, b) => a.position - b.position), [boot.phases]);
  const max = boot.limits.membersPerRequestMax;
  const directory = useApi(() => getDirectory().then((d) => d.list), []);

  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [phaseId, setPhaseId] = useState<string>(phases[0]?.id ?? "");
  const [dueDate, setDueDate] = useState("");
  const [dueError, setDueError] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(newClientId);

  const q = query.trim().toLowerCase();
  const people: DirectoryEntry[] = (directory.data ?? [])
    .filter((d) => d.pickable && d.id !== boot.me.id)
    .filter((d) => !q || d.name.toLowerCase().includes(q))
    .slice(0, 40);

  const toggle = (id: string) =>
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : m.length >= max ? m : [...m, id]));

  const create = async () => {
    setError(null);
    const t = title.trim();
    if (!t) {
      setTitleError("Give the project a title.");
      return;
    }
    if (dueDate && dueDate < today) {
      setDueError("The due date is in the past.");
      return;
    }
    setBusy(true);
    try {
      const r = await pipe<{ card: { id: string } }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          clientId,
          title: t,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(phaseId ? { phaseId } : {}),
          ...(dueDate ? { dueDate } : {}),
          ...(members.length ? { memberIds: members } : {}),
        }),
      });
      void haptic("success");
      toast.show({ message: "Project created", tone: "success" });
      router.replace(`/pipeline/${r.card.id}`);
    } catch (e) {
      void haptic("error");
      setError(classify(e).message);
      setBusy(false);
    }
  };

  const phaseLabels: Record<string, string> = Object.fromEntries(phases.map((p) => [p.id, p.name]));

  return (
    <Screen
      footerInset
      footer={
        <View>
          {error ? <ErrorBanner message={error} style={styles.footerError} /> : null}
          <Button title="Create project" onPress={create} loading={busy} />
        </View>
      }
    >
      <Field
        label="Title"
        value={title}
        onChangeText={(v) => {
          setTitle(v);
          if (titleError) setTitleError(null);
        }}
        placeholder="e.g. Diwali launch — Brand X"
        autoCapitalize="sentences"
        maxLength={boot.limits.titleMax}
        error={titleError}
        required
      />
      <Field
        label="Description (optional)"
        value={description}
        onChangeText={setDescription}
        multiline
        autoCapitalize="sentences"
      />

      {phases.length > 0 ? (
        <>
          <SectionTitle>Stage</SectionTitle>
          <Chips
            options={phases.map((p) => p.id)}
            value={phaseId}
            onChange={setPhaseId}
            labels={phaseLabels}
            accessibilityLabel="Stage"
          />
        </>
      ) : null}

      <DateField
        label="Due date (optional)"
        value={dueDate}
        onChange={(v) => {
          setDueDate(v);
          setDueError(null);
        }}
        minimumDate={today}
        placeholder="No due date"
        error={dueError}
        hint={dueDate ? `Due ${dayLabel(dueDate, today)}` : "Leave empty for no due date."}
        quick={[
          { label: "In 3 days", value: addDaysISO(today, 3) },
          { label: "In a week", value: addDaysISO(today, 7) },
          { label: "In 2 weeks", value: addDaysISO(today, 14) },
        ]}
      />

      <SectionTitle
        right={
          <Text style={styles.count}>
            {members.length}/{max}
          </Text>
        }
      >
        Members
      </SectionTitle>
      <Field
        value={query}
        onChangeText={setQuery}
        placeholder="Search people"
        leading="search-outline"
        autoCapitalize="none"
        accessibilityLabel="Search people"
      />
      <AsyncList<DirectoryEntry>
        state={directory}
        items={people}
        filterActive={q.length > 0}
        onClearFilter={() => setQuery("")}
        grouped
        skeletonCount={5}
        keyExtractor={(d) => d.id}
        empty={{ icon: "people-outline", title: "No one to add", text: "There is no one else you can add yet." }}
        renderItem={(d) => {
          const on = members.includes(d.id);
          return (
            <ListItem
              title={d.name}
              subtitle={d.hint}
              selected={on}
              disabled={!on && members.length >= max}
              onPress={() => toggle(d.id)}
              accessibilityLabel={d.hint ? `${d.name}, ${d.hint}` : d.name}
              accessibilityHint={on ? "Removes this person from the project" : "Adds this person to the project"}
            />
          );
        }}
      />
      <Text style={styles.hint}>You are the owner. Members are notified; anyone on the team can still open the project.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  count: { ...type.footnote, ...type.numeric, color: colors.sub },
  hint: { ...type.footnote, color: colors.sub, marginTop: spacing.sm },
  footerError: { marginBottom: spacing.sm },
});
