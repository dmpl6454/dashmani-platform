import React, { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/theme";
import { Loading } from "@/components/ui";

export default function TabsLayout() {
  const { user, mode, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (mode === "admin") {
      router.replace("/(admin)");
    } else if (!user) {
      router.replace("/login?mode=hr");
    }
  }, [loading, user, mode]);

  if (loading || !user || mode === "admin") return <Loading />;

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
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="report"
        options={{
          title: "Daily Report",
          tabBarIcon: ({ color, size }) => <Ionicons name="link" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: "Tasks",
          tabBarIcon: ({ color, size }) => <Ionicons name="checkbox" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="leave"
        options={{
          title: "Leave",
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar" size={size} color={color} />,
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
