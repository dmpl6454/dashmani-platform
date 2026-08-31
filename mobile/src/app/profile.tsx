import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Image } from "react-native";
import { apiFetch, API_BASE, fmtMoney } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, Field, ErrorBanner, SuccessBanner, Loading, StatusPill, useApi } from "@/components/ui";

export default function ProfileScreen() {
  const { data: profile, loading, refreshing, refresh, setData } = useApi<any>(() => apiFetch("/hr/profile"));
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setPhone(profile.phone ?? "");
      setMailingAddress(profile.mailingAddress ?? "");
    }
  }, [profile]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<any>("/hr/profile", {
        method: "PUT",
        body: JSON.stringify({ phone: phone || undefined, mailingAddress: mailingAddress || undefined }),
      });
      setData({ ...profile, ...updated });
      setEditing(false);
      setSuccessMsg("Profile updated");
    } catch (e: any) {
      setError(e?.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;

  const img = profile?.profileImageUrl
    ? profile.profileImageUrl.startsWith("http")
      ? profile.profileImageUrl
      : `${API_BASE}${profile.profileImageUrl}`
    : null;

  const info: Array<[string, string]> = [
    ["Email", profile?.email ?? "—"],
    ["Phone", profile?.phone ?? "—"],
    ["Designation", profile?.designation ?? "—"],
    ["Salary", profile?.salary ? fmtMoney(profile.salary) : "—"],
    ["Mailing Address", profile?.mailingAddress ?? "—"],
    ["Bank", profile?.bankName ?? "—"],
    ["Account Holder", profile?.bankAccountHolderName ?? "—"],
    ["Account No.", profile?.bankAccountNumber ?? "—"],
    ["IFSC", profile?.ifscCode ?? "—"],
    ["PAN", profile?.panNumber ?? "—"],
    ["Aadhaar", profile?.aadhaarNumber ?? "—"],
  ];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />

      <Card style={{ alignItems: "center" }}>
        {img ? (
          <Image source={{ uri: img }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarLetter}>{(profile?.name || "?").charAt(0).toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.name}>{profile?.name}</Text>
        {profile?.designation ? <Text style={styles.designation}>{profile.designation}</Text> : null}
        {profile?.status ? (
          <View style={{ marginTop: 8 }}>
            <StatusPill status={profile.status} />
          </View>
        ) : null}
      </Card>

      {editing ? (
        <>
          <SectionTitle>Edit Contact Info</SectionTitle>
          <Card>
            <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+91…" />
            <Field
              label="Mailing Address"
              value={mailingAddress}
              onChangeText={setMailingAddress}
              multiline
              autoCapitalize="sentences"
              placeholder="Your address"
            />
            <Button title="Save" onPress={save} loading={saving} />
            <Button title="Cancel" onPress={() => setEditing(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </Card>
        </>
      ) : (
        <>
          <SectionTitle
            right={
              <Text style={styles.edit} onPress={() => { setSuccessMsg(null); setEditing(true); }}>
                Edit
              </Text>
            }
          >
            Details
          </SectionTitle>
          <Card>
            {info.map(([label, value], i) => (
              <View key={label} style={[styles.infoRow, i === info.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={styles.infoLabel}>{label}</Text>
                <Text style={styles.infoValue} numberOfLines={2}>
                  {value}
                </Text>
              </View>
            ))}
          </Card>
          <Text style={styles.note}>
            Bank & identity details can only be updated from the web portal for security.
          </Text>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 84, height: 84, borderRadius: radius.full },
  avatarFallback: { backgroundColor: colors.purple, alignItems: "center", justifyContent: "center" },
  avatarLetter: { color: "#fff", fontSize: 34, fontWeight: "800" },
  name: { fontSize: 20, fontWeight: "800", color: colors.ink, marginTop: 10 },
  designation: { fontSize: 13, color: colors.sub, marginTop: 2 },
  edit: { color: colors.purple, fontWeight: "600", fontSize: 13 },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  infoLabel: { fontSize: 13, color: colors.sub },
  infoValue: { fontSize: 13, fontWeight: "600", color: colors.ink, flex: 1, textAlign: "right" },
  note: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: 4 },
});
