import React, { useState } from "react";
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";
import { Button, Field, ErrorBanner } from "@/components/ui";

export default function LoginScreen() {
  const { login } = useAuth();
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!identifier.trim() || !password) {
      setError("Enter your email/phone and password");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(identifier, password);
      router.replace("/(tabs)");
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
          <View style={styles.logoBadge}>
            <Text style={styles.logoLetter}>D</Text>
          </View>
          <Text style={styles.title}>Dashmani Portal</Text>
          <Text style={styles.subtitle}>Sign in to your employee account</Text>
        </View>

        <View style={styles.card}>
          <ErrorBanner message={error} />
          <Field
            label="Email or Phone"
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
          <Button title="Sign In" onPress={handleLogin} loading={loading} />
          <Text style={styles.hint}>
            Forgot your password? Reset it from the web portal at hr.digitalsukoon.com
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: "center", padding: spacing.xl },
  logoBlock: { alignItems: "center", marginBottom: spacing.xl },
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
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  hint: { fontSize: 12, color: colors.sub, textAlign: "center", marginTop: spacing.md },
});
