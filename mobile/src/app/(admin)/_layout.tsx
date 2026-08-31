import React, { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";
import { Loading } from "@/components/ui";

export default function AdminTabsLayout() {
  const { user, mode, loading } = useAuth();
  const router = useRouter();

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
  }, [loading, user, mode]);

  if (loading || !user || mode === "hr") return <Loading />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { fontWeight: "700", color: colors.ink },
        headerShadowVisible: false,
        tabBarActiveTintColor: colors.purple,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: {
          backgroundColor: colors.barBg,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.borderStrong,
          height: 84,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: "500" },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => <Ionicons name="speedometer" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: "Reports",
          tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: "Approvals",
          tabBarIcon: ({ color, size }) => <Ionicons name="checkmark-done" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="manage"
        options={{
          title: "Manage",
          tabBarIcon: ({ color, size }) => <Ionicons name="albums" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color, size }) => <Ionicons name="grid" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
