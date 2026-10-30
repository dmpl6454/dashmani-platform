import React from "react";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";
import type { TintKey } from "@/lib/theme";
import { Screen, type IoniconName } from "@/components/ui";
import { LargeTitle, ListGroup, ListItem } from "@/components/list";

/** "admin" rows call Admin / Super Admin-only APIs; "hr" rows work for HR Managers too. */
type Need = "admin" | "hr";

type ManageRow = { title: string; subtitle: string; icon: IoniconName; tint: TintKey; path: string; needs: Need };

type ManageSection = { title: string; rows: ManageRow[] };

const SECTIONS: ManageSection[] = [
  {
    title: "People",
    rows: [
      { title: "Employees", subtitle: "Directory, status & roles", icon: "people-outline", tint: "blue", path: "/admin-employees", needs: "hr" },
      { title: "Teams", subtitle: "Org units & members", icon: "git-branch-outline", tint: "brand", path: "/admin-teams", needs: "hr" },
      { title: "Attendance", subtitle: "Team attendance records", icon: "time-outline", tint: "orange", path: "/admin-attendance", needs: "hr" },
      { title: "Salary Slips", subtitle: "Review & approve payslips", icon: "cash-outline", tint: "green", path: "/admin-salary-slips", needs: "hr" },
    ],
  },
  {
    title: "Work",
    rows: [
      { title: "Tasks", subtitle: "Assign & track tasks", icon: "checkbox-outline", tint: "orange", path: "/admin-tasks", needs: "hr" },
      { title: "Social Accounts", subtitle: "Channels & assignments", icon: "at-outline", tint: "blue", path: "/admin-accounts", needs: "admin" },
      { title: "Account Growth", subtitle: "Connected Meta channels: views, reach & revenue", icon: "trending-up-outline", tint: "green", path: "/admin-growth", needs: "admin" },
      { title: "Leaderboard", subtitle: "Report performance ranking", icon: "trophy-outline", tint: "yellow", path: "/admin-leaderboard", needs: "admin" },
      { title: "Holidays", subtitle: "The company holiday calendar", icon: "sunny-outline", tint: "orange", path: "/admin-holidays", needs: "hr" },
      { title: "Workload", subtitle: "Accounts & open tasks per employee", icon: "pulse-outline", tint: "pink", path: "/admin-workload", needs: "admin" },
      { title: "Analytics", subtitle: "Tasks, attendance, content & projects", icon: "bar-chart-outline", tint: "blue", path: "/admin-analytics", needs: "admin" },
    ],
  },
  {
    title: "Insights",
    rows: [
      { title: "Overview", subtitle: "Views, reach, revenue & trending across the network", icon: "speedometer-outline", tint: "orange", path: "/admin-overview", needs: "admin" },
      { title: "Posting Watch", subtitle: "Assigned channels with no new post for 2h+", icon: "eye-outline", tint: "pink", path: "/admin-posting-watch", needs: "admin" },
      { title: "Top Links", subtitle: "Best performing posts per platform", icon: "flame-outline", tint: "orange", path: "/admin-top-links", needs: "admin" },
      { title: "Link Search", subtitle: "Find posts by celebrity, brand or topic", icon: "search-outline", tint: "gray", path: "/admin-link-search", needs: "admin" },
      { title: "AI Assistant", subtitle: "Draft, summarize and plan with Claude", icon: "sparkles-outline", tint: "brand", path: "/admin-ai", needs: "admin" },
    ],
  },
  {
    title: "Clients & Delivery",
    rows: [
      { title: "Campaign Bookings", subtitle: "Review, approve & record client campaign posts", icon: "megaphone-outline", tint: "brand", path: "/admin-campaigns", needs: "admin" },
      { title: "Clients", subtitle: "Client directory", icon: "business-outline", tint: "gray", path: "/admin-clients", needs: "admin" },
      { title: "Projects", subtitle: "Active & past projects", icon: "folder-outline", tint: "teal", path: "/admin-projects", needs: "admin" },
      { title: "Content", subtitle: "Content posts & approvals", icon: "images-outline", tint: "pink", path: "/admin-content", needs: "admin" },
    ],
  },
  {
    title: "Hiring & Comms",
    rows: [
      { title: "Jobs & Applications", subtitle: "Openings & candidates", icon: "briefcase-outline", tint: "gray", path: "/admin-jobs", needs: "hr" },
      { title: "Announcements", subtitle: "Broadcast to the team", icon: "megaphone-outline", tint: "orange", path: "/admin-announcements", needs: "hr" },
      { title: "Internships", subtitle: "Internship applications", icon: "school-outline", tint: "blue", path: "/admin-internships", needs: "hr" },
      { title: "Devices", subtitle: "Assigned device inventory", icon: "laptop-outline", tint: "gray", path: "/admin-devices", needs: "hr" },
    ],
  },
  {
    title: "Feedback",
    rows: [
      { title: "Complaints", subtitle: "Respond to employee concerns", icon: "alert-circle-outline", tint: "orange", path: "/admin-complaints", needs: "hr" },
      { title: "Bug Reports", subtitle: "Portal issues from the team", icon: "bug-outline", tint: "red", path: "/admin-bug-reports", needs: "hr" },
    ],
  },
];

export default function AdminManage() {
  const router = useRouter();
  const { caps } = useAuth();
  // HR-only staff never see rows whose APIs answer 403 for them.
  const adminView = caps.isAdmin || !caps.isHr;

  return (
    <Screen header="none">
      <LargeTitle title="Manage" subtitle={adminView ? undefined : "HR tools"} />
      {SECTIONS.map((section) => {
        const rows = section.rows.filter((r) => r.needs === "hr" || adminView);
        if (rows.length === 0) return null;
        return (
          <ListGroup key={section.title} title={section.title}>
            {rows.map((r) => (
              <ListItem
                key={r.path}
                icon={r.icon}
                tint={r.tint}
                title={r.title}
                subtitle={r.subtitle}
                onPress={() => router.push(r.path)}
              />
            ))}
          </ListGroup>
        );
      })}
    </Screen>
  );
}
