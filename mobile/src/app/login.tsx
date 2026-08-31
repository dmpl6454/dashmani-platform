import React, { useState } from "react";
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Pressable, Image } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/auth";
import { PortalMode } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Button, Field, ErrorBanner } from "@/components/ui";

// Seedance 2.5 cinematic loop — liquid-glass ribbons in brand orange/pink/gold.
const LOGIN_BG = require("../../assets/visuals/login-bg.mp4");
const LOGO = require("../../assets/images/logo-mark.png");

export default function LoginScreen() {
  const { login } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<PortalMode>(params.mode === "admin" ? "admin" : "hr");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const player = useVideoPlayer(LOGIN_BG, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Cinematic Seedance backdrop */}
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />
      {/* Legibility scrim */}
      <LinearGradient
        colors={["rgba(10,9,19,0.25)", "rgba(10,9,19,0.55)", "rgba(10,9,19,0.92)"]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.logoBlock}>
            <Image source={LOGO} style={styles.logoBadge} />
            <Text style={styles.title}>Dashmani Media</Text>
            <Text style={styles.subtitle}>
              {mode === "admin" ? "Admin Portal · portal.digitalsukoon.com" : "Employee Portal · hr.digitalsukoon.com"}
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
                  style={[styles.toggle, active && { backgroundColor: colors.purple, borderColor: colors.purple }]}
                >
                  <Ionicons name={t.icon as any} size={14} color={active ? "#fff" : colors.sub} />
                  <Text style={[styles.toggleText, active && { color: "#fff" }]}>{t.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Glass panel */}
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
              Forgot your password? Reset it from{" "}
              {mode === "admin" ? "portal.digitalsukoon.com" : "hr.digitalsukoon.com"}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: "center", padding: spacing.xl },
  logoBlock: { alignItems: "center", marginBottom: spacing.lg },
  logoBadge: {
    width: 84,
    height: 84,
    borderRadius: 20,
    marginBottom: spacing.md,
    backgroundColor: "#fff",
    shadowColor: "#F0568C",
    shadowOpacity: 0.5,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
  },
  title: { fontSize: 30, fontWeight: "700", color: colors.ink, letterSpacing: 0.5 },
  subtitle: { fontSize: 13, color: colors.sub, marginTop: 4 },
  toggleRow: { flexDirection: "row", gap: 8, justifyContent: "center", marginBottom: spacing.lg },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: "rgba(20,18,31,0.6)",
  },
  toggleText: { fontSize: 13, fontWeight: "600", color: colors.sub },
  card: {
    backgroundColor: "rgba(20,18,31,0.82)",
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: spacing.xl,
  },
  hint: { fontSize: 12, color: colors.sub, textAlign: "center", marginTop: spacing.md },
});
