import React from "react";
import { StyleSheet, Text } from "react-native";
import { API_BASE, apiFetch, fmtDate } from "@/lib/api";
import { openFile } from "@/lib/device";
import { colors, formatStatus, spacing, statusTone, type } from "@/lib/theme";
import type { TintKey } from "@/lib/theme";
import { Button, Screen, StatusPill, useApi, type IoniconName } from "@/components/ui";
import { ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";

type Doc = {
  id: string;
  documentType?: string | null;
  fileName?: string | null;
  name?: string | null;
  filePath?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  status?: string | null;
  reviewNotes?: string | null;
  createdAt?: string | null;
};

/** Same labels as the HR web portal (apps/hr documents page). */
const DOCUMENT_TYPES: Record<string, string> = {
  AADHAAR: "Aadhaar Card",
  PAN: "PAN Card",
  PASSPORT: "Passport",
  DRIVING_LICENSE: "Driving License",
  VOTER_ID: "Voter ID",
  BANK_PASSBOOK: "Bank Passbook",
  EDUCATION_CERTIFICATE: "Education Certificate",
  EXPERIENCE_LETTER: "Experience Letter",
  OTHER: "Other",
};

const PORTAL_DOCUMENTS_URL = "https://hr.digitalsukoon.com/documents";

function fmtBytes(n?: number | null): string {
  if (!n) return "";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function typeLabel(d: Doc): string {
  const t = d.documentType ?? "";
  if (t && DOCUMENT_TYPES[t]) return DOCUMENT_TYPES[t];
  if (t) return formatStatus(t);
  return d.fileName ?? d.name ?? "Document";
}

function fileUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

function iconOf(d: Doc): IoniconName {
  return d.mimeType && d.mimeType.startsWith("image/") ? "image-outline" : "document-text-outline";
}

function tintOf(status: string): TintKey {
  const tone = statusTone(status);
  if (tone === "success") return "green";
  if (tone === "warning") return "orange";
  if (tone === "danger") return "red";
  return "blue";
}

function subtitleOf(d: Doc, status: string): string {
  const meta = [d.fileName ?? d.name ?? "", fmtBytes(d.fileSize), d.createdAt ? fmtDate(d.createdAt) : ""]
    .filter((s) => s !== "")
    .join(" · ");
  if (!d.reviewNotes) return meta;
  const prefix = status === "REJECTED" ? "Rejected: " : "Note: ";
  return `${meta}\n${prefix}${d.reviewNotes}`;
}

export default function DocumentsScreen() {
  const state = useApi<Doc[]>(() => apiFetch<Doc[]>("/hr/documents"));

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(d) => d.id}
        empty={{
          icon: "folder-open-outline",
          title: "No documents yet",
          text: "Upload your ID and certificates on hr.digitalsukoon.com — they'll appear here for review.",
        }}
        renderItem={(d) => {
          const status = d.status ?? "PENDING";
          const url = fileUrl(d.filePath);
          return (
            <ListItem
              icon={iconOf(d)}
              tint={tintOf(status)}
              title={typeLabel(d)}
              subtitle={subtitleOf(d, status)}
              trailing={<StatusPill status={status} size="sm" />}
              onPress={
                url
                  ? () => {
                      void openFile(url);
                    }
                  : undefined
              }
              accessibilityHint={url ? "Opens the file" : undefined}
            />
          );
        }}
      />
      <Text style={styles.hint}>To add or replace a document, upload it on hr.digitalsukoon.com.</Text>
      <Button
        title="Upload on hr.digitalsukoon.com"
        variant="plain"
        size="md"
        icon="open-outline"
        onPress={() => openFile(PORTAL_DOCUMENTS_URL)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { ...type.footnote, color: colors.sub, textAlign: "center", marginBottom: spacing.xs },
});
