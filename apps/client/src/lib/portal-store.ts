"use client";
import { useEffect, useState } from "react";

export type StatusKind = "neutral" | "attention" | "success" | "danger";
export type StatusKey =
  | "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED"
  | "DRAFT" | "PENDING" | "APPROVED" | "SCHEDULED" | "PUBLISHED"
  | "REJECTED" | "REVISION" | "FAILED";

export const STATUS: Record<StatusKey, { kind: StatusKind; label: string }> = {
  ACTIVE:    { kind: "success",   label: "Active" },
  PAUSED:    { kind: "neutral",   label: "Paused" },
  COMPLETED: { kind: "neutral",   label: "Completed" },
  ARCHIVED:  { kind: "neutral",   label: "Archived" },
  DRAFT:     { kind: "neutral",   label: "Draft" },
  PENDING:   { kind: "attention", label: "Needs you" },
  APPROVED:  { kind: "success",   label: "Approved" },
  SCHEDULED: { kind: "neutral",   label: "Scheduled" },
  PUBLISHED: { kind: "success",   label: "Live" },
  REJECTED:  { kind: "danger",    label: "Rejected" },
  REVISION:  { kind: "attention", label: "Revision sent" },
  FAILED:    { kind: "danger",    label: "Failed" },
};

export const STATUS_STYLE: Record<StatusKind, { bg: string; text: string; dot: string }> = {
  neutral:   { bg: "bg-neutral-bg",   text: "text-neutral",   dot: "bg-neutral" },
  attention: { bg: "bg-attention-bg", text: "text-attention", dot: "bg-attention" },
  success:   { bg: "bg-success-bg",   text: "text-success",   dot: "bg-success" },
  danger:    { bg: "bg-danger-bg",    text: "text-danger",    dot: "bg-danger" },
};

export interface Project {
  id: string;
  name: string;
  short: string;
  account: string;
  platform: "IG";
  status: StatusKey;
  tasks: { done: number; total: number };
  pending: number;
  due: string | null;
  health: number | null;
  owner: string;
  attention?: "overdue";
}

export interface ThreadMsg { a: string; at: string; t: string }

export interface Post {
  id: string;
  project: string;
  title: string;
  caption: string;
  hashtags: string[];
  format: "REEL" | "CAROUSEL" | "STORY" | "POST" | "DOC";
  aspect: string | null;
  duration: string | null;
  author: string;
  authorName: string;
  status: StatusKey;
  scheduled: string | null;
  overdue: boolean;
  thread: ThreadMsg[];
  analytics?: { likes: number; comments: number; saves: number };
}

export interface ActivityEntry { who: string; a: string | null; at: string; text: string }
export interface Toast { id: string; kind: StatusKind; text: string }

interface PortalState {
  posts: Post[];
  projects: Project[];
  activity: ActivityEntry[];
  toasts: Toast[];
}

export const USER = { name: "Priya K.", initial: "P", company: "Bombay Roastery" };

const PROJECTS: Project[] = [
  { id: "p1", name: "Bombay Roastery — Q3 social", short: "Bombay · Q3", account: "@bombay.roastery", platform: "IG", status: "ACTIVE",    tasks: { done: 18, total: 40 }, pending: 3, due: "2026-09-30", health: 84,  owner: "AS" },
  { id: "p2", name: "Indiranagar launch",          short: "Indiranagar",  account: "@bombay.indiranagar", platform: "IG", status: "ACTIVE",    tasks: { done: 4,  total: 10 }, pending: 1, due: "2026-05-22", health: 52,  owner: "NK", attention: "overdue" },
  { id: "p3", name: "Loyalty programme",           short: "Loyalty",      account: "@bombay.roastery", platform: "IG", status: "PAUSED",    tasks: { done: 0,  total: 0  }, pending: 0, due: null,         health: null, owner: "RP" },
  { id: "p4", name: "Goa pop-up — Aug",            short: "Goa pop-up",   account: "@bombay.roastery", platform: "IG", status: "ACTIVE",    tasks: { done: 2,  total: 8  }, pending: 0, due: "2026-08-14", health: 90,  owner: "AS" },
  { id: "p5", name: "Cold brew launch",            short: "Cold brew",    account: "@bombay.roastery", platform: "IG", status: "COMPLETED", tasks: { done: 8,  total: 8  }, pending: 0, due: null,         health: 100, owner: "AS" },
  { id: "p6", name: "Barista stories — series",    short: "Barista",      account: "@bombay.roastery", platform: "IG", status: "ACTIVE",    tasks: { done: 12, total: 26 }, pending: 0, due: "2026-12-01", health: 76,  owner: "AS" },
];

const POSTS: Post[] = [
  { id: "c1",  project: "p1", title: "Monsoon Espresso — reel",   caption: "when the city slows down, the espresso doubles. try our new monsoon espresso, only this month.", hashtags: ["#monsoon", "#espresso", "#bombay", "#thirdwave"], format: "REEL",     aspect: "9:16", duration: "0:14", author: "AS", authorName: "Anika S.", status: "PENDING",   scheduled: "2026-05-13T18:00", overdue: true,  thread: [{ a: "AS", at: "2h", t: "Tightened the cut at 0:08 per your note." }, { a: "P",  at: "1d", t: "Slow it down a touch around the espresso pour." }] },
  { id: "c2",  project: "p1", title: "Bean Origins — carousel",   caption: "from Aanaimalai to your cup — eight notes, eight slides.", hashtags: ["#beans", "#origin", "#bombay"], format: "CAROUSEL", aspect: "4:5",  duration: null,    author: "AS", authorName: "Anika S.", status: "PENDING",   scheduled: "2026-05-13T19:00", overdue: false, thread: [{ a: "AS", at: "5h", t: "Slide 4 is the new addition." }] },
  { id: "c3",  project: "p2", title: "Café Hours — story",         caption: "weekday hours updated. swipe up for directions.", hashtags: ["#indiranagar"], format: "STORY",    aspect: "9:16", duration: null,    author: "NK", authorName: "Naina K.", status: "PENDING",   scheduled: "2026-05-14T09:00", overdue: false, thread: [] },
  { id: "c4",  project: "p3", title: "Diwali campaign — brief",    caption: "kickoff brief — see attached doc.", hashtags: [], format: "DOC",      aspect: null,   duration: null,    author: "RP", authorName: "Riya P.",  status: "PENDING",   scheduled: "2026-05-16",        overdue: false, thread: [] },
  { id: "c5",  project: "p3", title: "Loyalty teaser — post",      caption: "your morning. your cup. your card.", hashtags: ["#loyalty", "#bombay"], format: "POST",    aspect: "4:5",  duration: null,    author: "AS", authorName: "Anika S.", status: "APPROVED",  scheduled: "2026-05-16T11:00", overdue: false, thread: [] },
  { id: "c6",  project: "p6", title: "Barista — Anika",            caption: "five years pulling shots. ask her about the goa lot.", hashtags: ["#crew", "#bombay"], format: "REEL",     aspect: "9:16", duration: "0:22", author: "AS", authorName: "Anika S.", status: "SCHEDULED", scheduled: "2026-05-19T08:30", overdue: false, thread: [] },
  { id: "c7",  project: "p1", title: "Cold brew launch — post",    caption: "the slow one. eighteen hours, zero hurry. now on tap.", hashtags: ["#coldbrew"], format: "POST", aspect: "4:5", duration: null, author: "AS", authorName: "Anika S.", status: "PUBLISHED", scheduled: "2026-05-12T18:00", overdue: false, thread: [], analytics: { likes: 1240, comments: 38, saves: 92 } },
  { id: "c8",  project: "p4", title: "Pop-up announce",            caption: "Goa. August. Eight days. Eight specials.", hashtags: ["#goa", "#popup"], format: "POST", aspect: "1:1", duration: null, author: "AS", authorName: "Anika S.", status: "PUBLISHED", scheduled: "2026-05-10T17:00", overdue: false, thread: [], analytics: { likes: 2104, comments: 71, saves: 184 } },
  { id: "c9",  project: "p1", title: "Crew BTS — reel",            caption: "behind the bar, before the bell.", hashtags: ["#bts"], format: "REEL", aspect: "9:16", duration: "0:18", author: "AS", authorName: "Anika S.", status: "REJECTED", scheduled: null, overdue: false, thread: [{ a: "P", at: "3d", t: "Off-brief. Cap the run at 0:10." }] },
  { id: "c10", project: "p1", title: "Pop-up Goa — carousel",      caption: "eight days of specials.", hashtags: ["#goa"], format: "CAROUSEL", aspect: "1:1", duration: null, author: "AS", authorName: "Anika S.", status: "PENDING", scheduled: "2026-05-15T17:00", overdue: false, thread: [] },
  { id: "c11", project: "p1", title: "Loyalty launch — post",      caption: "join. sip. earn. repeat.", hashtags: ["#loyalty"], format: "POST", aspect: "4:5", duration: null, author: "AS", authorName: "Anika S.", status: "PENDING", scheduled: "2026-05-17T11:00", overdue: false, thread: [] },
  { id: "c12", project: "p6", title: "Barista Stories — Naina",    caption: "two years and counting.", hashtags: ["#crew"], format: "REEL", aspect: "9:16", duration: "0:16", author: "AS", authorName: "Anika S.", status: "PENDING", scheduled: "2026-05-19T18:30", overdue: false, thread: [] },
];

const ACTIVITY: ActivityEntry[] = [
  { who: "Anika S.", a: "AS", at: "12h ago", text: "posted 3 drafts for review" },
  { who: "System",   a: null, at: "10h ago", text: "2 posts went live · Cold brew launch, Pop-up announce" },
  { who: "Riya P.",  a: "RP", at: "8h ago",  text: "replied on Bean Origins" },
  { who: "Riya P.",  a: "RP", at: "8h ago",  text: "uploaded Diwali campaign brief" },
  { who: "System",   a: null, at: "4h ago",  text: "Café Hours scheduled · Wed 9:00" },
];

let state: PortalState = { posts: POSTS, projects: PROJECTS, activity: ACTIVITY, toasts: [] };
const listeners = new Set<(s: PortalState) => void>();

function setState(patcher: (s: PortalState) => PortalState) {
  state = patcher(state);
  listeners.forEach((l) => l(state));
}

export function usePortalStore<T>(selector: (s: PortalState) => T): T {
  const [val, setVal] = useState(() => selector(state));
  useEffect(() => {
    const l = (s: PortalState) => setVal(selector(s));
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return val;
}

export const sel = {
  posts: (s: PortalState) => s.posts,
  pending: (s: PortalState) => s.posts.filter((p) => p.status === "PENDING"),
  projects: (s: PortalState) => s.projects,
  activity: (s: PortalState) => s.activity,
  toasts: (s: PortalState) => s.toasts,
  postById: (cid: string) => (s: PortalState) => s.posts.find((p) => p.id === cid),
  projectById: (pid: string) => (s: PortalState) => s.projects.find((p) => p.id === pid),
};

export const Actions = {
  approve(id: string) {
    setState((s) => ({
      ...s,
      posts: s.posts.map((p) => p.id === id ? { ...p, status: "APPROVED" as const } : p),
      activity: [{ who: USER.name, a: USER.initial, at: "just now", text: `approved "${s.posts.find((p) => p.id === id)?.title || ""}"` }, ...s.activity].slice(0, 12),
    }));
    Actions.toast({ kind: "success", text: "Approved. Agency notified." });
  },
  revise(id: string, note: string) {
    setState((s) => ({
      ...s,
      posts: s.posts.map((p) => p.id === id ? { ...p, status: "REVISION" as const, thread: [{ a: USER.initial, at: "just now", t: note }, ...(p.thread || [])] } : p),
      activity: [{ who: USER.name, a: USER.initial, at: "just now", text: `requested revision on "${s.posts.find((p) => p.id === id)?.title || ""}"` }, ...s.activity].slice(0, 12),
    }));
    Actions.toast({ kind: "attention", text: "Revision requested. The team has your note." });
  },
  reject(id: string, note: string) {
    setState((s) => ({
      ...s,
      posts: s.posts.map((p) => p.id === id ? { ...p, status: "REJECTED" as const, thread: [{ a: USER.initial, at: "just now", t: note }, ...(p.thread || [])] } : p),
      activity: [{ who: USER.name, a: USER.initial, at: "just now", text: `rejected "${s.posts.find((p) => p.id === id)?.title || ""}"` }, ...s.activity].slice(0, 12),
    }));
    Actions.toast({ kind: "danger", text: "Rejected. Note saved to the thread." });
  },
  bulkApprove(ids: string[]) {
    setState((s) => ({
      ...s,
      posts: s.posts.map((p) => ids.includes(p.id) ? { ...p, status: "APPROVED" as const } : p),
      activity: [{ who: USER.name, a: USER.initial, at: "just now", text: `bulk-approved ${ids.length} item${ids.length !== 1 ? "s" : ""}` }, ...s.activity].slice(0, 12),
    }));
    Actions.toast({ kind: "success", text: `Approved ${ids.length} items.` });
  },
  reply(id: string, text: string) {
    setState((s) => ({
      ...s,
      posts: s.posts.map((p) => p.id === id ? { ...p, thread: [{ a: USER.initial, at: "just now", t: text }, ...(p.thread || [])] } : p),
    }));
  },
  toast(t: { kind: StatusKind; text: string }) {
    const id = Math.random().toString(36).slice(2, 8);
    setState((s) => ({ ...s, toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => setState((s) => ({ ...s, toasts: s.toasts.filter((x) => x.id !== id) })), 3200);
  },
};

export const fmt = {
  date(iso: string | null) {
    if (!iso) return "—";
    const d = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tom = new Date(today); tom.setDate(tom.getDate() + 1);
    const isToday = d.toDateString() === new Date().toDateString();
    const isTom = d.toDateString() === tom.toDateString();
    const time = d.toTimeString().slice(0, 5);
    const datepart = d.toLocaleDateString("en", { month: "short", day: "numeric" });
    return isToday ? `Today · ${time}` : isTom ? `Tom · ${time}` : iso.includes("T") ? `${datepart} · ${time}` : datepart;
  },
  shortDate(iso: string | null) {
    return iso ? new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" }) : "—";
  },
  weekday(iso: string | null) {
    return iso ? new Date(iso).toLocaleDateString("en", { weekday: "short" }) : "";
  },
  time(iso: string | null) {
    return iso && iso.includes("T") ? new Date(iso).toTimeString().slice(0, 5) : "";
  },
};
