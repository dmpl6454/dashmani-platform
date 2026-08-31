import React, { useState } from "react";
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Pressable } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { PortalMode } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Button, Field, ErrorBanner } from "@/components/ui";

export default function LoginScreen() {
  const { login } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<PortalMode>(params.mode === "admin" ? "admin" : "hr");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!identifier.trim() || !password) {
      setError(mode === "admin" ? "Enter your email and password" : "Enter your email/phone and password");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(mode, identifier, password);
      router.replace(mode === "admin" ? "/(admin)" : "/(tabs)");
    } catch (e: any) {
      setError(e?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.logoBlock}>
          <View style={[styles.logoBadge, mode === "admin" && { backgroundColor: colors.purple }]}>
            <Text style={[styles.logoLetter, mode === "admin" && { color: "#fff" }]}>D</Text>
          </View>
          <Text style={styles.title}>Dashmani Portal</Text>
          <Text style={styles.subtitle}>
            {mode === "admin" ? "Admin sign in · portal.digitalsukoon.com" : "Sign in to your employee account"}
          </Text>
        </View>

        {/* Portal toggle */}
        <View style={styles.toggleRow}>
          {(
            [
              { key: "hr", label: "Employee", icon: "person" },
              { key: "admin", label: "Admin", icon: "shield-checkmark" },
            ] as const
          ).map((t) => {
            const active = mode === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => {
                  setMode(t.key);
                  setError(null);
                }}
                style={[styles.toggle, active && { backgroundColor: colors.ink, borderColor: colors.ink }]}
              >
                <Ionicons name={t.icon as any} size={14} color={active ? "#fff" : colors.sub} />
                <Text style={[styles.toggleText, active && { color: "#fff" }]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.card}>
          <ErrorBanner message={error} />
          <Field
            label={mode === "admin" ? "Email" : "Email or Phone"}
            value={identifier}
            onChangeText={setIdentifier}
            placeholder="you@digitalsukoon.com"
            keyboardType="email-address"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
          />
          <Button title={mode === "admin" ? "Sign In as Admin" : "Sign In"} onPress={handleLogin} loading={loading} />
          <Text style={styles.hint}>
            Forgot your password? Reset it from the web portal at{" "}
            {mode === "admin" ? "portal.digitalsukoon.com" : "hr.digitalsukoon.com"}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: "center", padding: spacing.xl },
  logoBlock: { alignItems: "center", marginBottom: spacing.lg },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  logoLetter: { fontSize: 30, fontWeight: "900", color: colors.ink },
  title: { fontSize: 24, fontWeight: "800", color: colors.ink },
  subtitle: { fontSize: 14, color: colors.sub, marginTop: 4 },
  toggleRow: { flexDirection: "row", gap: 8, justifyContent: "center", marginBottom: spacing.lg },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#fff",
  },
  toggleText: { fontSize: 13, fontWeight: "600", color: colors.sub },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  hint: { fontSize: 12, color: colors.sub, textAlign: "center", marginTop: spacing.md },
});
