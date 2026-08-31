import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/lib/auth";
import { colors } from "@/lib/theme";

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.ink,
          headerTitleStyle: { fontWeight: "700" },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="task/[id]" options={{ title: "Task" }} />
        <Stack.Screen name="attendance" options={{ title: "Attendance" }} />
        <Stack.Screen name="salary-slips" options={{ title: "Salary Slips" }} />
        <Stack.Screen name="leaderboard" options={{ title: "Leaderboard" }} />
        <Stack.Screen name="holidays" options={{ title: "Holidays" }} />
        <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
        <Stack.Screen name="profile" options={{ title: "My Profile" }} />
        <Stack.Screen name="team" options={{ title: "My Team" }} />
        <Stack.Screen name="expenses" options={{ title: "Expenses" }} />
        <Stack.Screen name="extra-hours" options={{ title: "Extra Hours" }} />
        <Stack.Screen name="incentives" options={{ title: "Incentives" }} />
        <Stack.Screen name="reviews" options={{ title: "Performance Reviews" }} />
        <Stack.Screen name="complaints" options={{ title: "Complaints" }} />
        <Stack.Screen name="bug-report" options={{ title: "Report a Bug" }} />
        <Stack.Screen name="change-password" options={{ title: "Change Password" }} />
      </Stack>
    </AuthProvider>
  );
}
