import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "@/lib/theme";

// "Continue with Google" for the iOS app. It uses the app's OWN Google OAuth client (type iOS,
// bundle com.dashmani.employee), whose id is baked in at build time by app.config.js
// (GOOGLE_IOS_CLIENT_ID) — iOS returns to the app through that client's reversed id as a URL
// scheme. When the build has no id, nothing is rendered: never a button that cannot work.
// The ID token goes to the API, which verifies it with Google (GOOGLE_IOS_CLIENT_IDS must list
// the same id on the server).

WebBrowser.maybeCompleteAuthSession();

const IOS_CLIENT_ID: string | undefined = (Constants.expoConfig?.extra as { googleIosClientId?: string } | undefined)?.googleIosClientId;

export const googleSignInAvailable = Boolean(IOS_CLIENT_ID);

function GoogleButtonInner({ disabled, onToken, onError }: { disabled?: boolean; onToken: (idToken: string) => void; onError: (message: string) => void }) {
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({ iosClientId: IOS_CLIENT_ID, clientId: IOS_CLIENT_ID });

  useEffect(() => {
    if (!response) return;
    if (response.type === "success") {
      const idToken = response.params?.id_token ?? response.authentication?.idToken;
      if (idToken) onToken(idToken);
      else onError("Google didn't return a sign-in token. Please try again.");
    } else if (response.type === "error") {
      onError(response.error?.description || "Google sign-in failed. Please try again.");
    }
    // "cancel" / "dismiss": the person closed the Google sheet — say nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  return (
    <Pressable
      onPress={() => void promptAsync()}
      disabled={disabled || !request}
      accessibilityRole="button"
      accessibilityLabel="Continue with Google"
      style={({ pressed }) => [styles.btn, { opacity: disabled || !request ? 0.5 : pressed ? 0.85 : 1 }]}
    >
      <Ionicons name="logo-google" size={18} color={colors.ink} />
      <Text style={styles.text}>Continue with Google</Text>
    </Pressable>
  );
}

/** Renders nothing unless this build carries an iOS Google client id. */
export function GoogleSignInButton(props: { disabled?: boolean; onToken: (idToken: string) => void; onError: (message: string) => void }) {
  if (!IOS_CLIENT_ID) return null;
  return (
    <View style={styles.wrap}>
      <View style={styles.orRow}>
        <View style={styles.rule} />
        <Text style={styles.or}>or</Text>
        <View style={styles.rule} />
      </View>
      <GoogleButtonInner {...props} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.md },
  orRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: spacing.md },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: "#D1D1D6" },
  or: { fontSize: 13, color: "#8E8E93" },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 52,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "#D1D1D6",
    backgroundColor: "#FFFFFF",
  },
  text: { fontSize: 16, fontWeight: "600", color: "#1C1C1E" },
});
