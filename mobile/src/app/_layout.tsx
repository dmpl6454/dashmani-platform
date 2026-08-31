import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/lib/auth";
import { colors, isDark } from "@/lib/theme";

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style={isDark ? "light" : "dark"} />
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
        <Stack.Screen name="(admin)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        {/* Employee stack screens */}
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
        <Stack.Screen name="calendar" options={{ title: "Calendar" }} />
        <Stack.Screen name="history" options={{ title: "Report History" }} />
        <Stack.Screen name="plan" options={{ title: "Plan of Action" }} />
        <Stack.Screen name="sop" options={{ title: "SOP" }} />
        <Stack.Screen name="documents" options={{ title: "My Documents" }} />
        <Stack.Screen name="contract" options={{ title: "Employment Contract" }} />
        <Stack.Screen name="offer-letters" options={{ title: "Offer Letters" }} />
        <Stack.Screen name="presentations" options={{ title: "Presentations" }} />
        <Stack.Screen name="joining-date" options={{ title: "Joining Date" }} />
        <Stack.Screen name="company" options={{ title: "Company" }} />
        {/* Admin stack screens */}
        <Stack.Screen name="admin-employees" options={{ title: "Employees" }} />
        <Stack.Screen name="admin-employee/[id]" options={{ title: "Employee Reports" }} />
        <Stack.Screen name="admin-tasks" options={{ title: "Tasks" }} />
        <Stack.Screen name="admin-accounts" options={{ title: "Social Accounts" }} />
        <Stack.Screen name="admin-growth" options={{ title: "Account Growth" }} />
        <Stack.Screen name="admin-teams" options={{ title: "Teams" }} />
        <Stack.Screen name="admin-holidays" options={{ title: "Holidays" }} />
        <Stack.Screen name="admin-salary-slips" options={{ title: "Salary Slips" }} />
        <Stack.Screen name="admin-complaints" options={{ title: "Complaints" }} />
        <Stack.Screen name="admin-bug-reports" options={{ title: "Bug Reports" }} />
        <Stack.Screen name="admin-jobs" options={{ title: "Jobs & Applications" }} />
        <Stack.Screen name="admin-announcements" options={{ title: "Announcements" }} />
        <Stack.Screen name="admin-leaderboard" options={{ title: "Leaderboard" }} />
        <Stack.Screen name="admin-notifications" options={{ title: "Notifications" }} />
        <Stack.Screen name="admin-attendance" options={{ title: "Attendance" }} />
        <Stack.Screen name="admin-analytics" options={{ title: "Analytics" }} />
        <Stack.Screen name="admin-projects" options={{ title: "Projects" }} />
        <Stack.Screen name="admin-clients" options={{ title: "Clients" }} />
        <Stack.Screen name="admin-content" options={{ title: "Content" }} />
        <Stack.Screen name="admin-devices" options={{ title: "Devices" }} />
        <Stack.Screen name="admin-internships" options={{ title: "Internships" }} />
        <Stack.Screen name="admin-workload" options={{ title: "Workload" }} />
        <Stack.Screen name="admin-ai" options={{ title: "AI Assistant" }} />
        <Stack.Screen name="admin-top-links" options={{ title: "Top Links" }} />
        <Stack.Screen name="admin-link-search" options={{ title: "Link Search" }} />
      </Stack>
    </AuthProvider>
  );
}
