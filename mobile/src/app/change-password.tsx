import React, { useState } from "react";
import { Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, Button, Field, ErrorBanner, SuccessBanner } from "@/components/ui";

export default function ChangePasswordScreen() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!currentPassword || !newPassword) {
      setError("Fill in all fields");
      return;
    }
    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirm) {
      setError("New passwords don't match");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/hr/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setSuccessMsg("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setTimeout(() => router.back(), 1200);
    } catch (e: any) {
      setError(e?.message || "Could not change password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Card>
        <ErrorBanner message={error} />
        <SuccessBanner message={successMsg} />
        <Field label="Current password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry />
        <Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry />
        <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry />
        <Button title="Change Password" onPress={submit} loading={saving} />
        <Text style={styles.hint}>Use at least 6 characters. You'll stay signed in on this device.</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: colors.sub, textAlign: "center", marginTop: spacing.md },
});
