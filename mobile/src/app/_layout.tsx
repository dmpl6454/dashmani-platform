import React, { useEffect } from "react";
import { Appearance, Platform } from "react-native";
import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/lib/auth";
import { colors, isDark } from "@/lib/theme";
import { ConfirmHost, ToastHost } from "@/components/feedback";

/**
 * Remembers the screen the person was on (or deep-linked to) so login can return there.
 * Recorded regardless of `loading` / `user`: a cold deep link to e.g. /salary-slips with no
 * session is stored before Stack.Protected sends the person to /login.
 * Login consumes and clears it; logout() clears it.
 */
function ResumePathRecorder() {
  const pathname = usePathname();
  const { setResumePath } = useAuth();
  useEffect(() => {
    if (!pathname || pathname === "/" || pathname === "/login" || pathname.startsWith("/login?")) return;
    setResumePath(pathname);
  }, [pathname, setResumePath]);
  return null;
}

/** Pin native chrome (keyboards, pickers, alerts) to the scheme the palette was resolved for. */
function useLockColorScheme() {
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (typeof Appearance.setColorScheme !== "function") return;
    try {
      Appearance.setColorScheme(isDark ? "dark" : "light");
    } catch {
      /* unsupported on this platform */
    }
  }, []);
}

function RootStack() {
  const { user, loading } = useAuth();
  const largeTitle =
    Platform.OS === "ios"
      ? {
          headerLargeTitleEnabled: true,
          headerLargeTitleShadowVisible: false,
          headerLargeTitleStyle: { fontWeight: "700", color: colors.ink },
        }
      : {};

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.ink,
        headerTitleStyle: { fontWeight: "700" },
        headerShadowVisible: false,
        // The tab groups' route names are "(tabs)" / "(admin)"; without this every screen
        // opened from a tab showed "< (tabs)" as its back button.
        headerBackTitle: "Back",
        contentStyle: { backgroundColor: colors.bg },
        ...largeTitle,
      }}
    >
      {/* Unprotected: the only screen reachable without a session. Every other route MUST be
          listed inside Stack.Protected — expo-router registers unlisted routes as ordinary,
          unguarded screens. */}
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Protected guard={loading || !!user}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(admin)" options={{ headerShown: false }} />
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
        {/* Pipeline (reachable from PIPELINE notifications and deep links) */}
        <Stack.Screen name="pipeline/index" options={{ title: "Pipeline" }} />
        <Stack.Screen name="pipeline/new" />
        <Stack.Screen name="pipeline/[id]" />
        {/* Admin stack screens */}
        <Stack.Screen name="admin-employees" options={{ title: "Employees" }} />
        <Stack.Screen name="admin-employee/[id]" options={{ title: "Employee Reports" }} />
        <Stack.Screen name="admin-tasks" options={{ title: "Tasks" }} />
        <Stack.Screen name="admin-not-submitted" options={{ title: "Not submitted today" }} />
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
        <Stack.Screen name="admin-overview" options={{ title: "Overview" }} />
        <Stack.Screen name="admin-posting-watch" options={{ title: "Posting Watch" }} />
        <Stack.Screen name="admin-campaigns" options={{ title: "Campaign Bookings" }} />
        <Stack.Screen name="admin-campaign/[id]" options={{ title: "Campaign" }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  useLockColorScheme();
  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuthProvider>
        <StatusBar style={isDark ? "light" : "dark"} />
        <ResumePathRecorder />
        <RootStack />
        <ToastHost />
        <ConfirmHost />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
