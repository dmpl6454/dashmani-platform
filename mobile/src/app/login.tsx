import React, { useState } from "react";
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Pressable, Image } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/auth";
import { PortalMode } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";

// The login is ALWAYS white (owner decision) — a clean, Apple-style sheet with
// the exact brand logo and the warm orange→pink gradient on the primary action.
// Colors here are deliberately hardcoded light so a dark-mode device doesn't
// flip this screen; the in-app scheme still follows the system elsewhere.
const L = {
  bg: "#FFFFFF",
  ink: "#0B0B0F",
  sub: "rgba(60,60,67,0.6)",
  faint: "rgba(60,60,67,0.3)",
  field: "#F2F2F7",
  toggleBg: "#F2F2F7",
  pink: "#E9447F",
};

const LOGO = require("../../assets/images/logo-mark.png");
const continuous = Platform.OS === "ios" ? ({ borderCurve: "continuous" } as any) : null;

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
    <View style={{ flex: 1, backgroundColor: L.bg }}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          {/* Brand */}
          <View style={styles.logoBlock}>
            <Image source={LOGO} style={styles.logo} />
            <Text style={styles.title}>Dashmani Media</Text>
            <Text style={styles.subtitle}>
              {mode === "admin" ? "Admin Portal" : "Employee Portal"}
            </Text>
          </View>

          {/* Portal toggle */}
          <View style={[styles.toggleTrack, continuous]}>
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
                  style={[styles.toggle, continuous, active && styles.toggleActive]}
                >
                  <Ionicons name={t.icon as any} size={14} color={active ? "#fff" : L.sub} />
                  <Text style={[styles.toggleText, active && { color: "#fff" }]}>{t.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Form */}
          {error ? (
            <View style={[styles.errorBanner, continuous]}>
              <Ionicons name="alert-circle" size={16} color="#FF3B30" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Text style={styles.fieldLabel}>{mode === "admin" ? "Email" : "Email or Phone"}</Text>
          <View style={[styles.field, continuous]}>
            <Ionicons name="mail-outline" size={18} color={L.faint} />
            <TextInputBox
              value={identifier}
              onChangeText={setIdentifier}
              placeholder="you@digitalsukoon.com"
              keyboardType="email-address"
            />
          </View>

          <Text style={styles.fieldLabel}>Password</Text>
          <View style={[styles.field, continuous]}>
            <Ionicons name="lock-closed-outline" size={18} color={L.faint} />
            <TextInputBox value={password} onChangeText={setPassword} placeholder="••••••••" secureTextEntry />
          </View>

          <Pressable onPress={handleLogin} disabled={loading} style={({ pressed }) => ({ opacity: loading ? 0.5 : pressed ? 0.8 : 1, marginTop: spacing.lg })}>
            <LinearGradient
              colors={colors.gradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0.6 }}
              style={[styles.btn, continuous]}
            >
              <Text style={styles.btnText}>{loading ? "Signing in…" : mode === "admin" ? "Sign In as Admin" : "Sign In"}</Text>
            </LinearGradient>
          </Pressable>

          <Text style={styles.hint}>
            Forgot your password? Reset it from{" "}
            {mode === "admin" ? "portal.digitalsukoon.com" : "hr.digitalsukoon.com"}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// Plain light-styled input (login is scheme-locked, so it doesn't use the shared Field)
import { TextInput } from "react-native";
function TextInputBox(props: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: any;
}) {
  return (
    <TextInput
      {...props}
      placeholderTextColor={L.faint}
      autoCapitalize="none"
      autoCorrect={false}
      style={styles.input}
    />
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: "center", padding: spacing.xl, paddingBottom: 60 },
  logoBlock: { alignItems: "center", marginBottom: spacing.xl },
  logo: {
    width: 92,
    height: 92,
    borderRadius: 22,
    marginBottom: spacing.lg,
    shadowColor: "#F0568C",
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  title: { fontSize: 28, fontWeight: "700", color: L.ink, letterSpacing: 0.2 },
  subtitle: { fontSize: 15, color: L.sub, marginTop: 4 },
  toggleTrack: {
    flexDirection: "row",
    alignSelf: "center",
    backgroundColor: L.toggleBg,
    borderRadius: radius.full,
    padding: 3,
    marginBottom: spacing.xl,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radius.full,
  },
  toggleActive: { backgroundColor: L.pink },
  toggleText: { fontSize: 14, fontWeight: "600", color: L.sub },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,59,48,0.1)",
    borderRadius: radius.md,
    padding: 12,
    marginBottom: spacing.md,
  },
  errorText: { color: "#FF3B30", fontSize: 14, flex: 1 },
  fieldLabel: { fontSize: 13, color: L.sub, marginBottom: 6, paddingLeft: 2 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: L.field,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    height: 50,
    marginBottom: spacing.md,
  },
  input: { flex: 1, fontSize: 17, color: L.ink, height: "100%" },
  btn: { height: 52, borderRadius: radius.lg, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 17, fontWeight: "600", color: "#fff" },
  hint: { fontSize: 13, color: L.faint, textAlign: "center", marginTop: spacing.lg },
});
