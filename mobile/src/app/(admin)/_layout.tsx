import React, { useEffect } from "react";
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
    if (!user) {
      router.replace("/login?mode=admin");
    } else if (mode === "hr") {
      router.replace("/(tabs)");
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
          position: "absolute",
          bottom: 14,
          left: 14,
          right: 14,
          height: 64,
          borderRadius: 24,
          backgroundColor: "rgba(20,18,31,0.96)",
          borderTopWidth: 0,
          borderWidth: 1,
          borderColor: colors.border,
          paddingBottom: 10,
          paddingTop: 8,
          shadowColor: "#000",
          shadowOpacity: 0.5,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
          elevation: 12,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: "600" },
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
