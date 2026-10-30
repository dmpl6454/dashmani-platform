import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetch, describeError, fieldErrorMap, fmtDay, fmtMoney } from "@/lib/api";
import { colors, formatStatus, spacing, type, type TintKey } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Chips, ErrorBanner, Field, Screen, SectionTitle, StatusPill, useApi, type IoniconName } from "@/components/ui";
import { ListItem } from "@/components/list";
import { Sheet } from "@/components/sheet";
import { AsyncList } from "@/components/async";
import { toast } from "@/components/feedback";

const CATEGORIES = ["TRAVEL", "FOOD", "EQUIPMENT", "SOFTWARE", "OTHER"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<Category, string> = {
  TRAVEL: "Travel",
  FOOD: "Food",
  EQUIPMENT: "Equipment",
  SOFTWARE: "Software",
  OTHER: "Other",
};

const CATEGORY_GLYPHS: Record<string, { icon: IoniconName; tint: TintKey }> = {
  TRAVEL: { icon: "car-outline", tint: "blue" },
  FOOD: { icon: "restaurant-outline", tint: "orange" },
  EQUIPMENT: { icon: "hardware-chip-outline", tint: "indigo" },
  SOFTWARE: { icon: "code-slash-outline", tint: "teal" },
  OTHER: { icon: "receipt-outline", tint: "gray" },
};

type Expense = {
  id: string;
  title: string;
  amount: number;
  category: string;
  description?: string | null;
  status: string;
  createdAt: string;
};

type FormErrors = { title?: string; amount?: string };

export default function ExpensesScreen() {
  const state = useApi<Expense[]>(() => apiFetch<Expense[]>("/hr/expenses"));

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<Category>("OTHER");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const openForm = () => {
    setErrors({});
    setSubmitError(null);
    setOpen(true);
  };

  const submit = async () => {
    const next: FormErrors = {};
    if (!title.trim()) next.title = "Give the claim a title";
    const amt = parseFloat(amount.replace(",", "."));
    if (!Number.isFinite(amt) || amt <= 0) next.amount = "Enter an amount above ₹0";
    setErrors(next);
    setSubmitError(null);
    if (next.title || next.amount) {
      void haptic("error");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/expenses", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), amount: amt, category, description: description.trim() || undefined }),
      });
      setTitle("");
      setAmount("");
      setDescription("");
      setCategory("OTHER");
      setOpen(false);
      void haptic("success");
      toast.show({ message: "Expense claim submitted for approval", tone: "success" });
      void state.reload();
    } catch (e) {
      const fe = fieldErrorMap(e);
      setErrors({ title: fe.title, amount: fe.amount });
      setSubmitError(describeError(e, "Could not submit claim"));
      void haptic("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen
      onRefresh={state.refresh}
      refreshing={state.refreshing}
      footer={<Button title="New expense claim" icon="add" onPress={openForm} />}
      footerInset
    >
      <AsyncList
        state={state}
        grouped
        skeleton="rows"
        header={<SectionTitle>My claims</SectionTitle>}
        keyExtractor={(e) => e.id}
        empty={{
          icon: "wallet-outline",
          title: "No expense claims yet",
          text: "Claims you submit go to HR for approval.",
        }}
        renderItem={(e) => {
          const glyph = CATEGORY_GLYPHS[e.category] ?? CATEGORY_GLYPHS.OTHER;
          return (
            <ListItem
              icon={glyph.icon}
              tint={glyph.tint}
              title={e.title}
              subtitle={`${fmtMoney(e.amount)} · ${formatStatus(e.category || "OTHER")} · ${fmtDay(e.createdAt, { weekday: false })}`}
              trailing={<StatusPill status={e.status} size="sm" />}
            />
          );
        }}
      />

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="New expense claim"
        subtitle="Goes to HR for approval"
        dismissable={!submitting}
        footer={<Button title="Submit claim" onPress={submit} loading={submitting} />}
      >
        <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />
        <Field
          label="Title"
          value={title}
          onChangeText={(t) => {
            setTitle(t);
            setErrors((p) => ({ ...p, title: undefined }));
          }}
          placeholder="e.g. Client travel"
          autoCapitalize="sentences"
          error={errors.title}
          required
        />
        <Field
          label="Amount (₹)"
          value={amount}
          onChangeText={(t) => {
            setAmount(t);
            setErrors((p) => ({ ...p, amount: undefined }));
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="0"
          error={errors.amount}
          required
        />
        <Text style={styles.label} maxFontSizeMultiplier={1.6}>
          Category
        </Text>
        <Chips options={CATEGORIES} value={category} onChange={setCategory} labels={CATEGORY_LABELS} accessibilityLabel="Category" />
        <Field
          label="Description (optional)"
          value={description}
          onChangeText={setDescription}
          multiline
          autoCapitalize="sentences"
          autoCorrect
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { ...type.footnote, fontWeight: "500", color: colors.sub, marginTop: spacing.xs, marginBottom: spacing.sm },
});
