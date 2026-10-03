/**
 * Plan M6: scripts/pipeline-flag.ts against the test DB, and the hourly `[pipeline] stats`
 * counters (spec §12 step 8).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { snapshotPipelineStats, formatPipelineStats, percentile } from "../../src/services/pipeline/stats";
import { runPipelineFlag, runPipelineFlagCli, WARNING_PAUSE_MS, type PipelineFlagIo } from "../../../../scripts/pipeline-flag";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const setting = async (key: string) => (await prisma.systemSetting.findUnique({ where: { key } }))?.value ?? null;

describe("scripts/pipeline-flag.ts", () => {
  beforeEach(async () => {
    await clearPipelineSettings();
  });
  afterAll(async () => {
    await clearPipelineSettings();
  });

  it("is a dry run by default: prints before/after, writes nothing", async () => {
    const a = await createPipelineUser({ name: "Pilot A", tag: "flag-a" });
    const res = await runPipelineFlag(prisma, { mode: "pilot", add: [a.email.toUpperCase()] });
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.before.mode).toBe("off (absent)");
    expect(res.after).toMatchObject({ mode: "pilot", pilotUserIds: [a.id] });
    expect(res.after.pilot[0]).toMatchObject({ id: a.id, email: a.email, name: "Pilot A" });
    expect(await setting("pipeline.mode")).toBeNull();
    expect(await setting("pipeline.pilotUserIds")).toBeNull();
  });

  it("--apply upserts both keys; add/remove are set operations; a second identical run is a no-op", async () => {
    const [a, b, c] = [
      await createPipelineUser({ name: "Pilot A", tag: "flag-a" }),
      await createPipelineUser({ name: "Pilot B", tag: "flag-b" }),
      await createPipelineUser({ name: "Pilot C", tag: "flag-c" }),
    ];
    const r1 = await runPipelineFlag(prisma, { mode: "pilot", add: [a.email, b.email], apply: true });
    expect(r1.applied).toBe(true);
    expect(await setting("pipeline.mode")).toBe("pilot");
    expect(JSON.parse((await setting("pipeline.pilotUserIds"))!)).toEqual([a.id, b.id].sort());

    const r2 = await runPipelineFlag(prisma, { add: [c.email, a.email], remove: [b.email], apply: true });
    expect(r2.before.pilotUserIds.sort()).toEqual([a.id, b.id].sort());
    expect(JSON.parse((await setting("pipeline.pilotUserIds"))!)).toEqual([a.id, c.id].sort());
    expect(await setting("pipeline.mode")).toBe("pilot"); // untouched without --mode

    const r3 = await runPipelineFlag(prisma, { mode: "pilot", add: [a.email], apply: true });
    expect(r3.changed).toBe(false);
    expect(r3.applied).toBe(false);

    const off = await runPipelineFlag(prisma, { mode: "off", apply: true });
    expect(off.applied).toBe(true);
    expect(await setting("pipeline.mode")).toBe("off");
    expect(JSON.parse((await setting("pipeline.pilotUserIds"))!)).toEqual([a.id, c.id].sort()); // kept for the next pilot
  });

  it("--email=on|off upserts pipeline.email (dry run by default) and leaves everything else alone", async () => {
    const dry = await runPipelineFlag(prisma, { email: "on" });
    expect(dry).toMatchObject({ changed: true, applied: false });
    expect(dry.before.email).toBe("off (absent)");
    expect(dry.after.email).toBe("on");
    expect(await setting("pipeline.email")).toBeNull();

    const on = await runPipelineFlag(prisma, { email: "on", apply: true });
    expect(on.applied).toBe(true);
    expect(await setting("pipeline.email")).toBe("on");
    expect(await setting("pipeline.mode")).toBeNull(); // untouched without --mode
    expect((await runPipelineFlag(prisma, { email: "on", apply: true })).changed).toBe(false);

    const off = await runPipelineFlag(prisma, { email: "off", apply: true });
    expect(off.applied).toBe(true);
    expect(await setting("pipeline.email")).toBe("off");

    const bad = await runPipelineFlag(prisma, { email: "maybe" as never, apply: true });
    expect(bad.errors[0]).toMatch(/--email must be one of/);
    expect(await setting("pipeline.email")).toBe("off");
  });

  it("on → pilot WARNS that it strands non-pilot participants (roll back with --mode=off) but is not blocked", async () => {
    const a = await createPipelineUser({ name: "Pilot A", tag: "flag-a" });
    expect((await runPipelineFlag(prisma, { mode: "on", apply: true })).warnings).toEqual([]); // off → on
    const dry = await runPipelineFlag(prisma, { mode: "pilot", add: [a.email] });
    expect(dry.warnings).toHaveLength(1);
    expect(dry.warnings[0]).toMatch(/not a safe rollback/i);
    expect(dry.warnings[0]).toContain("--mode=off");
    expect(dry.applied).toBe(false);
    const res = await runPipelineFlag(prisma, { mode: "pilot", add: [a.email], apply: true });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.applied).toBe(true); // a warning, never a refusal
    expect(await setting("pipeline.mode")).toBe("pilot");
    // Every other transition is silent.
    expect((await runPipelineFlag(prisma, { mode: "off", apply: true })).warnings).toEqual([]); // pilot → off
    expect((await runPipelineFlag(prisma, { mode: "pilot", apply: true })).warnings).toEqual([]); // off → pilot
    expect((await runPipelineFlag(prisma, { mode: "on", apply: true })).warnings).toEqual([]); // pilot → on
    expect((await runPipelineFlag(prisma, { mode: "on" })).warnings).toEqual([]); // on → on (no change)
    expect((await runPipelineFlag(prisma, { email: "on" })).warnings).toEqual([]);
  });

  it("the CLI prints the on → pilot WARNING, and pauses, BEFORE it writes anything — then writes (never a refusal)", async () => {
    const a = await createPipelineUser({ name: "Pilot A", tag: "flag-a" });
    await runPipelineFlag(prisma, { mode: "on", apply: true });
    const lines: string[] = [];
    let modeDuringPause: string | null = "never paused";
    const io: PipelineFlagIo = {
      log: (s) => lines.push(s),
      warn: (s) => lines.push(s),
      error: (s) => lines.push(s),
      pause: async (ms) => {
        expect(ms).toBe(WARNING_PAUSE_MS);
        expect(lines.join("\n")).toMatch(/not a safe rollback/i); // the warning is already out…
        modeDuringPause = await setting("pipeline.mode"); // …and nothing is written yet
      },
    };
    const res = await runPipelineFlagCli(prisma, { mode: "pilot", add: [a.email], apply: true }, io);
    expect(modeDuringPause).toBe("on");
    expect(res.applied).toBe(true);
    expect(res.stale).toBe(false);
    expect(await setting("pipeline.mode")).toBe("pilot");
    expect(lines.join("\n")).toMatch(/press Ctrl-C now/i); // a terminal: the abort is real
    expect(lines.some((l) => l.startsWith("APPLIED"))).toBe(true);
  });

  it("a setting changed while the CLI waits (the kill switch run from another shell) makes it write NOTHING — never undo it", async () => {
    // The 10 s pause is a deliberate read-then-write gap, and the WARNING itself recommends
    // --mode=off: if a teammate runs it meanwhile, writing the stale on → pilot plan would
    // silently switch Pipeline back on for the pilot in the middle of the incident.
    const a = await createPipelineUser({ name: "Pilot A", tag: "flag-a" });
    await runPipelineFlag(prisma, { mode: "on", apply: true });
    const lines: string[] = [];
    const io: PipelineFlagIo = {
      log: (s) => lines.push(s),
      warn: (s) => lines.push(s),
      error: (s) => lines.push(s),
      pause: async () => {
        expect((await runPipelineFlag(prisma, { mode: "off", apply: true })).applied).toBe(true);
      },
    };
    const res = await runPipelineFlagCli(prisma, { mode: "pilot", add: [a.email], apply: true }, io);
    expect(res.applied).toBe(false);
    expect(res.stale).toBe(true);
    expect(await setting("pipeline.mode")).toBe("off"); // the kill switch stands
    expect(await setting("pipeline.pilotUserIds")).toBeNull(); // nothing of the stale plan landed
    const out = lines.join("\n");
    expect(out).toMatch(/changed after the plan above was printed, so NOTHING was written/i);
    expect(out).toMatch(/NOW {3}: mode=off/);
    expect(lines.some((l) => l.startsWith("APPLIED"))).toBe(false);
  });

  it("outside an interactive terminal the pause does not promise Ctrl-C (it may never reach the process) — and still writes", async () => {
    // `ssh host "… --apply --confirm-prod"` has no TTY: Ctrl-C kills only the local ssh client.
    const a = await createPipelineUser({ name: "Pilot A", tag: "flag-a" });
    await runPipelineFlag(prisma, { mode: "on", apply: true });
    const lines: string[] = [];
    const io: PipelineFlagIo = {
      interactive: false,
      log: (s) => lines.push(s),
      warn: (s) => lines.push(s),
      error: (s) => lines.push(s),
      pause: async () => {},
    };
    const res = await runPipelineFlagCli(prisma, { mode: "pilot", add: [a.email], apply: true }, io);
    const out = lines.join("\n");
    expect(out).not.toMatch(/press Ctrl-C now/i);
    expect(out).toMatch(/not an interactive terminal/i);
    expect(out).toContain("ssh -t");
    expect(res.applied).toBe(true); // a warning, never a refusal
    expect(await setting("pipeline.mode")).toBe("pilot");
  });

  it("the CLI never pauses a change with no warning — the kill switch is instant — and a dry run never writes", async () => {
    await runPipelineFlag(prisma, { mode: "on", apply: true });
    let paused = false;
    const io: PipelineFlagIo = { log() {}, warn() {}, error() {}, pause: async () => void (paused = true) };
    expect((await runPipelineFlagCli(prisma, { mode: "pilot" }, io)).applied).toBe(false); // dry: warns, no pause, no write
    expect(paused).toBe(false);
    expect(await setting("pipeline.mode")).toBe("on");
    expect((await runPipelineFlagCli(prisma, { mode: "off", apply: true }, io)).applied).toBe(true);
    expect(paused).toBe(false);
    expect(await setting("pipeline.mode")).toBe("off");
  });

  it("an unknown email or a bad mode writes nothing", async () => {
    const a = await createPipelineUser({ name: "Pilot A", tag: "flag-a" });
    const res = await runPipelineFlag(prisma, { mode: "pilot", add: [a.email, "nobody@nowhere.test"], apply: true });
    expect(res.errors).toEqual(["no user with email nobody@nowhere.test"]);
    expect(res.applied).toBe(false);
    expect(await setting("pipeline.mode")).toBeNull();
    const bad = await runPipelineFlag(prisma, { mode: "maybe" as never, apply: true });
    expect(bad.errors[0]).toMatch(/--mode must be one of/);
    expect(await setting("pipeline.mode")).toBeNull();
  });

  it("the API honours what it writes (pilot user → bootstrap enabled, others → not)", async () => {
    await seedPipelinePhases();
    resetPipelineStateForTests();
    const [a, b] = [await createPipelineUser({ name: "In", tag: "flag-in" }), await createPipelineUser({ name: "Out", tag: "flag-out" })];
    await runPipelineFlag(prisma, { mode: "pilot", add: [a.email], apply: true });
    const boot = (id: string) => request(app).get("/v1/pipeline/bootstrap").set({ Authorization: `Bearer ${hrToken(id)}` });
    expect((await boot(a.id)).body.data.enabled).toBe(true);
    expect((await boot(b.id)).body.data.enabled).toBe(false);
    resetPipelineStateForTests();
  });
});

describe("[pipeline] stats counters", () => {
  beforeEach(async () => {
    resetPipelineStateForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
  });
  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  it("counts syncs, holds, writes, conflicts and notification rows, and resets per window", async () => {
    const [a, b] = [await createPipelineUser({ name: "Stat A", tag: "st-a" }), await createPipelineUser({ name: "Stat B", tag: "st-b" })];
    const auth = (id: string) => ({ Authorization: `Bearer ${hrToken(id)}` });
    const created = await request(app).post("/v1/pipeline/projects").set(auth(a.id)).send({ clientId: randomUUID(), title: "Stats", memberIds: [b.id] });
    expect(created.status).toBe(201);
    const pid = created.body.data.card.id;
    await request(app).post(`/v1/pipeline/projects/${pid}/messages`).set(auth(a.id)).send({ clientId: randomUUID(), body: "hello" });
    for (let i = 0; i < 3; i++) {
      const s = await request(app).post("/v1/pipeline/sync").set(auth(b.id)).send({ clientBuild: 1, project: { id: pid, rev: 0, hv: 0 } });
      expect(s.status).toBe(200);
    }
    const phases = await prisma.pipelinePhase.findMany({ orderBy: { position: "asc" } });
    const conflict = await request(app)
      .post(`/v1/pipeline/projects/${pid}/move`)
      .set(auth(a.id))
      .send({ toPhaseId: phases[3].id, afterId: null, basePhaseId: phases[2].id });
    expect(conflict.status).toBe(409);

    const snap = snapshotPipelineStats(true);
    expect(snap.syncs).toBe(3);
    expect(snap.syncP95Ms).not.toBeNull();
    expect(snap.holdP95Ms).not.toBeNull();
    expect(snap.writes).toBeGreaterThanOrEqual(3); // create, post, the conflicting move
    expect(snap.conflicts409).toBe(1);
    expect(snap.notifRows).toBeGreaterThanOrEqual(2); // "added" for b, grouped for b
    expect(snap.bumpPending).toBe(false);
    const line = formatPipelineStats(snap);
    expect(line).toMatch(/^\[pipeline\] stats \d+m syncs=3 sync_p95=[\d.]+ms slow_syncs=0 hold_p95=[\d.]+ms writes=\d+ /);
    expect(line).toContain("429_read=0 429_write=0 429_message=0 503_busy=0");
    expect(line).toContain("conflicts=1");

    const next = snapshotPipelineStats();
    expect(next).toMatchObject({ syncs: 0, writes: 0, conflicts409: 0, notifRows: 0, syncP95Ms: null });
  });

  it("percentile is nearest-rank", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
  });
});
