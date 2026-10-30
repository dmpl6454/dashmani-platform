import type { ColorValue } from "react-native";
import React, { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";
import { Loading, type IoniconName } from "@/components/ui";
import { useBadges } from "@/lib/hooks/shared";

function tabIcon(filled: IoniconName, outline: IoniconName) {
  function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? filled : outline} size={size} color={color} />;
  }
  return TabIcon;
}

const ICONS = {
  index: tabIcon("home", "home-outline"),
  report: tabIcon("link", "link-outline"),
  tasks: tabIcon("checkbox", "checkbox-outline"),
  leave: tabIcon("calendar", "calendar-outline"),
  more: tabIcon("grid", "grid-outline"),
};

export default function TabsLayout() {
  const { user, mode, loading } = useAuth();
  const router = useRouter();
  const { tasksDue } = useBadges();

  useEffect(() => {
    if (loading) return;
    if (mode === "admin") {
      router.replace("/(admin)");
    } else if (!user) {
      router.replace("/login?mode=hr");
    }
  }, [loading, user, mode, router]);

  if (loading || !user || mode === "admin") return <Loading />;

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
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: ICONS.index }} />
      <Tabs.Screen name="report" options={{ title: "Daily Report", tabBarIcon: ICONS.report }} />
      <Tabs.Screen
        name="tasks"
        options={{ title: "Tasks", tabBarIcon: ICONS.tasks, tabBarBadge: tasksDue > 0 ? tasksDue : undefined }}
      />
      <Tabs.Screen name="leave" options={{ title: "Leave", tabBarIcon: ICONS.leave }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: ICONS.more }} />
    </Tabs>
  );
}
