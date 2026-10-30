import React, { useMemo, useState } from "react";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { formatStatus } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, ErrorBanner, Screen, useApi, type IoniconName } from "@/components/ui";
import { ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";
import { confirm, toast } from "@/components/feedback";

type Device = {
  id: string;
  type?: string | null;
  deviceType?: string | null;
  name?: string | null;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  assignedAt?: string | null;
  returnedAt?: string | null;
  employee?: { name?: string | null } | null;
};

const DEVICE_ICONS: Record<string, IoniconName> = {
  LAPTOP: "laptop-outline",
  PHONE: "phone-portrait-outline",
  TABLET: "tablet-portrait-outline",
  MONITOR: "desktop-outline",
  KEYBOARD: "keypad-outline",
  MOUSE: "hardware-chip-outline",
  HEADSET: "headset-outline",
};

function joinParts(parts: Array<string | null | undefined>, sep = " · "): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(sep);
}

function kindOf(d: Device): string {
  return (d.type ?? d.deviceType ?? "").toUpperCase();
}

function deviceTitle(d: Device): string {
  const kind = kindOf(d);
  return joinParts([d.brand, d.model], " ") || d.name || (kind ? formatStatus(kind) : "Device");
}

export default function AdminDevices() {
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useApi<Device[]>(async () => {
    const rows = await apiFetch<Device[]>("/admin/devices/all");
    return Array.isArray(rows) ? rows : [];
  });

  // Devices still with employees first, returned ones after (server order kept within each).
  const sorted = useMemo(() => {
    const rows = list.data ?? [];
    return [...rows.filter((d) => !d.returnedAt), ...rows.filter((d) => !!d.returnedAt)];
  }, [list.data]);

  const markReturned = async (d: Device) => {
    const title = deviceTitle(d);
    const who = d.employee?.name ?? "the employee";
    const ok = await confirm({
      title: `Mark ${title} returned?`,
      message: `From ${who}. The device moves to Returned.`,
      confirmLabel: "Mark returned",
    });
    if (!ok) return;
    setError(null);
    setActing(d.id);
    try {
      await apiFetch(`/admin/devices/${d.id}/return`, { method: "POST" });
      void haptic("success");
      toast.show({ message: "Device marked returned", tone: "success" });
      await list.reload();
    } catch (e) {
      void haptic("error");
      setError(errorMessage(e, "Could not mark the device returned"));
    } finally {
      setActing(null);
    }
  };

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      <AsyncList
        state={list}
        items={sorted}
        grouped
        sectionOf={(d) => (d.returnedAt ? "Returned" : "With employees")}
        header={<ErrorBanner message={error} onDismiss={() => setError(null)} />}
        keyExtractor={(d) => d.id}
        renderItem={(d) => {
          const title = deviceTitle(d);
          const who = d.employee?.name ?? "Unassigned";
          const kind = kindOf(d);
          return (
            <ListItem
              icon={DEVICE_ICONS[kind] ?? "cube-outline"}
              tint={d.returnedAt ? "gray" : "blue"}
              title={title}
              subtitle={joinParts(
                [
                  joinParts([who, kind ? formatStatus(kind) : null]),
                  joinParts([
                    d.returnedAt ? `Returned ${fmtDate(d.returnedAt)}` : `Assigned ${fmtDate(d.assignedAt)}`,
                    d.serialNumber ? `SN ${d.serialNumber}` : null,
                  ]),
                ],
                "\n",
              )}
              trailing={
                d.returnedAt ? undefined : (
                  <Button
                    title="Returned"
                    variant="tinted"
                    size="sm"
                    fullWidth={false}
                    loading={acting === d.id}
                    disabled={acting !== null && acting !== d.id}
                    onPress={() => markReturned(d)}
                    accessibilityLabel={`Mark ${title} from ${who} returned`}
                  />
                )
              }
            />
          );
        }}
        empty={{ icon: "laptop-outline", title: "No devices assigned", text: "Company devices handed to employees appear here." }}
      />
    </Screen>
  );
}
