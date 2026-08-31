import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate, todayIST, daysAgoIST } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, Field, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function PlanScreen() {
  const [tasks, setTasks] = useState("");
  const [achievements, setAchievements] = useState("");
  const [blockers, setBlockers] = useState("");
  const [tomorrowPlan, setTomorrowPlan] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const today = todayIST();
  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(
    () => apiFetch(`/hr/poa?from=${daysAgoIST(13)}&to=${today}`),
  );

  const entries = data ?? [];
  const todayEntry = entries.find((e: any) => String(e.date).slice(0, 10) === today);

  useEffect(() => {
    if (todayEntry) {
      setTasks(todayEntry.tasks ?? "");
      setAchievements(todayEntry.achievements ?? "");
      setBlockers(todayEntry.blockers ?? "");
      setTomorrowPlan(todayEntry.tomorrowPlan ?? "");
    }
  }, [todayEntry?.id]);

  const save = async () => {
    setError(null);
    if (!tasks.trim()) {
      setError("Tasks for today is required");
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
      setSuccessMsg("Plan of Action saved");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />
      <SectionTitle>Today · {fmtDate(today)}</SectionTitle>
      <Card>
        <Field label="Tasks for today *" value={tasks} onChangeText={setTasks} multiline autoCapitalize="sentences" placeholder="What will you work on today?" />
        <Field label="Achievements" value={achievements} onChangeText={setAchievements} multiline autoCapitalize="sentences" placeholder="What did you complete?" />
        <Field label="Blockers" value={blockers} onChangeText={setBlockers} multiline autoCapitalize="sentences" placeholder="Anything in your way?" />
        <Field label="Tomorrow's plan" value={tomorrowPlan} onChangeText={setTomorrowPlan} multiline autoCapitalize="sentences" placeholder="What's next?" />
        <Button title={todayEntry ? "Update Today's Plan" : "Save Today's Plan"} onPress={save} loading={saving} />
        <Text style={styles.note}>Past days are view-only — plans lock at midnight.</Text>
      </Card>

      <SectionTitle>Past 14 Days</SectionTitle>
      <Card>
        {entries.filter((e: any) => String(e.date).slice(0, 10) !== today).length === 0 ? (
          <Empty icon="clipboard-outline" text="No past plans in the last 2 weeks" />
        ) : (
          entries
            .filter((e: any) => String(e.date).slice(0, 10) !== today)
            .map((e: any, i: number, arr: any[]) => (
              <View key={e.id} style={[styles.pastRow, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={styles.pastDate}>{fmtDate(e.date)}</Text>
                <Text style={styles.pastTasks} numberOfLines={3}>{e.tasks}</Text>
                {e.achievements ? <Text style={styles.pastSub} numberOfLines={2}>✓ {e.achievements}</Text> : null}
              </View>
            ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: spacing.sm },
  pastRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pastDate: { fontSize: 13, fontWeight: "700", color: colors.purple },
  pastTasks: { fontSize: 13, color: colors.ink, marginTop: 3, lineHeight: 18 },
  pastSub: { fontSize: 12, color: colors.green, marginTop: 3 },
});
