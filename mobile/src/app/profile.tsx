import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, describeError, fieldErrorMap, fmtMoney } from "@/lib/api";
import { haptic } from "@/lib/device";
import { colors, spacing, type } from "@/lib/theme";
import { Avatar, Button, Card, Field, Screen, SectionTitle, StatusPill, useApi } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonCard, SkeletonList } from "@/components/skeleton";
import { toast } from "@/components/feedback";

type Profile = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  designation?: string | null;
  salary?: number | string | null;
  mailingAddress?: string | null;
  bankName?: string | null;
  bankAccountHolderName?: string | null;
  bankAccountNumber?: string | null;
  ifscCode?: string | null;
  panNumber?: string | null;
  aadhaarNumber?: string | null;
  profileImageUrl?: string | null;
  status?: string | null;
};

function dash(v: string | null | undefined): string {
  return v && v.trim() ? v : "—";
}

function salaryText(v: number | string | null | undefined): string {
  const n = typeof v === "string" ? Number(v) : v;
  return n ? fmtMoney(n) : "—";
}

export default function ProfileScreen() {
  const state = useApi<Profile>(() => apiFetch<Profile>("/hr/profile"));
  const { data: profile, refreshing, refresh, setData } = state;
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});

  // Mirror the loaded profile into the form whenever we are not editing (also resets on Cancel).
  useEffect(() => {
    if (profile && !editing) {
      setPhone(profile.phone ?? "");
      setMailingAddress(profile.mailingAddress ?? "");
    }
  }, [profile, editing]);

  const startEdit = () => {
    setSaveError(null);
    setFieldErrs({});
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setFieldErrs({});
    try {
      const updated = await apiFetch<Partial<Profile>>("/hr/profile", {
        method: "PUT",
        body: JSON.stringify({ phone: phone || undefined, mailingAddress: mailingAddress || undefined }),
      });
      setData((prev) => ({ ...(prev ?? {}), ...updated }));
      setEditing(false);
      void haptic("success");
      toast.show({ message: "Profile updated", tone: "success" });
    } catch (e: unknown) {
      setFieldErrs(fieldErrorMap(e));
      setSaveError(describeError(e, "Could not save your details. Please try again."));
      void haptic("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonCard lines={2} />
            <SkeletonList rows={6} />
          </>
        }
      >
        {(p) => (
          <>
            <Card style={styles.hero}>
              <Avatar name={p.name || "?"} uri={p.profileImageUrl} size={88} ring />
              <Text style={styles.name} numberOfLines={2} accessibilityRole="header">
                {p.name || "—"}
              </Text>
              {p.designation ? <Text style={styles.designation}>{p.designation}</Text> : null}
              {p.status ? (
                <View style={styles.pill}>
                  <StatusPill status={p.status} />
                </View>
              ) : null}
            </Card>

            {editing ? (
              <>
                <SectionTitle>Edit contact info</SectionTitle>
                <Card>
                  <Field
                    label="Phone"
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    textContentType="telephoneNumber"
                    autoComplete="tel"
                    placeholder="+91…"
                    error={fieldErrs.phone}
                  />
                  <Field
                    label="Mailing address"
                    value={mailingAddress}
                    onChangeText={setMailingAddress}
                    multiline
                    autoCapitalize="sentences"
                    textContentType="fullStreetAddress"
                    placeholder="Your address"
                    error={fieldErrs.mailingAddress}
                  />
                  {saveError ? (
                    <Text style={styles.saveError} accessibilityRole="alert">
                      {saveError}
                    </Text>
                  ) : null}
                  <Button title="Save" onPress={save} loading={saving} />
                  <Button
                    title="Cancel"
                    variant="plain"
                    onPress={() => setEditing(false)}
                    disabled={saving}
                    style={styles.cancel}
                  />
                </Card>
              </>
            ) : (
              <>
                <SectionTitle
                  right={
                    <Button
                      title="Edit"
                      variant="plain"
                      size="sm"
                      icon="create-outline"
                      fullWidth={false}
                      onPress={startEdit}
                      accessibilityLabel="Edit contact info"
                    />
                  }
                >
                  Details
                </SectionTitle>

                <ListGroup title="Contact">
                  <ListItem title="Email" subtitle={dash(p.email)} />
                  <ListItem title="Phone" detail={dash(p.phone)} />
                  <ListItem title="Mailing address" subtitle={dash(p.mailingAddress)} />
                </ListGroup>

                <ListGroup title="Work">
                  <ListItem title="Designation" detail={dash(p.designation)} />
                  <ListItem title="Salary" detail={salaryText(p.salary)} />
                </ListGroup>

                <ListGroup
                  title="Bank & identity"
                  footer="For security, bank and identity details can only be changed on hr.digitalsukoon.com."
                >
                  <ListItem title="Bank" detail={dash(p.bankName)} />
                  <ListItem title="Account holder" subtitle={dash(p.bankAccountHolderName)} />
                  <ListItem title="Account no." detail={dash(p.bankAccountNumber)} />
                  <ListItem title="IFSC" detail={dash(p.ifscCode)} />
                  <ListItem title="PAN" detail={dash(p.panNumber)} />
                  <ListItem title="Aadhaar" detail={dash(p.aadhaarNumber)} />
                </ListGroup>
              </>
            )}
          </>
        )}
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", paddingVertical: spacing.xl },
  name: { ...type.title2, color: colors.ink, marginTop: spacing.md, textAlign: "center" },
  designation: { ...type.subhead, color: colors.sub, marginTop: 2, textAlign: "center" },
  pill: { marginTop: spacing.sm },
  saveError: { ...type.footnote, color: colors.redText, marginBottom: spacing.sm },
  cancel: { marginTop: spacing.sm },
});
