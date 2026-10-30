import React, { forwardRef, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ReturnKeyTypeOptions,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/auth";
import { apiFetch, describeError, isApiError, type PortalMode } from "@/lib/api";
import { colors, radius, sizes, spacing, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, ErrorBanner, Field, type IoniconName } from "@/components/ui";
import { Sheet } from "@/components/sheet";

// The login is ALWAYS white (owner decision) — a clean, Apple-style sheet with
// the exact brand logo and the warm orange→pink gradient on the primary action.
// Colors here are deliberately hardcoded light so a dark-mode device doesn't
// flip this screen; the in-app scheme still follows the system elsewhere.
const L = {
  bg: "#FFFFFF",
  ink: "#0B0B0F",
  sub: "#6C6C70",
  faint: "rgba(60,60,67,0.45)",
  field: "#F2F2F7",
  toggleBg: "#F2F2F7",
  toggleActive: "#FFFFFF",
  pinkSoft: "rgba(240,86,140,0.12)",
  pinkText: "#C02059",
  redSoft: "rgba(179,38,30,0.08)",
  redText: "#B3261E",
};

const LOGO = require("../../assets/images/logo-mark.png");
const continuous: ViewStyle | null = Platform.OS === "ios" ? { borderCurve: "continuous" } : null;

const RESET_URL: Record<PortalMode, string> = {
  hr: "https://hr.digitalsukoon.com/login",
  admin: "https://portal.digitalsukoon.com/login",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function homeFor(mode: PortalMode): string {
  return mode === "admin" ? "/(admin)" : "/(tabs)";
}

/** A recorded in-app path that is safe to return to after signing in, else null. */
function safeResume(p: string | null, mode: PortalMode): string | null {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p === "/") return null;
  if (p === "/login" || p.startsWith("/login?") || p.startsWith("/login/")) return null;
  if (mode === "hr" && p.startsWith("/admin")) return null;
  return p;
}

function isRateLimited(e: unknown): boolean {
  if (!isApiError(e)) return false;
  return e.status === 429 || e.code === "RATE_LIMIT" || e.code === "RATE_LIMITED" || e.code === "TOO_MANY_REQUESTS";
}

type LoginError = { message: string; code: string | null };

export default function LoginScreen() {
  const { login, user, loading: authLoading, mode: authMode, resumePath, setResumePath } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const paramMode: PortalMode | null = params.mode === "admin" ? "admin" : params.mode === "hr" ? "hr" : null;
  const [chosenMode, setChosenMode] = useState<PortalMode | null>(null);
  const mode: PortalMode = chosenMode ?? paramMode ?? authMode;

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  // Rate-limit countdown
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lockUntil === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockUntil) {
        setLockUntil(null);
        setError(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockUntil]);
  const lockLeft = lockUntil === null ? 0 : Math.max(0, Math.ceil((lockUntil - now) / 1000));

  // Announce each new error once (the countdown text changes every second; it is not re-announced).
  useEffect(() => {
    if (!error || Platform.OS === "web") return;
    const text = lockUntil !== null ? "Too many attempts. Wait a minute, then try again." : error.message;
    AccessibilityInfo.announceForAccessibility(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  // Already signed in (or the session was restored): leave for the resume path or home.
  const leaving = useRef(false);
  useEffect(() => {
    if (leaving.current || authLoading || !user) return;
    leaving.current = true;
    const target = safeResume(resumePath, authMode) ?? homeFor(authMode);
    setResumePath(null);
    router.replace(target);
  }, [authLoading, user, authMode, resumePath, router, setResumePath]);

  const pickMode = (m: PortalMode) => {
    setChosenMode(m);
    if (lockUntil === null) setError(null);
    void haptic("selection");
  };

  const handleLogin = async () => {
    if (loading || lockLeft > 0) return;
    if (!identifier.trim() || !password) {
      setError({
        message: mode === "admin" ? "Enter your email and password" : "Enter your email/phone and password",
        code: null,
      });
      return;
    }
    setLoading(true);
    setError(null);
    const target = safeResume(resumePath, mode) ?? homeFor(mode);
    leaving.current = true;
    try {
      await login(mode, identifier, password);
      void haptic("success");
      setResumePath(null);
      router.replace(target);
    } catch (e: unknown) {
      leaving.current = false;
      void haptic("error");
      if (isRateLimited(e) && isApiError(e) && typeof e.retryAfterSec === "number" && e.retryAfterSec > 0) {
        const t = Date.now();
        setNow(t);
        setLockUntil(t + Math.ceil(e.retryAfterSec) * 1000);
        setError({ message: describeError(e, "Too many attempts"), code: "RATE_LIMIT" });
      } else {
        setError({
          message: describeError(e, "Login failed"),
          code: isApiError(e) && e.code ? e.code : null,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const errorText =
    error === null ? null : lockLeft > 0 ? `Too many attempts — try again in ${lockLeft}s` : error.message;
  const signInLabel = loading
    ? "Signing in…"
    : lockLeft > 0
      ? `Try again in ${lockLeft}s`
      : mode === "admin"
        ? "Sign In as Admin"
        : "Sign In";
  const signInDisabled = loading || lockLeft > 0;

  // ---- Forgot password sheet ----
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSending, setForgotSending] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  const openForgot = () => {
    setForgotEmail(identifier.includes("@") ? identifier.trim() : "");
    setForgotSending(false);
    setForgotSent(false);
    setForgotError(null);
    setForgotOpen(true);
  };

  const sendReset = async () => {
    const email = forgotEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      setForgotError("Enter the email address you sign in with");
      return;
    }
    setForgotError(null);
    setForgotSending(true);
    try {
      await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify(mode === "admin" ? { email } : { email, app: "hr" }),
      });
      setForgotSent(true);
      void haptic("success");
    } catch (e: unknown) {
      setForgotError(describeError(e, "Could not send the reset link"));
    } finally {
      setForgotSending(false);
    }
  };

  const openWebReset = () => {
    void Linking.openURL(RESET_URL[mode]).catch(() => {
      setForgotError(`Open ${RESET_URL[mode].replace("https://", "")} in your browser`);
    });
  };

  const PORTALS: ReadonlyArray<{ key: PortalMode; label: string; icon: IoniconName }> = [
    { key: "hr", label: "Employee", icon: "person" },
    { key: "admin", label: "Admin", icon: "shield-checkmark" },
  ];

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          {/* Brand */}
          <View style={styles.logoBlock}>
            <Image
              source={LOGO}
              style={styles.logo}
              accessible
              accessibilityRole="image"
              accessibilityLabel="Dashmani Media"
            />
            <Text style={styles.title} accessibilityRole="header">
              Dashmani Media
            </Text>
            <Text style={styles.subtitle}>{mode === "admin" ? "Admin Portal" : "Employee Portal"}</Text>
          </View>

          {/* Portal toggle (segmented) */}
          <View style={[styles.toggleTrack, continuous]} accessibilityRole="tablist">
            {PORTALS.map((t) => {
              const active = mode === t.key;
              return (
                <Pressable
                  key={t.key}
                  onPress={() => pickMode(t.key)}
                  accessibilityRole="tab"
                  accessibilityLabel={`${t.label} portal`}
                  accessibilityState={{ selected: active }}
                  style={[styles.toggle, continuous, active && styles.toggleActive]}
                >
                  <Ionicons name={t.icon} size={15} color={active ? L.ink : L.sub} />
                  <Text style={[styles.toggleText, active && styles.toggleTextActive]}>{t.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Error */}
          {errorText ? (
            <View
              style={[styles.errorBanner, continuous]}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
            >
              <Ionicons name="alert-circle" size={18} color={L.redText} />
              <View style={styles.flex}>
                <Text style={styles.errorText}>{errorText}</Text>
                {error?.code === "FORBIDDEN_PORTAL" ? (
                  <Pressable
                    onPress={() => pickMode("hr")}
                    accessibilityRole="button"
                    accessibilityLabel="Switch to Employee"
                    hitSlop={8}
                    style={styles.errorAction}
                  >
                    <Text style={styles.errorActionText}>Switch to Employee</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

          {/* Form */}
          <LoginInput
            label={mode === "admin" ? "Email" : "Email or Phone"}
            icon="mail-outline"
            value={identifier}
            onChangeText={setIdentifier}
            placeholder="you@digitalsukoon.com"
            keyboardType={mode === "admin" ? "email-address" : "default"}
            textContentType="username"
            autoComplete="username"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
          <LoginInput
            ref={passwordRef}
            label="Password"
            icon="lock-closed-outline"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secure
            textContentType="password"
            autoComplete="password"
            returnKeyType="go"
            onSubmitEditing={() => {
              void handleLogin();
            }}
          />

          <Pressable
            onPress={handleLogin}
            disabled={signInDisabled}
            accessibilityRole="button"
            accessibilityLabel={signInLabel}
            accessibilityState={{ disabled: signInDisabled, busy: loading }}
            style={({ pressed }) => [styles.btnWrap, { opacity: signInDisabled ? 0.5 : pressed ? 0.85 : 1 }]}
          >
            <LinearGradient
              colors={colors.gradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0.6 }}
              style={[styles.btn, continuous]}
            >
              <Text style={styles.btnText}>{signInLabel}</Text>
            </LinearGradient>
          </Pressable>

          <Pressable
            onPress={openForgot}
            accessibilityRole="link"
            accessibilityLabel="Forgot password?"
            style={({ pressed }) => [styles.helpLine, pressed && styles.pressed]}
          >
            <Text style={styles.hint}>
              Forgot your password? <Text style={styles.hintLink}>Reset it</Text>
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>

      <Sheet
        visible={forgotOpen}
        onClose={() => setForgotOpen(false)}
        title="Reset password"
        subtitle={mode === "admin" ? "Admin portal" : "Employee portal"}
        footer={
          forgotSent ? (
            <Button title="Done" variant="secondary" onPress={() => setForgotOpen(false)} />
          ) : (
            <Button title="Send reset link" variant="primary" onPress={sendReset} loading={forgotSending} />
          )
        }
      >
        {forgotSent ? (
          <View style={styles.sentRow} accessibilityLiveRegion="polite">
            <Ionicons name="mail-unread-outline" size={22} color={colors.green} />
            <Text style={styles.sentText}>If that account exists, we&apos;ve emailed a reset link.</Text>
          </View>
        ) : (
          <>
            <Text style={styles.sheetText}>
              Enter the email you sign in with and we&apos;ll send you a link to choose a new password.
            </Text>
            <Field
              label="Email"
              value={forgotEmail}
              onChangeText={setForgotEmail}
              placeholder="you@digitalsukoon.com"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              returnKeyType="send"
              onSubmitEditing={() => {
                void sendReset();
              }}
              leading="mail-outline"
            />
          </>
        )}
        <ErrorBanner message={forgotError} />
        <Pressable
          onPress={openWebReset}
          accessibilityRole="link"
          accessibilityLabel="Reset on the web instead"
          style={({ pressed }) => [styles.webLink, pressed && styles.pressed]}
        >
          <Text style={styles.webLinkText}>Reset on the web instead</Text>
        </Pressable>
      </Sheet>
    </View>
  );
}

// Light-locked input: the shared Field follows the system scheme (its fill and label
// colours cannot be overridden through `style`), so the white login keeps its own.
type LoginInputProps = {
  label: string;
  icon: IoniconName;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: KeyboardTypeOptions;
  textContentType?: TextInputProps["textContentType"];
  autoComplete?: TextInputProps["autoComplete"];
  returnKeyType?: ReturnKeyTypeOptions;
  onSubmitEditing?: () => void;
};

const LoginInput = forwardRef<TextInput, LoginInputProps>(function LoginInput(
  {
    label,
    icon,
    value,
    onChangeText,
    placeholder,
    secure = false,
    keyboardType,
    textContentType,
    autoComplete,
    returnKeyType,
    onSubmitEditing,
  },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.field, continuous, focused && styles.fieldFocused]}>
        <Ionicons name={icon} size={18} color={L.sub} />
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={L.faint}
          secureTextEntry={secure && !revealed}
          keyboardType={keyboardType}
          textContentType={textContentType}
          autoComplete={autoComplete}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing ? () => onSubmitEditing() : undefined}
          submitBehavior={returnKeyType === "next" ? "submit" : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="light"
          selectionColor={L.pinkText}
          maxFontSizeMultiplier={1.6}
          accessibilityLabel={label}
          style={styles.input}
        />
        {secure ? (
          <Pressable
            onPress={() => setRevealed((r) => !r)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? "Hide password" : "Show password"}
            style={styles.eye}
          >
            <Ionicons name={revealed ? "eye-off-outline" : "eye-outline"} size={20} color={L.sub} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: L.bg },
  flex: { flex: 1 },
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
  title: { ...type.title1, color: L.ink, letterSpacing: 0.2 },
  subtitle: { ...type.subhead, color: L.sub, marginTop: spacing.xs },
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
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 20,
    minHeight: sizes.touch,
    borderRadius: radius.full,
  },
  toggleActive: {
    backgroundColor: L.toggleActive,
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  toggleText: { ...type.subhead, fontWeight: "600", color: L.sub },
  toggleTextActive: { color: L.ink },
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: L.redSoft,
    borderRadius: radius.control,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { ...type.subhead, color: L.redText },
  errorAction: { alignSelf: "flex-start", minHeight: 32, justifyContent: "center", marginTop: spacing.xs },
  errorActionText: { ...type.subhead, fontWeight: "600", color: L.pinkText },
  fieldBlock: { marginBottom: spacing.md },
  fieldLabel: { ...type.footnote, color: L.sub, marginBottom: 6, paddingLeft: 2 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: L.field,
    borderRadius: radius.control,
    borderWidth: 1.5,
    borderColor: "transparent",
    paddingLeft: 14,
    paddingRight: 4,
    height: 50,
  },
  fieldFocused: { borderColor: L.pinkSoft },
  input: { flex: 1, ...type.body, color: L.ink, height: "100%" },
  eye: { width: sizes.touch, height: sizes.touch, alignItems: "center", justifyContent: "center" },
  btnWrap: { marginTop: spacing.lg },
  btn: { height: 52, borderRadius: radius.lg, alignItems: "center", justifyContent: "center" },
  btnText: { ...type.headline, color: L.ink },
  helpLine: {
    minHeight: sizes.touch,
    alignSelf: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  pressed: { opacity: 0.6 },
  hint: { ...type.footnote, color: L.sub, textAlign: "center" },
  hintLink: { fontWeight: "600", color: L.pinkText },
  sheetText: { ...type.subhead, color: colors.sub, marginBottom: spacing.md },
  sentRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  sentText: { ...type.body, color: colors.ink, flex: 1 },
  webLink: { minHeight: sizes.touch, alignSelf: "center", justifyContent: "center", paddingHorizontal: spacing.md },
  webLinkText: { ...type.subhead, fontWeight: "600", color: colors.purple },
});
