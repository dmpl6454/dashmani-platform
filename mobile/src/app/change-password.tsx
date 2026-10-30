import React, { useRef, useState } from "react";
import { StyleSheet, Text, View, type TextInput } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch, describeError, fieldErrorMap } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Card, ErrorBanner, Field, Screen } from "@/components/ui";
import { toast } from "@/components/feedback";

const MIN_LENGTH = 6;

export default function ChangePasswordScreen() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});

  const newRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const submit = async () => {
    if (saving) return;
    setError(null);
    setFieldErrs({});
    if (!currentPassword || !newPassword || !confirm) {
      setError("Fill in all fields");
      return;
    }
    if (newPassword.length < MIN_LENGTH) {
      setFieldErrs({ newPassword: `Use at least ${MIN_LENGTH} characters` });
      return;
    }
    if (newPassword !== confirm) {
      setFieldErrs({ confirm: "New passwords don't match" });
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/hr/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      void haptic("success");
      toast.show({ message: "Password changed", tone: "success" });
      router.back();
    } catch (e: unknown) {
      void haptic("error");
      setFieldErrs(fieldErrorMap(e));
      setError(describeError(e, "Could not change password"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      footerInset
      footer={
        <View>
          <Button title="Change password" variant="primary" onPress={submit} loading={saving} />
          <ErrorBanner message={error} style={styles.error} />
        </View>
      }
    >
      <Card>
        <Field
          label="Current password"
          value={currentPassword}
          onChangeText={setCurrentPassword}
          secureTextEntry
          revealToggle
          textContentType="password"
          autoComplete="current-password"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => newRef.current?.focus()}
          error={fieldErrs.currentPassword || null}
        />
        <Field
          ref={newRef}
          label="New password"
          value={newPassword}
          onChangeText={setNewPassword}
          secureTextEntry
          revealToggle
          textContentType="newPassword"
          autoComplete="new-password"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => confirmRef.current?.focus()}
          error={fieldErrs.newPassword || null}
          hint={`At least ${MIN_LENGTH} characters`}
        />
        <Field
          ref={confirmRef}
          label="Confirm new password"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          revealToggle
          textContentType="newPassword"
          autoComplete="new-password"
          returnKeyType="go"
          onSubmitEditing={() => {
            void submit();
          }}
          error={fieldErrs.confirm || null}
        />
      </Card>
      <Text style={styles.hint}>You&apos;ll stay signed in on this device.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { marginTop: spacing.md, marginBottom: 0 },
  hint: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.md },
});
