/**
 * Pipeline load harness (spec §11 "Load harness", plan Task 12.2).
 *
 *   seed:  npx tsx scripts/load/pipeline-load.ts seed
 *   run:   npx tsx scripts/load/pipeline-load.ts run --label=baseline --pipeline=off --minutes=10
 *          npx tsx scripts/load/pipeline-load.ts run --label=enabled  --pipeline=on  --minutes=10
 *   (scripts/load/run-load.sh does all of it: certs, compose up, db push, seed, both runs.)
 *
 * ⚠️ It REFUSES any DATABASE_URL that is not localhost:55432/dashmani_load (the harness's
 * own Postgres container). It truncates that database on seed.
 *
 * The run drives the real HTTPS stack (nginx → API, all on one pinned CPU) with the real
 * cadence mix and records every request; the API container's `[loadtest]` lines (event
 * loop, RSS, pipeline stats) and log greps are folded into one JSON result per run.
 */
import { execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { nKeysBetween, todayIST, PIPELINE_DEFAULT_POLL_MS } from "@dashmani/shared";

// TLS: run-load.sh generates a self-signed localhost cert and passes it to this process as
// NODE_EXTRA_CA_CERTS, so verification stays ON against the harness's nginx.

const DB_URL = process.env.DATABASE_URL ?? "";
{
  const u = new URL(DB_URL || "postgresql://x@invalid/none");
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || u.port !== "55432" || u.pathname !== "/dashmani_load") {
    console.error(`refusing DATABASE_URL ${u.hostname}:${u.port}${u.pathname} — the harness only touches localhost:55432/dashmani_load`);
    process.exit(2);
  }
}
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const HERE = __dirname;
const RUN_DIR = path.join(HERE, ".run");
const COMPOSE = `docker compose -f ${path.join(HERE, "docker-compose.load.yml")}`;
const BASE = process.env.LOAD_BASE ?? "https://localhost:8443/v1";
const JWT_SECRET = "load-harness-secret";
const HEAVY_ID = "00000000-0000-4000-8000-00000000beef";
const PASSWORD = "Load@12345";
const N_USERS = 115;
const N_TABS = 120;
const N_PROJECTS = 300;
const MSGS_PER_PROJECT = 200; // 60k
const N_HEAVY_ARCHIVED = 2000;

const arg = (name: string, dflt?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a fixed docker command WITHOUT blocking the event loop (the generators keep firing). */
function dockerExec(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn("docker", ["compose", "-f", path.join(__dirname, "docker-compose.load.yml"), ...args]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: T[]) => a[rand(a.length)];

// ── seed ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  const t0 = Date.now();
  const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);

  const role = await db.role.create({ data: { name: "Employee", description: "load" } });
  const hash = await bcrypt.hash(PASSWORD, 10);
  const users = Array.from({ length: N_USERS }, (_, i) => ({
    id: i === 0 ? HEAVY_ID : randomUUID(),
    name: i === 0 ? "Heavy User" : `Load User ${i}`,
    email: `load-${i}@load.test`,
    passwordHash: hash,
    status: "ACTIVE" as const,
  }));
  await db.user.createMany({ data: users });
  await db.userRole.createMany({ data: users.map((u) => ({ userId: u.id, roleId: role.id })) });

  const ig = await db.platform.create({ data: { name: "Instagram", slug: "instagram" } });
  const yt = await db.platform.create({ data: { name: "YouTube", slug: "youtube" } });
  const accounts = users.flatMap((u, i) => [
    { id: randomUUID(), handle: `ig_load_${i}`, displayName: `IG ${i}`, platformId: ig.id },
    { id: randomUUID(), handle: `yt_load_${i}`, displayName: `YT ${i}`, platformId: yt.id },
  ]);
  await db.socialAccount.createMany({ data: accounts });
  await db.accountAssignment.createMany({
    data: accounts.map((a, j) => ({ accountId: a.id, employeeId: users[Math.floor(j / 2)].id, assignedBy: users[0].id })),
  });

  // Pipeline: the seven phases + board row (the DDL seed), 300 live projects with 60k
  // messages, and the heavy user's 2,000 archived projects (spec §2 overlay bound).
  const phaseNames = ["Brief", "Planning", "In Production", "Review", "Approved", "Live", "Done"];
  const phases = phaseNames.map((name, i) => ({ id: randomUUID(), key: name.toLowerCase().replace(/\s+/g, "_"), name, position: i + 1, isTerminal: name === "Done" }));
  await db.pipelinePhase.createMany({ data: phases });
  await db.pipelineBoardState.create({ data: { id: 1, seq: 1 } });

  const live: Array<{ id: string; ownerId: string; phaseId: string; rank: string; members: string[] }> = [];
  const perPhase = new Map<string, number>();
  for (let i = 0; i < N_PROJECTS; i++) {
    const phase = phases[i % 6];
    perPhase.set(phase.id, (perPhase.get(phase.id) ?? 0) + 1);
  }
  const keysByPhase = new Map([...perPhase.entries()].map(([pid, n]) => [pid, nKeysBetween(null, null, n)]));
  const used = new Map<string, number>();
  for (let i = 0; i < N_PROJECTS; i++) {
    const phase = phases[i % 6];
    const k = used.get(phase.id) ?? 0;
    used.set(phase.id, k + 1);
    const owner = users[1 + (i % (N_USERS - 1))];
    const members = new Set<string>([owner.id, HEAVY_ID]);
    while (members.size < 6) members.add(pick(users).id);
    live.push({ id: randomUUID(), ownerId: owner.id, phaseId: phase.id, rank: keysByPhase.get(phase.id)![k], members: [...members] });
  }
  const now = new Date();
  await db.pipelineProject.createMany({
    data: live.map((p, i) => ({
      id: p.id,
      clientId: randomUUID(),
      title: `Load project ${i}`,
      ownerId: p.ownerId,
      createdById: p.ownerId,
      phaseId: p.phaseId,
      rank: p.rank,
      memberCount: p.members.length,
      threadRev: MSGS_PER_PROJECT,
      lastMessageSeq: MSGS_PER_PROJECT,
      lastMessageAt: now,
      updatedAt: now,
    })),
  });
  await db.pipelineParticipant.createMany({
    data: live.flatMap((p) =>
      p.members.map((uid) => ({
        projectId: p.id,
        userId: uid,
        role: "MEMBER",
        lastReadSeq: MSGS_PER_PROJECT - rand(30),
        memberAddedById: p.ownerId,
        memberAddedAt: now,
        updatedAt: now,
      })),
    ),
  });
  await db.$executeRawUnsafe(`
    INSERT INTO pipeline_messages (id, client_id, project_id, seq, rev, author_id, body, created_at, updated_at)
    SELECT gen_random_uuid()::text, gen_random_uuid()::text, p.id, g, g, p.owner_id,
           'Seed message ' || g || ' — lorem ipsum dolor sit amet, consectetur adipiscing elit',
           timezone('utc', now()) - ((${MSGS_PER_PROJECT} - g) * interval '3 minutes'), timezone('utc', now())
      FROM pipeline_projects p CROSS JOIN generate_series(1, ${MSGS_PER_PROJECT}) g`);

  const archKeys = nKeysBetween(null, null, N_HEAVY_ARCHIVED);
  const archived = Array.from({ length: N_HEAVY_ARCHIVED }, (_, i) => ({
    id: randomUUID(),
    clientId: randomUUID(),
    title: `Archived ${i}`,
    ownerId: HEAVY_ID,
    createdById: HEAVY_ID,
    phaseId: phases[6].id,
    rank: archKeys[i],
    archivedAt: now,
    archivedById: HEAVY_ID,
    updatedAt: now,
  }));
  await db.pipelineProject.createMany({ data: archived });
  await db.pipelineParticipant.createMany({
    data: archived.map((p) => ({ projectId: p.id, userId: HEAVY_ID, role: "MEMBER", memberAddedById: HEAVY_ID, memberAddedAt: now, updatedAt: now })),
  });
  await db.$executeRawUnsafe(`ANALYZE`);

  const counts = await db.$queryRawUnsafe<Array<Record<string, number>>>(`
    SELECT (SELECT count(*)::int FROM users) AS users,
           (SELECT count(*)::int FROM pipeline_projects WHERE archived_at IS NULL) AS live_projects,
           (SELECT count(*)::int FROM pipeline_projects WHERE archived_at IS NOT NULL) AS archived_projects,
           (SELECT count(*)::int FROM pipeline_messages) AS messages,
           (SELECT count(*)::int FROM pipeline_participants WHERE user_id = '${HEAVY_ID}') AS heavy_participations`);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, "seed.json"), JSON.stringify({ users, accounts, live, phases }, null, 0));
  console.log(`[seed] done in ${Math.round((Date.now() - t0) / 1000)}s`, counts[0]);
}

// ── run ──────────────────────────────────────────────────────────────────────────────

type Cls =
  | "pipeline_sync"
  | "pipeline_post"
  | "pipeline_other"
  | "pipeline_bootstrap"
  | "login"
  | "submit"
  | "today"
  | "reports"
  | "bell"
  | "herd";

interface Rec {
  t: number;
  cls: Cls;
  status: number;
  ms: number;
  user: string;
  first?: boolean;
}

const recs: Rec[] = [];
let runStart = 0;
let restartWindow: { from: number; to: number } | null = null;
let buildWindow: { from: number; to: number } | null = null;
let stopping = false;

function tokenFor(userId: string, email: string) {
  return jwt.sign({ userId, email, roles: ["Employee"], type: "hr" }, JWT_SECRET, { expiresIn: "3h" });
}

async function req(cls: Cls, method: string, p: string, token: string | null, body: unknown, user: string, extra: Partial<Rec> = {}) {
  const t = Date.now();
  const t0 = performance.now();
  let status = 0;
  let data: any = null;
  try {
    const r = await fetch(`${BASE}${p}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    status = r.status;
    const text = await r.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  } catch {
    status = 0; // network error / timeout
  }
  recs.push({ t, cls, status, ms: performance.now() - t0, user, ...extra });
  return { status, data };
}

interface Tab {
  i: number;
  userId: string;
  email: string;
  token: string;
  kind: "board" | "project";
  projectId: string | null;
  cursor: { rev: number; hv: number; seq: number };
  v: number;
  mineH?: string;
}

function percentile(v: number[], p: number) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] * 10) / 10;
}

async function sampleConnections(samples: number[]) {
  while (!stopping) {
    try {
      const r = await db.$queryRawUnsafe<Array<{ pipe: number; total: number }>>(
        `SELECT count(*) FILTER (WHERE application_name = 'dashmani-pipeline')::int AS pipe, count(*)::int AS total FROM pg_stat_activity WHERE datname = 'dashmani_load'`,
      );
      samples.push(r[0].pipe);
    } catch {
      /* the DB is up the whole run; a failed sample is simply skipped */
    }
    await sleep(1000);
  }
}

async function waitHealthy(timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return Date.now() - t0;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("API did not become healthy");
}

async function run() {
  const label = arg("label", "run")!;
  const pipelineOn = arg("pipeline", "on") === "on";
  const minutes = Number(arg("minutes", "10"));
  const durationMs = minutes * 60_000;
  const seedData = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "seed.json"), "utf8"));
  const users: Array<{ id: string; email: string }> = seedData.users;
  const accounts: Array<{ id: string; platformId: string; handle: string }> = seedData.accounts;
  const live: Array<{ id: string; members: string[]; phaseId: string }> = seedData.live;
  const phases: Array<{ id: string }> = seedData.phases;

  // Mode for this run, then a clean API process (no warm caches carried between runs).
  await db.systemSetting.deleteMany({ where: { key: { startsWith: "pipeline." } } });
  if (pipelineOn) await db.systemSetting.create({ data: { key: "pipeline.mode", value: "on" } });
  execSync(`${COMPOSE} restart api`, { stdio: "inherit" });
  await waitHealthy();
  await sleep(3000);
  const logSince = new Date().toISOString();

  runStart = Date.now();
  const deadline = runStart + durationMs;
  const at = (fraction: number) => runStart + fraction * durationMs;
  const connSamples: number[] = [];
  const conn = sampleConnections(connSamples);
  // CPU of the pinned containers (docker stats), every 5 s — sampled from the host.
  const cpuSamples: Array<{ t: number; total: number; api: number; postgres: number }> = [];
  const cpu = (async () => {
    while (!stopping) {
      const r = await new Promise<string>((resolve) => {
        const c = spawn("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}}"]);
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("close", () => resolve(out));
      });
      const get = (n: string) => Number((r.split("\n").find((l) => l.startsWith(`dashmani-load-${n}-1 `)) ?? "x 0%").split(" ")[1].replace("%", "")) || 0;
      const row = { t: Date.now(), api: get("api"), postgres: get("postgres"), nginx: get("nginx"), cotenant: get("cotenant") };
      cpuSamples.push({ t: row.t, api: row.api, postgres: row.postgres, total: row.api + row.postgres + row.nginx + row.cotenant });
      await sleep(5000);
    }
  })();
  const events: string[] = [];
  const note = (s: string) => {
    events.push(`${((Date.now() - runStart) / 1000).toFixed(1)}s ${s}`);
    console.log(`[${label}] ${s}`);
  };

  const accountsOf = new Map<string, typeof accounts>();
  accounts.forEach((a, j) => {
    const u = users[Math.floor(j / 2)];
    accountsOf.set(u.id, [...(accountsOf.get(u.id) ?? []), a]);
  });
  const projectsOf = new Map<string, string[]>();
  for (const p of live) for (const m of p.members) projectsOf.set(m, [...(projectsOf.get(m) ?? []), p.id]);
  const cardPhase = new Map(live.map((p) => [p.id, p.phaseId]));

  // 120 tabs over 115 users; tab 0 = the heavy user on the board, the whole run.
  const tabs: Tab[] = Array.from({ length: N_TABS }, (_, i) => {
    const u = users[i % N_USERS];
    const kind: Tab["kind"] = i === 0 ? "board" : i % 5 < 3 ? "board" : "project";
    const projectId = kind === "project" ? pick(projectsOf.get(u.id) ?? live.map((p) => p.id)) : null;
    return { i, userId: u.id, email: u.email, token: tokenFor(u.id, u.email), kind, projectId, cursor: { rev: 0, hv: 0, seq: 0 }, v: -1 };
  });
  const heavyTab = tabs[0];
  const triageUser = users[7];
  const triageToken = tokenFor(triageUser.id, triageUser.email);

  const postedClientIds = new Map<string, { status: number; tries: number; afterRestart: boolean }>();

  async function tabSync(tab: Tab, cls: Cls = "pipeline_sync") {
    const body: any = { clientBuild: 1 };
    if (tab.kind === "board") body.board = { v: tab.v };
    if (tab.mineH) body.mineH = tab.mineH;
    if (tab.projectId) body.project = { id: tab.projectId, rev: tab.cursor.rev, hv: tab.cursor.hv, ack: { seq: tab.cursor.seq } };
    const r = await req(cls, "POST", "/pipeline/sync", tab.token, body, tab.userId);
    if (r.status === 200 && r.data?.data) {
      const d = r.data.data;
      tab.v = d.v;
      tab.mineH = d.mineH;
      if (d.board) for (const c of d.board.cards) cardPhase.set(c.id, c.phaseId);
      if (d.project && d.project.status === "ok") {
        tab.cursor.rev = d.project.rev;
        tab.cursor.hv = d.project.hv;
        for (const m of d.project.messages) if (m.seq > tab.cursor.seq) tab.cursor.seq = m.seq;
      }
      // The sync carries the whole cadence set (as bootstrap does); pick this tab's view.
      const pm = d.pollMs;
      if (typeof pm === "number") return pm;
      return (tab.kind === "board" ? pm?.board : pm?.project) ?? null;
    }
    return null;
  }

  async function tabLoop(tab: Tab) {
    await sleep(rand(3000));
    const boot = await req("pipeline_bootstrap", "GET", "/pipeline/bootstrap", tab.token, undefined, tab.userId);
    if (!pipelineOn || !boot.data?.data?.enabled) return; // pipeline off: the client stops here
    const cadence = tab.kind === "board" ? PIPELINE_DEFAULT_POLL_MS.board : PIPELINE_DEFAULT_POLL_MS.project;
    await sleep(rand(cadence));
    while (!stopping && Date.now() < deadline) {
      const next = (await tabSync(tab)) ?? cadence;
      await sleep(next);
    }
  }

  async function bellLoop(tab: Tab) {
    await sleep(rand(30_000));
    while (!stopping && Date.now() < deadline) {
      await req("bell", "GET", "/hr/notifications/count", tab.token, undefined, tab.userId);
      await sleep(30_000);
    }
  }

  async function postWithOutbox(userId: string, token: string, projectId: string, body: string, cls: Cls = "pipeline_post") {
    const clientId = randomUUID();
    const rec = { status: 0, tries: 0, afterRestart: false };
    postedClientIds.set(clientId, rec);
    for (let attempt = 0; attempt < 8; attempt++) {
      rec.tries++;
      if (restartWindow && !restartWindow.to) rec.afterRestart = true;
      const r = await req(cls, "POST", `/pipeline/projects/${projectId}/messages`, token, { clientId, body }, userId);
      rec.status = r.status;
      if (r.status === 201 || r.status === 200) return r.data?.data?.message ?? null;
      if (r.status === 429 || r.status === 400 || r.status === 403 || r.status === 404 || r.status === 409) return null;
      await sleep(1000 + rand(1000)); // 0 / 502 / 503: the outbox retries with the SAME clientId
    }
    return null;
  }

  const recentMsgs: Array<{ id: string; projectId: string }> = [];
  async function messageLoop() {
    // ~1 message/s org-wide, plus reactions (~0.3/s) and moves (~0.1/s).
    const projectTabs = tabs.filter((t) => t.kind === "project");
    while (!stopping && Date.now() < deadline) {
      const t = pick(projectTabs);
      const m = await postWithOutbox(t.userId, t.token, t.projectId!, `Load message ${Math.random().toString(36).slice(2)}`);
      if (m) {
        recentMsgs.push({ id: m.id, projectId: t.projectId! });
        if (recentMsgs.length > 200) recentMsgs.shift();
      }
      await sleep(700 + rand(600));
    }
  }
  async function reactionLoop() {
    while (!stopping && Date.now() < deadline) {
      await sleep(2500 + rand(2000));
      const m = recentMsgs.length ? pick(recentMsgs) : null;
      if (!m) continue;
      const p = live.find((x) => x.id === m.projectId)!;
      const uid = pick(p.members);
      const u = users.find((x) => x.id === uid)!;
      await req("pipeline_other", "PUT", `/pipeline/messages/${m.id}/reactions/${pick(["thumbs_up", "heart", "laugh"])}`, tokenFor(u.id, u.email), { on: Math.random() < 0.7 }, u.id);
    }
  }
  async function moveLoop() {
    while (!stopping && Date.now() < deadline) {
      await sleep(8000 + rand(4000));
      const p = pick(live);
      const base = cardPhase.get(p.id) ?? p.phaseId;
      const idx = phases.findIndex((x) => x.id === base);
      const to = phases[Math.min(5, Math.max(0, idx + (Math.random() < 0.5 ? 1 : -1)))];
      const u = users.find((x) => x.id === p.members[1])!;
      const r = await req("pipeline_other", "POST", `/pipeline/projects/${p.id}/move`, tokenFor(u.id, u.email), { toPhaseId: to.id, afterId: null, basePhaseId: base }, u.id);
      if (r.status === 200) cardPhase.set(p.id, r.data.data.card.phaseId);
    }
  }

  const submitted = new Map<string, Array<{ accountId: string; url: string; platform: string }>>();
  async function submitFor(u: { id: string; email: string }, extra: number) {
    const token = tokenFor(u.id, u.email);
    const today = await req("today", "GET", "/hr/reports/today", token, undefined, u.id);
    const prev = submitted.get(u.id) ?? [];
    const accs = accountsOf.get(u.id)!;
    const links = [...prev];
    for (let k = 0; k < extra; k++) {
      const a = accs[k % 2];
      links.push({
        accountId: a.id,
        platform: a.handle.startsWith("ig") ? "instagram" : "youtube",
        url: a.handle.startsWith("ig")
          ? `https://www.instagram.com/reel/${randomUUID().replace(/-/g, "").slice(0, 11)}/`
          : `https://www.youtube.com/shorts/${randomUUID().replace(/-/g, "").slice(0, 11)}`,
      });
    }
    const capped = links.slice(0, 450);
    const r = await req("submit", "POST", "/hr/reports", token, { date: todayIST(), links: capped }, u.id, { first: prev.length === 0 && today.status === 200 });
    if (r.status === 200 || r.status === 201) submitted.set(u.id, capped);
  }
  async function submitScheduler() {
    // The evening rush: every user submits once, ~30% update later; up to 450 links.
    const plan: Array<{ at: number; u: { id: string; email: string }; extra: number }> = [];
    for (const u of users) {
      const big = Math.random() < 0.2;
      plan.push({ at: at(0.03 + Math.random() * 0.9), u, extra: big ? 450 : 20 + rand(180) });
      if (Math.random() < 0.3) plan.push({ at: at(0.5 + Math.random() * 0.45), u, extra: 10 + rand(60) });
    }
    plan.sort((a, b) => a.at - b.at);
    const inflight: Promise<void>[] = [];
    for (const p of plan) {
      if (stopping) break;
      const wait = p.at - Date.now();
      if (wait > 0) await sleep(wait);
      inflight.push(submitFor(p.u, p.extra));
    }
    await Promise.all(inflight);
  }
  async function loginLoop() {
    while (!stopping && Date.now() < deadline) {
      const u = pick(users);
      await req("login", "POST", "/hr/auth/login", null, { identifier: u.email, password: PASSWORD }, u.id);
      await sleep(4000 + rand(2000));
    }
  }
  async function historyLoop() {
    while (!stopping && Date.now() < deadline) {
      const u = pick(users);
      await req("reports", "GET", "/hr/reports", tokenFor(u.id, u.email), undefined, u.id);
      await sleep(3000 + rand(2000));
    }
  }

  async function midRunBuild() {
    await sleep(Math.max(0, at(0.2) - Date.now()));
    note("next build (apps/hr, --max-old-space-size=900) started in the api cgroup");
    const t0 = Date.now();
    buildWindow = { from: t0, to: 0 };
    const r = await dockerExec(["exec", "-T", "api", "sh", "-c", "cd /app/apps/hr && NODE_OPTIONS=--max-old-space-size=900 npx next build > /tmp/next-build.log 2>&1; echo exit=$?"]);
    buildWindow.to = Date.now();
    note(`next build finished in ${Math.round((Date.now() - t0) / 1000)}s: ${r.out.trim().split("\n").pop()}`);
  }

  async function killAndRestart() {
    await sleep(Math.max(0, at(0.5) - Date.now()));
    note("kill -INT api (supervisor restarts it)");
    restartWindow = { from: Date.now(), to: 0 };
    await dockerExec(["exec", "-T", "api", "pkill", "-INT", "-f", "scripts/load/api-entry.ts"]);
    await sleep(500);
    const ms = await waitHealthy();
    restartWindow.to = Date.now();
    note(`api healthy again after ${Math.round((restartWindow.to - restartWindow.from) / 1000)}s — 30-client herd`);
    await Promise.all(
      tabs.slice(1, 31).map(async (t) => {
        await req("herd", "GET", "/pipeline/bootstrap", t.token, undefined, t.userId);
        if (pipelineOn) await req("herd", "POST", "/pipeline/sync", t.token, { clientBuild: 1, board: { v: -1 } }, t.userId);
        await req("herd", "GET", "/hr/notifications/count", t.token, undefined, t.userId);
      }),
    );
    void ms;
  }

  async function triageBurst() {
    if (!pipelineOn) return;
    await sleep(Math.max(0, at(0.7) - Date.now()));
    note(`triage burst: 30 messages + 40 project opens in one minute (user ${triageUser.email})`);
    const mine = projectsOf.get(triageUser.id) ?? [];
    const jobs: Promise<unknown>[] = [];
    for (let k = 0; k < 40; k++) {
      jobs.push(
        (async () => {
          await sleep(k * 1500);
          const pid = mine[k % mine.length];
          await req("pipeline_other", "GET", `/pipeline/projects/${pid}`, triageToken, undefined, `triage:${triageUser.id}`);
          await req("pipeline_sync", "POST", "/pipeline/sync", triageToken, { clientBuild: 1, project: { id: pid, rev: 0, hv: 0 } }, `triage:${triageUser.id}`);
        })(),
      );
    }
    for (let k = 0; k < 30; k++) {
      jobs.push(
        (async () => {
          await sleep(k * 2000);
          await postWithOutbox(`triage:${triageUser.id}`, triageToken, mine[k % mine.length], `Triage reply ${k}`);
        })(),
      );
    }
    await Promise.all(jobs);
  }

  note(`start: pipeline=${pipelineOn ? "on" : "off"}, ${minutes} min, ${N_TABS} tabs`);
  const loops = [
    ...tabs.map(tabLoop),
    ...tabs.map(bellLoop),
    submitScheduler(),
    loginLoop(),
    historyLoop(),
    midRunBuild(),
    killAndRestart(),
    ...(pipelineOn ? [messageLoop(), reactionLoop(), moveLoop(), triageBurst()] : []),
  ];
  await sleep(Math.max(0, deadline - Date.now()));
  note("deadline reached — draining");
  stopping = true;
  await Promise.race([Promise.all(loops), sleep(60_000)]);
  await conn;
  await cpu;
  fs.writeFileSync(path.join(RUN_DIR, `recs-${label}.json`), JSON.stringify({ runStart, restartWindow, buildWindow, recs, cpuSamples }));

  // ── server-side evidence ──
  const logs = execSync(`${COMPOSE} logs api --no-color --since ${logSince}`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(path.join(RUN_DIR, `api-${label}.log`), logs);
  const probe = logs
    .split("\n")
    .map((l) => l.indexOf("[loadtest] {") >= 0 ? l.slice(l.indexOf("[loadtest] {") + 11) : null)
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l));
  const grep = (re: RegExp) => logs.split("\n").filter((l) => re.test(l)).length;

  // ── duplicates after the restart ──
  const ids = [...postedClientIds.keys()];
  const dupRows = ids.length
    ? await db.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM (SELECT client_id FROM pipeline_messages WHERE client_id = ANY($1::text[]) GROUP BY client_id HAVING count(*) > 1) d`,
        ids,
      )
    : [{ n: 0 }];
  const stored = ids.length
    ? await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pipeline_messages WHERE client_id = ANY($1::text[])`, ids)
    : [{ n: 0 }];
  const acked = [...postedClientIds.values()].filter((v) => v.status === 200 || v.status === 201).length;
  const retried = [...postedClientIds.values()].filter((v) => v.tries > 1).length;
  const dupNotif = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM (SELECT user_id, metadata->>'pid' AS pid FROM notifications
       WHERE type = 'PIPELINE' AND read = false AND metadata->>'kind' = 'messages' GROUP BY 1, 2 HAVING count(*) > 1) d`,
  );

  // ── summarise ──
  const inRestart = (r: Rec) => restartWindow && r.t >= restartWindow.from - 1000 && r.t <= (restartWindow.to || Date.now()) + 1000;
  const nonPipe: Cls[] = ["login", "submit", "today", "reports", "bell"];
  const by = (cls: Cls, f: (r: Rec) => boolean = () => true) => recs.filter((r) => r.cls === cls && f(r));
  const lat = (cls: Cls) => {
    const rs = by(cls, (r) => (cls === "herd" || !inRestart(r)) && r.status >= 200 && r.status < 300);
    return { n: rs.length, p50: percentile(rs.map((r) => r.ms), 50), p95: percentile(rs.map((r) => r.ms), 95), max: percentile(rs.map((r) => r.ms), 100) };
  };
  const inBuild = (r: Rec) => buildWindow && r.t >= buildWindow.from && r.t <= (buildWindow.to || Date.now());
  const steady = (cls: Cls) => {
    const rs = by(cls, (r) => !inRestart(r) && !inBuild(r) && r.status >= 200 && r.status < 300);
    return { n: rs.length, p50: percentile(rs.map((r) => r.ms), 50), p95: percentile(rs.map((r) => r.ms), 95) };
  };
  const statusHist = (cls: Cls) => {
    const h: Record<string, number> = {};
    for (const r of by(cls)) h[r.status] = (h[r.status] ?? 0) + 1;
    return h;
  };
  const nonPipeOutside = recs.filter((r) => nonPipe.includes(r.cls) && !inRestart(r));
  const firstSubmits = by("submit", (r) => r.first === true);
  const result = {
    label,
    pipelineOn,
    minutes,
    requests: recs.length,
    events,
    restartWindowMs: restartWindow ? (restartWindow.to || Date.now()) - restartWindow.from : null,
    classes: Object.fromEntries(
      (["pipeline_sync", "pipeline_post", "pipeline_other", "pipeline_bootstrap", "login", "submit", "today", "reports", "bell", "herd"] as Cls[]).map((c) => [
        c,
        { latency: lat(c), steadyLatency: steady(c), status: statusHist(c) },
      ]),
    ),
    nonPipeline: {
      requests: nonPipeOutside.length,
      "429": nonPipeOutside.filter((r) => r.status === 429).length,
      "5xx": nonPipeOutside.filter((r) => r.status >= 500).length,
      networkErrors: nonPipeOutside.filter((r) => r.status === 0).length,
      inRestartWindow: recs.filter((r) => nonPipe.includes(r.cls) && inRestart(r)).length,
      inRestartWindow5xxOr0: recs.filter((r) => nonPipe.includes(r.cls) && inRestart(r) && (r.status >= 500 || r.status === 0)).length,
    },
    firstSubmit: {
      n: firstSubmits.length,
      errors: firstSubmits.filter((r) => r.status < 200 || r.status >= 300).length,
      errorRate: firstSubmits.length ? firstSubmits.filter((r) => r.status < 200 || r.status >= 300).length / firstSubmits.length : null,
    },
    triage429: recs.filter((r) => r.user.startsWith("triage:") && r.status === 429).length,
    triageRequests: recs.filter((r) => r.user.startsWith("triage:")).length,
    heavyTabSync: (() => {
      const rs = recs.filter((r) => r.cls === "pipeline_sync" && r.user === heavyTab.userId && !inRestart(r) && r.status === 200);
      return { n: rs.length, p95: percentile(rs.map((r) => r.ms), 95) };
    })(),
    pipelineConnections: { samples: connSamples.length, max: connSamples.length ? Math.max(...connSamples) : null },
    buildWindowMs: buildWindow ? (buildWindow.to || Date.now()) - buildWindow.from : null,
    cpuPercentOfOneCore: {
      samples: cpuSamples.length,
      totalMedian: percentile(cpuSamples.map((c) => c.total), 50),
      totalP95: percentile(cpuSamples.map((c) => c.total), 95),
      apiMedian: percentile(cpuSamples.map((c) => c.api), 50),
      postgresMedian: percentile(cpuSamples.map((c) => c.postgres), 50),
      steadyTotalMedian: percentile(cpuSamples.filter((c) => !(buildWindow && c.t >= buildWindow.from && c.t <= buildWindow.to)).map((c) => c.total), 50),
    },
    probe: {
      windows: probe.length,
      eldP99Windows: { max: probe.length ? Math.max(...probe.map((p) => p.eld.p99)) : null, p95: percentile(probe.map((p) => p.eld.p99), 95), median: percentile(probe.map((p) => p.eld.p99), 50) },
      eldBootLast: probe.length ? probe[probe.length - 1].eldBoot : null,
      eldBootBeforeKill: (() => {
        if (!restartWindow) return null;
        const before = probe.filter((p) => p.t < restartWindow!.from);
        return before.length ? before[before.length - 1].eldBoot : null;
      })(),
      rssMb: { median: percentile(probe.map((p) => p.rssMb), 50), max: probe.length ? Math.max(...probe.map((p) => p.rssMb)) : null },
      serverSyncP95Windows: { max: percentile(probe.map((p) => p.pipe.syncP95Ms ?? 0), 100), median: percentile(probe.filter((p) => p.pipe.syncs).map((p) => p.pipe.syncP95Ms), 50) },
      heavyHoldP95Windows: (() => {
        const w = probe.filter((p) => p.pipe.heavyHoldSamples > 0).map((p) => p.pipe.heavyHoldP95Ms);
        return { windows: w.length, max: w.length ? Math.max(...w) : null, median: percentile(w, 50) };
      })(),
      holdP95Windows: { max: percentile(probe.map((p) => p.pipe.holdP95Ms ?? 0), 100) },
      totals: probe.reduce(
        (a, p) => ({
          syncs: a.syncs + p.pipe.syncs,
          writes: a.writes + p.pipe.writes,
          slowSyncs: a.slowSyncs + p.pipe.slowSyncs,
          busy503: a.busy503 + p.pipe.busy503,
          conflicts409: a.conflicts409 + p.pipe.conflicts409,
          notifRows: a.notifRows + p.pipe.notifRows,
          rl429: a.rl429 + p.pipe.rateLimited.read + p.pipe.rateLimited.write + p.pipe.rateLimited.message,
          bulkheadWaits: a.bulkheadWaits + p.pipe.bulkheadWaits,
          maxQueue: Math.max(a.maxQueue, p.pipe.maxQueue),
        }),
        { syncs: 0, writes: 0, slowSyncs: 0, busy503: 0, conflicts409: 0, notifRows: 0, rl429: 0, bulkheadWaits: 0, maxQueue: 0 },
      ),
    },
    logGreps: {
      P2024: grep(/P2024/),
      P2028: grep(/P2028/),
      poolTimeout: grep(/Timed out fetching a new connection/),
      pipeline500: grep(/\[pipeline\] 500/),
      unhandled: grep(/unhandledRejection|uncaughtException|FATAL/),
      oom: grep(/heap out of memory|Killed/),
      supervisorRestarts: grep(/\[supervisor\] api exited/),
    },
    duplicates: { posted: ids.length, acked, retried, stored: stored[0].n, duplicateClientIds: dupRows[0].n, duplicateUnreadGrouped: dupNotif[0].n },
  };
  fs.writeFileSync(path.join(RUN_DIR, `result-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

const cmd = process.argv[2];
(cmd === "seed" ? seed() : cmd === "run" ? run() : Promise.reject(new Error("usage: pipeline-load.ts seed|run")))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
