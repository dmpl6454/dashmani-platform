/**
 * pipeline/bootstrap-directory.test.ts — routes #1 and #2 (spec §3.4, §3.5, §9.7).
 *
 * Bootstrap is what the HR client asks once per session: is the feature on for me, which
 * phases exist, how fast to poll, and the limits the composer must honour. Directory is
 * the people list for pickers and author names: NAMES ONLY (no email or phone),
 * bidi-stripped, ONBOARDING users excluded, and a team `hint` only where two people share
 * a name. Both answer from in-process memos — zero statements on a hit.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { PIPELINE_LIMITS, PIPELINE_REACTION_KEYS } from "@dashmani/shared";
import app from "../../src/app";
import { invalidatePipelineCaches } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { pipelineGate } from "../../src/services/pipeline/tx";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const BOOT = "/v1/pipeline/bootstrap";
const DIR = "/v1/pipeline/directory";

// ⚠️ Vitest 1.x runs hooks of the SAME level in parallel: tests/setup.ts's TRUNCATE is a
// top-level beforeEach, so a seeding hook at the top level races it. Everything that
// touches the database lives inside this describe, whose hooks run after the root's.
describe("pipeline bootstrap and directory", () => {
  beforeEach(async () => {
    invalidatePipelineCaches();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
  });

  afterAll(async () => {
    await clearPipelineSettings();
    invalidatePipelineCaches();
    await pipelineDb.$disconnect();
  });

  const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

  describe("GET /v1/pipeline/bootstrap", () => {
    it("returns the enabled payload: me, live phases in order, poll intervals, reactions, limits, minClientBuild", async () => {
      const u = await createPipelineUser({ name: "Priya Sharma", tag: "boot-me" });
      await prisma.pipelinePhase.create({ data: { key: "zz_archived", name: "Old", position: 0, archivedAt: new Date() } });
      await setPipelineSetting("pipeline.minClientBuild", "3");

      const r = await get(BOOT, hrToken(u.id));
      expect(r.status).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      const d = r.body.data;
      expect(d).toMatchObject({ enabled: true, mode: "on", navVisible: true, minClientBuild: 3 });
      expect(d.me).toEqual({ id: u.id, name: "Priya Sharma", isAdmin: false });
      expect(d.phases.map((p: { name: string }) => p.name)).toEqual([
        "Brief",
        "Planning",
        "In Production",
        "Review",
        "Approved",
        "Live",
        "Done",
      ]);
      expect(Object.keys(d.phases[0]).sort()).toEqual(["color", "id", "isTerminal", "key", "name", "position"]);
      expect(d.phases[6]).toMatchObject({ key: "done", isTerminal: true });
      expect(d.pollMs).toEqual({ project: 10000, projectBg: 20000, board: 15000, boardBg: 30000, idle: 30000 });
      expect(d.reactions.map((x: { key: string }) => x.key)).toEqual([...PIPELINE_REACTION_KEYS]);
      expect(d.reactions[0]).toEqual({ key: "thumbs_up", emoji: "👍" });
      expect(d.limits).toEqual(PIPELINE_LIMITS);
    });

    it("isAdmin comes from the database, never from the JWT roles", async () => {
      const admin = await createPipelineUser({ name: "Aisha Admin", tag: "boot-admin", roleNames: ["Admin"] });
      const superAdmin = await createPipelineUser({ name: "Sid Super", tag: "boot-super", roleNames: ["Super Admin"] });
      const plain = await createPipelineUser({ name: "Paul Plain", tag: "boot-plain", roleNames: ["Employee"] });
      expect((await get(BOOT, hrToken(admin.id, { roles: [] }))).body.data.me.isAdmin).toBe(true);
      expect((await get(BOOT, hrToken(superAdmin.id, { roles: [] }))).body.data.me.isAdmin).toBe(true);
      expect((await get(BOOT, hrToken(plain.id, { roles: ["Admin", "Super Admin"] }))).body.data.me.isAdmin).toBe(false);
    });

    it("pipeline.pollMs stretches the intervals with no deploy (a number floors all; an object overrides keys); values are clamped", async () => {
      const u = await createPipelineUser({ name: "Polly Poll", tag: "boot-poll" });
      await setPipelineSetting("pipeline.pollMs", "120000");
      expect((await get(BOOT, hrToken(u.id))).body.data.pollMs).toEqual({
        project: 120000,
        projectBg: 120000,
        board: 120000,
        boardBg: 120000,
        idle: 120000,
      });
      invalidatePipelineCaches();
      await setPipelineSetting("pipeline.pollMs", JSON.stringify({ board: 45000, project: 1 }));
      expect((await get(BOOT, hrToken(u.id))).body.data.pollMs).toEqual({
        project: 2000,
        projectBg: 20000,
        board: 45000,
        boardBg: 30000,
        idle: 30000,
      });
      invalidatePipelineCaches();
      await setPipelineSetting("pipeline.pollMs", "not json");
      expect((await get(BOOT, hrToken(u.id))).body.data.pollMs.project).toBe(10000);
    });

    it("warm bootstrap and directory calls cost ZERO pipeline statements (spec §8.3)", async () => {
      // Every 10 s poll passes the same gates; a statement on the hit path would multiply
      // across every open tab. Count gate grants — every pipeline statement takes one.
      const u = await createPipelineUser({ name: "Zed Zero", tag: "boot-zero" });
      expect((await get(BOOT, hrToken(u.id))).status).toBe(200); // warms schema, settings, access, phases
      expect((await get(DIR, hrToken(u.id))).status).toBe(200); // warms the directory
      const before = pipelineGate.stats().granted;
      expect(before).toBeGreaterThan(0); // the counter is live: the warm-up calls took slots
      for (let i = 0; i < 50; i++) {
        expect((await get(BOOT, hrToken(u.id))).status).toBe(200);
        expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      }
      expect(pipelineGate.stats().granted).toBe(before);
    });

    it("a user created after the directory was cached still gets their own name", async () => {
      const first = await createPipelineUser({ name: "First Person", tag: "boot-first" });
      expect((await get(DIR, hrToken(first.id))).status).toBe(200);
      const late = await createPipelineUser({ name: "Late Joiner", tag: "boot-late" });
      const r = await get(BOOT, hrToken(late.id));
      expect(r.body.data.me.name).toBe("Late Joiner");
    });
  });

  describe("GET /v1/pipeline/directory", () => {
    it("returns names only, excludes ONBOARDING, and marks inactive and deleted users unpickable", async () => {
      const me = await createPipelineUser({ name: "Meera Me", tag: "dir-me", phone: "+911234567890" });
      await createPipelineUser({ name: "Omar Onboarding", tag: "dir-onb", status: "ONBOARDING" });
      const inactive = await createPipelineUser({ name: "Ivan Inactive", tag: "dir-inactive", status: "INACTIVE" });
      const deleted = await createPipelineUser({ name: "Dora Deleted", tag: "dir-deleted", deleted: true });

      const r = await get(DIR, hrToken(me.id));
      expect(r.status).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      const rows = r.body.data as Array<Record<string, unknown>>;
      expect(rows.map((x) => x.name).sort()).toEqual(["Dora Deleted", "Ivan Inactive", "Meera Me"]);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["active", "id", "initials", "name", "pickable"]);
      }
      const json = JSON.stringify(r.body);
      expect(json).not.toContain("@test.com");
      expect(json).not.toContain("+911234567890");
      const byId = new Map(rows.map((x) => [x.id, x]));
      expect(byId.get(me.id)).toEqual({ id: me.id, name: "Meera Me", initials: "MM", active: true, pickable: true });
      expect(byId.get(inactive.id)).toMatchObject({ active: false, pickable: false });
      expect(byId.get(deleted.id)).toMatchObject({ active: false, pickable: false });
    });

    it("a duplicated name carries the primary team as a hint; a unique name does not", async () => {
      const a = await createPipelineUser({ name: "Priya Sharma", tag: "dir-dup-a", teamName: "Social" });
      const b = await createPipelineUser({ name: "priya  sharma", tag: "dir-dup-b", teamName: "Video" });
      const solo = await createPipelineUser({ name: "Rahul Solo", tag: "dir-solo", teamName: "Social" });
      const rows = (await get(DIR, hrToken(solo.id))).body.data as Array<{ id: string; hint?: string }>;
      const byId = new Map(rows.map((x) => [x.id, x]));
      expect(byId.get(a.id)!.hint).toBe("Social");
      expect(byId.get(b.id)!.hint).toBe("Video");
      expect(byId.get(solo.id)!.hint).toBeUndefined();
    });

    it("names are bidi-stripped and capped at 60 characters", async () => {
      const spoof = await createPipelineUser({ name: "‮evil‬ Name", tag: "dir-bidi" });
      const long = await createPipelineUser({ name: "L".repeat(80), tag: "dir-long" });
      const rows = (await get(DIR, hrToken(spoof.id))).body.data as Array<{ id: string; name: string }>;
      const byId = new Map(rows.map((x) => [x.id, x]));
      expect(byId.get(spoof.id)!.name).toBe("evil Name");
      expect(byId.get(long.id)!.name.length).toBeLessThanOrEqual(60);
      expect(byId.get(long.id)!.name.endsWith("…")).toBe(true);
    });

    it("in pilot mode only listed, active users are pickable", async () => {
      const listed = await createPipelineUser({ name: "Lia Listed", tag: "dir-pilot-in" });
      const unlisted = await createPipelineUser({ name: "Uma Unlisted", tag: "dir-pilot-out" });
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([listed.id]));
      invalidatePipelineCaches();
      const rows = (await get(DIR, hrToken(listed.id))).body.data as Array<{ id: string; pickable: boolean }>;
      const byId = new Map(rows.map((x) => [x.id, x]));
      expect(byId.get(listed.id)!.pickable).toBe(true);
      expect(byId.get(unlisted.id)!.pickable).toBe(false);
    });

    it("pilot matching is case-insensitive in the directory exactly as in the gate", async () => {
      // A hand-inserted mixed-case id: the gate lowercases the token's userId before the
      // pilot lookup, so `pickable` must too, or the two disagree about the same person.
      const mixed = await prisma.user.create({
        data: {
          id: "ABCDEF00-0000-4000-8000-00000000C0DE",
          name: "Maya Mixed",
          email: `pl-dir-mixed-${Date.now()}@test.com`,
          passwordHash: "x",
          status: "ACTIVE",
        },
      });
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([mixed.id]));
      invalidatePipelineCaches();
      expect((await get(DIR, hrToken(mixed.id))).status).toBe(200); // the gate admits them…
      const rows = (await get(DIR, hrToken(mixed.id))).body.data as Array<{ id: string; pickable: boolean }>;
      expect(rows.find((x) => x.id === mixed.id)!.pickable).toBe(true); // …and so does the directory
    });

    it("is served from a memo: a user added later appears only after invalidation", async () => {
      const me = await createPipelineUser({ name: "Memo Me", tag: "dir-memo" });
      expect((await get(DIR, hrToken(me.id))).body.data).toHaveLength(1);
      await createPipelineUser({ name: "Memo Later", tag: "dir-memo-later" });
      expect((await get(DIR, hrToken(me.id))).body.data).toHaveLength(1);
      invalidatePipelineCaches();
      expect((await get(DIR, hrToken(me.id))).body.data).toHaveLength(2);
    });
  });
});
