import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate, fmtMoney } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, StatusPill, Button, Field, Chips, ErrorBanner, SuccessBanner, Empty, Loading, useApi } from "@/components/ui";

const CATEGORIES = ["TRAVEL", "FOOD", "EQUIPMENT", "SOFTWARE", "OTHER"] as const;

export default function ExpensesScreen() {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("OTHER");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/hr/expenses"));

  const submit = async () => {
    setError(null);
    const amt = parseFloat(amount);
    if (!title.trim() || !amt || amt <= 0) {
      setError("Enter a title and a valid amount");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/expenses", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), amount: amt, category, description: description || undefined }),
      });
      setTitle("");
      setAmount("");
      setDescription("");
      setShowForm(false);
      setSuccessMsg("Expense claim submitted for approval");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not submit claim");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <SuccessBanner message={successMsg} />
      {!showForm && <Button title="+ New Expense Claim" onPress={() => { setSuccessMsg(null); setShowForm(true); }} style={{ marginBottom: spacing.md }} />}

      {showForm && (
        <>
          <SectionTitle>New Claim</SectionTitle>
          <Card>
            <ErrorBanner message={error} />
            <Field label="Title" value={title} onChangeText={setTitle} placeholder="e.g. Client travel" autoCapitalize="sentences" />
            <Field label="Amount (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0" />
            <Text style={styles.label}>Category</Text>
            <Chips options={CATEGORIES} value={category} onChange={setCategory} />
            <Field label="Description (optional)" value={description} onChangeText={setDescription} multiline autoCapitalize="sentences" />
            <Button title="Submit Claim" onPress={submit} loading={submitting} />
            <Button title="Cancel" onPress={() => setShowForm(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </Card>
        </>
      )}

      <SectionTitle>My Claims</SectionTitle>
      <Card>
        {(data ?? []).length === 0 ? (
          <Empty icon="wallet-outline" text="No expense claims yet" />
        ) : (
          data!.map((e: any, i: number) => (
            <View key={e.id} style={[styles.row, i === data!.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.title}>{e.title}</Text>
                <Text style={styles.sub}>
                  {fmtMoney(e.amount)} · {e.category} · {fmtDate(e.createdAt)}
                </Text>
              </View>
              <StatusPill status={e.status} />
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: "600", color: colors.ink, marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
});
