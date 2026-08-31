import React from "react";
import { useRouter } from "expo-router";
import { Screen, Card, SectionTitle, Row } from "@/components/ui";

export default function AdminManage() {
  const router = useRouter();

  return (
    <Screen>
      <SectionTitle>People</SectionTitle>
      <Card>
        <Row icon="people-outline" title="Employees" subtitle="Directory, status & roles" onPress={() => router.push("/admin-employees")} />
        <Row icon="git-branch-outline" title="Teams" subtitle="Org units & members" onPress={() => router.push("/admin-teams")} />
        <Row icon="time-outline" title="Attendance" subtitle="Team attendance records" onPress={() => router.push("/admin-attendance")} />
        <Row icon="cash-outline" title="Salary Slips" subtitle="Review & approve payslips" onPress={() => router.push("/admin-salary-slips")} />
      </Card>

      <SectionTitle>Work</SectionTitle>
      <Card>
        <Row icon="checkbox-outline" title="Tasks" subtitle="Assign & track tasks" onPress={() => router.push("/admin-tasks")} />
        <Row icon="at-outline" title="Social Accounts" subtitle="Channels & assignments" onPress={() => router.push("/admin-accounts")} />
        <Row icon="trophy-outline" title="Leaderboard" subtitle="Report performance ranking" onPress={() => router.push("/admin-leaderboard")} />
        <Row icon="sunny-outline" title="Holidays" subtitle="Manage the holiday calendar" onPress={() => router.push("/admin-holidays")} />
      </Card>

      <SectionTitle>Hiring & Comms</SectionTitle>
      <Card>
        <Row icon="briefcase-outline" title="Jobs & Applications" subtitle="Openings & candidates" onPress={() => router.push("/admin-jobs")} />
        <Row icon="megaphone-outline" title="Announcements" subtitle="Broadcast to the team" onPress={() => router.push("/admin-announcements")} />
      </Card>

      <SectionTitle>Feedback</SectionTitle>
      <Card>
        <Row icon="alert-circle-outline" title="Complaints" subtitle="Respond to employee concerns" onPress={() => router.push("/admin-complaints")} />
        <Row icon="bug-outline" title="Bug Reports" subtitle="Portal issues from the team" onPress={() => router.push("/admin-bug-reports")} />
      </Card>
    </Screen>
  );
}
