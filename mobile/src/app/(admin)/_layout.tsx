import type { ColorValue } from "react-native";
import React, { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";
import { Loading, type IoniconName } from "@/components/ui";
import { usePendingTotal } from "@/lib/hooks/shared";

function tabIcon(filled: IoniconName, outline: IoniconName) {
  function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? filled : outline} size={size} color={color} />;
  }
  return TabIcon;
}

const ICONS = {
  index: tabIcon("speedometer", "speedometer-outline"),
  reports: tabIcon("bar-chart", "bar-chart-outline"),
  approvals: tabIcon("checkmark-done", "checkmark-done-outline"),
  manage: tabIcon("albums", "albums-outline"),
  more: tabIcon("grid", "grid-outline"),
};

export default function AdminTabsLayout() {
  const { user, mode, loading } = useAuth();
  const router = useRouter();
  // Subscribe-only: the Dashboard / Approvals screens load the counts.
  const pendingTotal = usePendingTotal();

  useEffect(() => {
    if (loading) return;
    // Mode handoff FIRST: when the active portal flips, the other group owns
    // the redirect (otherwise this guard races and sends a logged-out switch
    // to the WRONG login mode).
    if (mode === "hr") {
      router.replace("/(tabs)");
    } else if (!user) {
      router.replace("/login?mode=admin");
    }
  }, [loading, user, mode, router]);

  if (loading || !user || mode === "hr") return <Loading />;

  return (
    <Tabs
      screenOptions={{
        // Tab roots draw their own LargeTitle in content.
        headerShown: false,
        tabBarActiveTintColor: colors.purple,
        tabBarInactiveTintColor: colors.sub,
        // No fixed height: react-navigation computes 49 + the bottom safe-area inset.
        tabBarStyle: {
          backgroundColor: colors.barBg,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingTop: 4,
        },
        tabBarAllowFontScaling: true,
        tabBarLabelStyle: { fontSize: 10, fontWeight: "500" },
        tabBarBadgeStyle: { backgroundColor: colors.red, color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Dashboard", tabBarIcon: ICONS.index }} />
      <Tabs.Screen name="reports" options={{ title: "Reports", tabBarIcon: ICONS.reports }} />
      <Tabs.Screen
        name="approvals"
        options={{
          title: "Approvals",
          tabBarIcon: ICONS.approvals,
          tabBarBadge: pendingTotal ? pendingTotal : undefined,
        }}
      />
      <Tabs.Screen name="manage" options={{ title: "Manage", tabBarIcon: ICONS.manage }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: ICONS.more }} />
    </Tabs>
  );
}
