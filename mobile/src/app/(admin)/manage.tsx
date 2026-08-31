import React from "react";
import { useRouter } from "expo-router";
import { Screen, Card, SectionTitle, Row } from "@/components/ui";

export default function AdminManage() {
  const router = useRouter();

  return (
    <Screen>
      <SectionTitle>People</SectionTitle>
      <Card>
        <Row icon="people-outline" iconColor="#0A84FF" title="Employees" subtitle="Directory, status & roles" onPress={() => router.push("/admin-employees")} />
        <Row icon="git-branch-outline" iconColor="#F0568C" title="Teams" subtitle="Org units & members" onPress={() => router.push("/admin-teams")} />
        <Row icon="time-outline" iconColor="#FF9F0A" title="Attendance" subtitle="Team attendance records" onPress={() => router.push("/admin-attendance")} />
        <Row icon="cash-outline" iconColor="#30D158" title="Salary Slips" subtitle="Review & approve payslips" onPress={() => router.push("/admin-salary-slips")} />
      </Card>

      <SectionTitle>Work</SectionTitle>
      <Card>
        <Row icon="checkbox-outline" iconColor="#FF9F0A" title="Tasks" subtitle="Assign & track tasks" onPress={() => router.push("/admin-tasks")} />
        <Row icon="at-outline" iconColor="#0A84FF" title="Social Accounts" subtitle="Channels & assignments" onPress={() => router.push("/admin-accounts")} />
        <Row icon="trending-up-outline" iconColor="#30D158" title="Account Growth" subtitle="Connected Meta channels — views, reach & revenue" onPress={() => router.push("/admin-growth")} />
        <Row icon="trophy-outline" iconColor="#FFD60A" title="Leaderboard" subtitle="Report performance ranking" onPress={() => router.push("/admin-leaderboard")} />
        <Row icon="sunny-outline" iconColor="#FF9F0A" title="Holidays" subtitle="Manage the holiday calendar" onPress={() => router.push("/admin-holidays")} />
        <Row icon="pulse-outline" iconColor="#FF375F" title="Workload" subtitle="Accounts & open tasks per employee" onPress={() => router.push("/admin-workload")} />
        <Row icon="bar-chart-outline" iconColor="#0A84FF" title="Analytics" subtitle="Tasks, attendance, content & projects" onPress={() => router.push("/admin-analytics")} />
      </Card>

      <SectionTitle>Insights</SectionTitle>
      <Card>
        <Row icon="flame-outline" iconColor="#FF9F0A" title="Top Links" subtitle="Best performing posts per platform" onPress={() => router.push("/admin-top-links")} />
        <Row icon="search-outline" iconColor="#8E8E93" title="Link Search" subtitle="Find posts by celebrity, brand or topic" onPress={() => router.push("/admin-link-search")} />
        <Row icon="sparkles-outline" iconColor="#F0568C" title="AI Assistant" subtitle="Draft, summarize, plan — powered by Claude" onPress={() => router.push("/admin-ai")} />
      </Card>

      <SectionTitle>Clients & Delivery</SectionTitle>
      <Card>
        <Row icon="business-outline" iconColor="#8E8E93" title="Clients" subtitle="Client directory" onPress={() => router.push("/admin-clients")} />
        <Row icon="folder-outline" iconColor="#64D2FF" title="Projects" subtitle="Active & past projects" onPress={() => router.push("/admin-projects")} />
        <Row icon="images-outline" iconColor="#FF375F" title="Content" subtitle="Content posts & approvals" onPress={() => router.push("/admin-content")} />
      </Card>

      <SectionTitle>Hiring & Comms</SectionTitle>
      <Card>
        <Row icon="briefcase-outline" iconColor="#8E8E93" title="Jobs & Applications" subtitle="Openings & candidates" onPress={() => router.push("/admin-jobs")} />
        <Row icon="megaphone-outline" iconColor="#FF9F0A" title="Announcements" subtitle="Broadcast to the team" onPress={() => router.push("/admin-announcements")} />
        <Row icon="school-outline" iconColor="#0A84FF" title="Internships" subtitle="Internship applications" onPress={() => router.push("/admin-internships")} />
        <Row icon="laptop-outline" iconColor="#8E8E93" title="Devices" subtitle="Assigned device inventory" onPress={() => router.push("/admin-devices")} />
      </Card>

      <SectionTitle>Feedback</SectionTitle>
      <Card>
        <Row icon="alert-circle-outline" iconColor="#FF9F0A" title="Complaints" subtitle="Respond to employee concerns" onPress={() => router.push("/admin-complaints")} />
        <Row icon="bug-outline" iconColor="#FF453A" title="Bug Reports" subtitle="Portal issues from the team" onPress={() => router.push("/admin-bug-reports")} />
      </Card>
    </Screen>
  );
}
