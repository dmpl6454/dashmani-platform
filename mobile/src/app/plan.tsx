import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { addDaysISO, apiFetch, describeError, fieldErrorMap, fmtDay, istDateOf } from "@/lib/api";
import { haptic } from "@/lib/device";
import { useDayChange } from "@/lib/hooks/shared";
import { colors, spacing, type } from "@/lib/theme";
import { Button, Card, Empty, Field, Screen, SectionTitle, useApi } from "@/components/ui";
import { DateTile, ListGroup, ListItem } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonForm, SkeletonList } from "@/components/skeleton";
import { toast } from "@/components/feedback";

type PoaEntry = {
  id: string;
  date: string;
  tasks?: string | null;
  achievements?: string | null;
  blockers?: string | null;
  tomorrowPlan?: string | null;
};

function dayOf(e: PoaEntry): string {
  return istDateOf(e.date) ?? String(e.date).slice(0, 10);
}

export default function PlanScreen() {
  const [tasks, setTasks] = useState("");
  const [achievements, setAchievements] = useState("");
  const [blockers, setBlockers] = useState("");
  const [tomorrowPlan, setTomorrowPlan] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const hydratedRef = useRef<string | null>(null);

  // A new IST day: yesterday's plan is locked, so start today's form empty.
  const today = useDayChange(() => {
    hydratedRef.current = null;
    setTasks("");
    setAchievements("");
    setBlockers("");
    setTomorrowPlan("");
    setSaveError(null);
    setFieldErrs({});
  });

  const state = useApi<PoaEntry[]>(
    () => apiFetch<PoaEntry[]>(`/hr/poa?from=${addDaysISO(today, -13)}&to=${today}`),
    [today],
  );

  const entries = state.data ?? [];
  const todayEntry = entries.find((e) => dayOf(e) === today);
  const past = entries.filter((e) => dayOf(e) !== today);

  // Prefill once per saved entry, so a refresh never overwrites what is being typed.
  useEffect(() => {
    if (!todayEntry || hydratedRef.current === todayEntry.id) return;
    hydratedRef.current = todayEntry.id;
    setTasks(todayEntry.tasks ?? "");
    setAchievements(todayEntry.achievements ?? "");
    setBlockers(todayEntry.blockers ?? "");
    setTomorrowPlan(todayEntry.tomorrowPlan ?? "");
  }, [todayEntry]);

  const onTasksChange = (t: string) => {
    setTasks(t);
    if (fieldErrs.tasks) setFieldErrs((prev) => ({ ...prev, tasks: "" }));
  };

  const save = async () => {
    setSaveError(null);
    setFieldErrs({});
    if (!tasks.trim()) {
      setFieldErrs({ tasks: "Add what you'll work on today" });
      void haptic("warning");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/hr/poa", {
        method: "POST",
        body: JSON.stringify({
          date: today,
          tasks: tasks.trim(),
          achievements: achievements.trim() || undefined,
          blockers: blockers.trim() || undefined,
          tomorrowPlan: tomorrowPlan.trim() || undefined,
        }),
      });
      void haptic("success");
      toast.show({ message: todayEntry ? "Plan updated" : "Plan of Action saved", tone: "success" });
      void state.reload();
    } catch (e: unknown) {
      setFieldErrs(fieldErrorMap(e));
      setSaveError(describeError(e, "Could not save your plan. Please try again."));
      void haptic("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonForm fields={4} />
            <SkeletonList rows={3} />
          </>
        }
      >
        {() => (
          <>
            <SectionTitle>{`Today · ${fmtDay(today)}`}</SectionTitle>
            <Card>
              <Field
                label="Tasks for today"
                required
                value={tasks}
                onChangeText={onTasksChange}
                multiline
                autoCapitalize="sentences"
                placeholder="What will you work on today?"
                error={fieldErrs.tasks || null}
              />
              <Field
                label="Achievements"
                value={achievements}
                onChangeText={setAchievements}
                multiline
                autoCapitalize="sentences"
                placeholder="What did you complete?"
                error={fieldErrs.achievements || null}
              />
              <Field
                label="Blockers"
                value={blockers}
                onChangeText={setBlockers}
                multiline
                autoCapitalize="sentences"
                placeholder="Anything in your way?"
                error={fieldErrs.blockers || null}
              />
              <Field
                label="Tomorrow's plan"
                value={tomorrowPlan}
                onChangeText={setTomorrowPlan}
                multiline
                autoCapitalize="sentences"
                placeholder="What's next?"
                error={fieldErrs.tomorrowPlan || null}
              />
              {saveError ? (
                <Text style={styles.saveError} accessibilityRole="alert">
                  {saveError}
                </Text>
              ) : null}
              <Button title={todayEntry ? "Update today's plan" : "Save today's plan"} onPress={save} loading={saving} />
              <Text style={styles.note}>Past days are view-only — plans lock at midnight.</Text>
            </Card>

            <SectionTitle>Last 2 weeks</SectionTitle>
            {past.length === 0 ? (
              <Card>
                <Empty
                  compact
                  icon="clipboard-outline"
                  title="No past plans"
                  text="Plans from the last 2 weeks will show up here."
                />
              </Card>
            ) : (
              <ListGroup>
                {past.map((e) => (
                  <ListItem
                    key={e.id}
                    leading={<DateTile date={e.date} tone="brand" />}
                    title={e.tasks?.trim() || "No tasks noted"}
                    subtitle={e.achievements ? `Done: ${e.achievements}` : undefined}
                    lines={2}
                  />
                ))}
              </ListGroup>
            )}
          </>
        )}
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  saveError: { ...type.footnote, color: colors.redText, marginBottom: spacing.sm },
  note: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.sm },
});
