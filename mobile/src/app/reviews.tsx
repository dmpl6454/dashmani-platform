import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Card, Screen, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";

type Review = {
  id: string;
  period: string;
  rating: number | null;
  strengths: string | null;
  improvements: string | null;
  goals: string | null;
  comments: string | null;
  createdAt: string;
};

function Stars({ rating }: { rating: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <Text accessible accessibilityLabel={`Rated ${filled} out of 5`} maxFontSizeMultiplier={1.3} style={styles.stars}>
      {"★".repeat(filled)}
      <Text style={styles.starsEmpty}>{"★".repeat(5 - filled)}</Text>
    </Text>
  );
}

function Block({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <View style={styles.block}>
      <Text maxFontSizeMultiplier={1.6} style={styles.blockLabel}>
        {label}
      </Text>
      <Text maxFontSizeMultiplier={1.6} style={styles.blockText}>
        {text}
      </Text>
    </View>
  );
}

function ReviewCard({ review }: { review: Review }) {
  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text accessibilityRole="header" maxFontSizeMultiplier={1.4} style={styles.period}>
            {review.period}
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={styles.date}>
            {fmtDate(review.createdAt)}
          </Text>
        </View>
        <Stars rating={review.rating ?? 0} />
      </View>
      <Block label="Strengths" text={review.strengths} />
      <Block label="Areas to improve" text={review.improvements} />
      <Block label="Goals" text={review.goals} />
      <Block label="Comments" text={review.comments} />
    </Card>
  );
}

export default function ReviewsScreen() {
  const state = useApi<Review[]>(() => apiFetch<Review[]>("/hr/performance-reviews"));

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        skeleton="cards"
        keyExtractor={(r) => r.id}
        renderItem={(r) => <ReviewCard review={r} />}
        empty={{
          icon: "star-outline",
          title: "No reviews yet",
          text: "Your performance reviews will appear here once HR shares them.",
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.md },
  headText: { flex: 1, minWidth: 0 },
  period: { ...type.headline, color: colors.ink },
  date: { ...type.footnote, color: colors.sub, marginTop: 2 },
  stars: { ...type.subhead, color: colors.tint.yellow },
  starsEmpty: { color: colors.borderStrong },
  block: { marginTop: spacing.md },
  blockLabel: { ...type.caption, fontWeight: "600", color: colors.sub, textTransform: "uppercase" },
  blockText: { ...type.subhead, color: colors.ink, marginTop: spacing.xs, lineHeight: 21 },
});
