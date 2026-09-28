/**
 * pipeline/gates.test.ts — G0 (token allowlist) and G (mode, pilot, active user) (spec §3.2, §4).
 *
 * ⚠️ All three portals sign access tokens with ONE secret, and `authenticate` checks only
 * the signature — so it alone would admit internal-employee tokens, client-portal access
 * tokens and even client-portal REFRESH tokens (`{userId}` with no `type`). The pipeline
 * therefore gates on an ALLOWLIST of token types (["hr"] in v1).
 *
 * The feature ships dark: an absent `pipeline.mode` row is "off". A settings read that
 * FAILS must answer 503 (retried silently) — never 403 PIPELINE_DISABLED, which the client
 * shows as "paused". A missing schema (the boot self-check failed) shows as paused.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma, PrismaClient } from "@dashmani/db";
import app from "../../src/app";
import { invalidatePipelineCaches, resetPipelineStateForTests } from "../../src/services/pipeline";
import { __setPipelineSettingsLoaderForTests, __expirePipelineSettingsMemoForTests } from "../../src/services/pipeline/settings";
import { __setPipelineSchemaOkForTests, isPipelineSchemaOk } from "../../src/services/pipeline/self-check";
import { bumpBoard, isBoardBumpPending } from "../../src/services/pipeline/board";
import { pipelineDb, buildPipelineDbUrl } from "../../src/services/pipeline/db";
import { pipelineGate, pipelineWrite } from "../../src/services/pipeline/tx";
import { assertOwnerOrAdmin } from "../../src/middleware/pipeline-gates";
import {
  hrToken,
  tokenFor,
  typelessToken,
  setPipelineSetting,
  clearPipelineSettings,
  createPipelineUser,
  seedPipelinePhases,
} from "./pipeline-helpers";

const BOOT = "/v1/pipeline/bootstrap";
const DIR = "/v1/pipeline/directory";

// ⚠️ Vitest 1.x runs hooks of the SAME level in parallel: tests/setup.ts's TRUNCATE is a
// top-level beforeEach, so a seeding hook at the top level races it. Everything that
// touches the database lives inside this describe, whose hooks run after the root's.
describe("pipeline gates", () => {
  beforeEach(async () => {
    // Caches AND the bulkhead / pending-bump / heal-throttle state (the board tests use them).
    resetPipelineStateForTests();
    __setPipelineSettingsLoaderForTests(null);
    await clearPipelineSettings();
    await seedPipelinePhases();
  });

  afterAll(async () => {
    __setPipelineSettingsLoaderForTests(null);
    await clearPipelineSettings();
    invalidatePipelineCaches();
    await pipelineDb.$disconnect();
  });

  const get = (path: string, token?: string) => {
    const r = request(app).get(path);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };

  describe("G0 — token-type allowlist", () => {
    beforeEach(() => setPipelineSetting("pipeline.mode", "on"));

    it("an HR token is admitted", async () => {
      const u = await createPipelineUser({ name: "Hema HR", tag: "g0-hr" });
      const boot = await get(BOOT, hrToken(u.id));
      expect(boot.status).toBe(200);
      expect(boot.body.data.enabled).toBe(true);
      expect(boot.headers["cache-control"]).toBe("no-store");
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
    });

    it("an internal employee token, a client access token and a typeless client refresh token are 403 FORBIDDEN", async () => {
      const u = await createPipelineUser({ name: "Eli Employee", tag: "g0-emp" });
      const tokens = [tokenFor(u.id, "employee"), tokenFor(u.id, "client"), typelessToken(u.id)];
      for (const t of tokens) {
        for (const path of [BOOT, DIR]) {
          const r = await get(path, t);
          expect(r.status).toBe(403);
          expect(r.body.error.code).toBe("FORBIDDEN");
          expect(r.headers["cache-control"]).toBe("no-store");
        }
      }
      // The unknown-path fallback is gated the same way.
      const unknown = await request(app).post("/v1/pipeline/sync").set("Authorization", `Bearer ${typelessToken(u.id)}`).send({ clientBuild: 1 });
      expect(unknown.status).toBe(403);
    });

    it("no token and an expired token are 401", async () => {
      const u = await createPipelineUser({ name: "Ned NoToken", tag: "g0-none" });
      for (const path of [BOOT, DIR, "/v1/pipeline/nope"]) {
        for (const r of [await get(path), await get(path, hrToken(u.id, { expiresIn: -60 }))]) {
          expect(r.status).toBe(401);
          // authenticate is not pipeline code, but every pipeline response is no-store.
          expect(r.headers["cache-control"]).toBe("no-store");
        }
      }
    });
  });

  describe("G — active user", () => {
    beforeEach(() => setPipelineSetting("pipeline.mode", "on"));

    it("an INACTIVE user is 403 ACCOUNT_INACTIVE; bootstrap says so instead", async () => {
      const u = await createPipelineUser({ name: "Ina Inactive", tag: "g-inactive", status: "INACTIVE" });
      const dir = await get(DIR, hrToken(u.id));
      expect(dir.status).toBe(403);
      expect(dir.body.error.code).toBe("ACCOUNT_INACTIVE");
      const boot = await get(BOOT, hrToken(u.id));
      expect(boot.status).toBe(200);
      expect(boot.body.data).toEqual({ enabled: false, reason: "inactive" });
    });

    it("a soft-deleted user is 403 ACCOUNT_INACTIVE", async () => {
      const u = await createPipelineUser({ name: "Del Deleted", tag: "g-deleted", deleted: true });
      const dir = await get(DIR, hrToken(u.id));
      expect(dir.status).toBe(403);
      expect(dir.body.error.code).toBe("ACCOUNT_INACTIVE");
    });

    it("a token for a user that does not exist is 403 ACCOUNT_INACTIVE", async () => {
      const dir = await get(DIR, hrToken("00000000-0000-4000-8000-00000000dead"));
      expect(dir.status).toBe(403);
      expect(dir.body.error.code).toBe("ACCOUNT_INACTIVE");
    });

    it("a deactivation is seen after the access memo is invalidated", async () => {
      const u = await createPipelineUser({ name: "Dee Deactivated", tag: "g-deact" });
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      await prisma.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } });
      // Within the 60 s memo the cached {active:true} is still used (no query per request)…
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      // …and after invalidation the gate reads the new status.
      invalidatePipelineCaches();
      const r = await get(DIR, hrToken(u.id));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("ACCOUNT_INACTIVE");
    });
  });

  describe("mode", () => {
    it("no pipeline.mode row: bootstrap {enabled:false, reason:'off'}; directory 403 PIPELINE_DISABLED", async () => {
      const u = await createPipelineUser({ name: "Mo Missing", tag: "m-missing" });
      const boot = await get(BOOT, hrToken(u.id));
      expect(boot.status).toBe(200);
      expect(boot.body.data).toEqual({ enabled: false, reason: "off" });
      const dir = await get(DIR, hrToken(u.id));
      expect(dir.status).toBe(403);
      expect(dir.body.error.code).toBe("PIPELINE_DISABLED");
    });

    it("an explicit 'off' and an unknown mode value are both off", async () => {
      const u = await createPipelineUser({ name: "Of Off", tag: "m-off" });
      for (const value of ["off", "enabled", ""]) {
        invalidatePipelineCaches();
        await setPipelineSetting("pipeline.mode", value);
        expect((await get(DIR, hrToken(u.id))).body.error.code).toBe("PIPELINE_DISABLED");
      }
    });

    it("pilot mode: a user not on the list is 403 PIPELINE_NOT_IN_PILOT; a listed user is admitted", async () => {
      const listed = await createPipelineUser({ name: "Pia Pilot", tag: "m-pilot-in" });
      const other = await createPipelineUser({ name: "Oli Outside", tag: "m-pilot-out" });
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([listed.id]));
      const denied = await get(DIR, hrToken(other.id));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("PIPELINE_NOT_IN_PILOT");
      expect((await get(BOOT, hrToken(other.id))).body.data).toEqual({ enabled: false, reason: "not_in_pilot" });

      expect((await get(DIR, hrToken(listed.id))).status).toBe(200);
      const boot = await get(BOOT, hrToken(listed.id));
      expect(boot.body.data).toMatchObject({ enabled: true, mode: "pilot", navVisible: false });
    });

    it("the pilot list also accepts a comma/space separated value", async () => {
      const a = await createPipelineUser({ name: "Ann A", tag: "m-list-a" });
      const b = await createPipelineUser({ name: "Ben B", tag: "m-list-b" });
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", `${a.id}, ${b.id}`);
      expect((await get(DIR, hrToken(a.id))).status).toBe(200);
      expect((await get(DIR, hrToken(b.id))).status).toBe(200);
    });

    it("mode 'on' admits every active HR user and shows the nav", async () => {
      const u = await createPipelineUser({ name: "Onna On", tag: "m-on" });
      await setPipelineSetting("pipeline.mode", "on");
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      expect((await get(BOOT, hrToken(u.id))).body.data).toMatchObject({ enabled: true, mode: "on", navVisible: true });
    });
  });

  describe("failure paths", () => {
    it("a settings read failure with no last-known value is 503 PIPELINE_BUSY, never 403", async () => {
      const u = await createPipelineUser({ name: "Fay Failure", tag: "f-settings" });
      __setPipelineSettingsLoaderForTests(async () => {
        throw new Error("connection reset");
      });
      for (const path of [DIR, BOOT]) {
        const r = await get(path, hrToken(u.id));
        expect(r.status).toBe(503);
        expect(r.body.error.code).toBe("PIPELINE_BUSY");
        expect(r.body.error.retryAfterSec).toBeGreaterThanOrEqual(1);
        expect(r.headers["retry-after"]).toBeDefined();
      }
    });

    it("a settings read failure within 5 minutes of a good read serves the last-known value", async () => {
      const u = await createPipelineUser({ name: "Lana LastKnown", tag: "f-lastknown" });
      await setPipelineSetting("pipeline.mode", "on");
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      __expirePipelineSettingsMemoForTests();
      __setPipelineSettingsLoaderForTests(async () => {
        throw new Error("connection reset");
      });
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
    });

    it("while serving the last-known value after a failed read, settings are re-read at most every 2 s", async () => {
      // Without a backoff every gated request after the 15 s TTL would start (and wait
      // for) a fresh failing load before falling back — doubling time-to-answer and
      // occupying a read slot per retry during exactly the blip it is riding out.
      const u = await createPipelineUser({ name: "Bea Backoff", tag: "f-backoff" });
      await setPipelineSetting("pipeline.mode", "on");
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      __expirePipelineSettingsMemoForTests();
      let calls = 0;
      __setPipelineSettingsLoaderForTests(async () => {
        calls++;
        throw new Error("connection reset");
      });
      for (let i = 0; i < 3; i++) expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      expect(calls).toBe(1);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 2_500);
        expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
      expect(calls).toBe(2);
    });

    it("with no last-known value, a failed settings read answers 503 fast for 2 s instead of re-reading per request", async () => {
      const u = await createPipelineUser({ name: "Fio Fast", tag: "f-fastfail" });
      let calls = 0;
      __setPipelineSettingsLoaderForTests(async () => {
        calls++;
        throw new Error("connection reset");
      });
      for (let i = 0; i < 3; i++) {
        const r = await get(DIR, hrToken(u.id));
        expect(r.status).toBe(503);
        expect(r.body.error.code).toBe("PIPELINE_BUSY");
      }
      expect(calls).toBe(1);
      __setPipelineSettingsLoaderForTests(null);
      await setPipelineSetting("pipeline.mode", "on");
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 2_500);
        expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a transient self-check failure answers 503 without re-probing for 5 s, then checks again", async () => {
      const u = await createPipelineUser({ name: "Tom Transient", tag: "f-transient" });
      await setPipelineSetting("pipeline.mode", "on");
      // A full gate makes the probe's pipelineRead fail with queue_full: transient (503),
      // so the verdict stays unknown.
      const s = pipelineGate.stats();
      const held = await Promise.all(Array.from({ length: s.max }, () => pipelineGate.acquire("read")));
      const fillers = Array.from({ length: s.queue }, () => pipelineGate.run("read", async () => undefined));
      expect((await get(DIR, hrToken(u.id))).status).toBe(503);
      for (const release of held) release();
      await Promise.all(fillers);
      expect(isPipelineSchemaOk()).toBeNull();

      const granted = pipelineGate.stats().granted;
      const again = await get(DIR, hrToken(u.id));
      expect(again.status).toBe(503);
      expect(again.body.error.code).toBe("PIPELINE_BUSY");
      expect(pipelineGate.stats().granted).toBe(granted); // no probe was attempted

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 5_500);
        expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
      expect(isPipelineSchemaOk()).toBe(true);
    });

    it("a failed schema self-check is 403 PIPELINE_DISABLED (paused), not 500", async () => {
      const u = await createPipelineUser({ name: "Sam Schema", tag: "f-schema" });
      await setPipelineSetting("pipeline.mode", "on");
      __setPipelineSchemaOkForTests(false);
      const dir = await get(DIR, hrToken(u.id));
      expect(dir.status).toBe(403);
      expect(dir.body.error.code).toBe("PIPELINE_DISABLED");
      expect((await get(BOOT, hrToken(u.id))).body.data).toEqual({ enabled: false, reason: "paused" });
    });

    it("the schema self-check runs lazily on the first gated request and passes on a migrated database", async () => {
      const u = await createPipelineUser({ name: "Lee Lazy", tag: "f-lazy" });
      await setPipelineSetting("pipeline.mode", "on");
      expect(isPipelineSchemaOk()).toBeNull();
      expect((await get(DIR, hrToken(u.id))).status).toBe(200);
      expect(isPipelineSchemaOk()).toBe(true);
    });
  });

  describe("+O — owner or admin, checked fresh in the action's transaction", () => {
    const check = (actorId: string, ownerId: string) => pipelineWrite((tx) => assertOwnerOrAdmin(tx, { actorId, ownerId }));

    it("the owner passes; an ACTIVE Admin or Super Admin who is not the owner passes as admin", async () => {
      const owner = await createPipelineUser({ name: "Oona Owner", tag: "o-owner" });
      const admin = await createPipelineUser({ name: "Ada Admin", tag: "o-admin", roleNames: ["Admin"] });
      const sup = await createPipelineUser({ name: "Sal Super", tag: "o-super", roleNames: ["Super Admin"] });
      expect(await check(owner.id, owner.id)).toEqual({ isOwner: true, isAdmin: false });
      expect(await check(admin.id, owner.id)).toEqual({ isOwner: false, isAdmin: true });
      expect(await check(sup.id, owner.id)).toEqual({ isOwner: false, isAdmin: true });
    });

    it("a plain member, an INACTIVE Admin and a soft-deleted Admin are 403 NOT_OWNER_OR_ADMIN", async () => {
      const owner = await createPipelineUser({ name: "Oli Owner", tag: "o-owner2" });
      const plain = await createPipelineUser({ name: "Pat Plain", tag: "o-plain", roleNames: ["Employee"] });
      const inactive = await createPipelineUser({ name: "Ira Inactive", tag: "o-inactive", roleNames: ["Admin"], status: "INACTIVE" });
      const deleted = await createPipelineUser({ name: "Dev Deleted", tag: "o-deleted", roleNames: ["Super Admin"], deleted: true });
      for (const actor of [plain, inactive, deleted]) {
        await expect(check(actor.id, owner.id)).rejects.toMatchObject({ statusCode: 403, code: "NOT_OWNER_OR_ADMIN" });
      }
    });
  });

  describe("board bump", () => {
    const seq = async () => (await prisma.pipelineBoardState.findUnique({ where: { id: 1 } }))!.seq;

    it("the (lazy) boot self-check bumps the board version exactly once", async () => {
      const u = await createPipelineUser({ name: "Bo Bump", tag: "b-boot" });
      await setPipelineSetting("pipeline.mode", "on");
      expect(await seq()).toBe(0);
      await get(DIR, hrToken(u.id));
      expect(await seq()).toBe(1);
      await get(DIR, hrToken(u.id));
      expect(await seq()).toBe(1);
    });

    it("a bump that fails is remembered and retried by the next gated request", async () => {
      const u = await createPipelineUser({ name: "Pen Pending", tag: "b-pending" });
      await setPipelineSetting("pipeline.mode", "on");
      await get(DIR, hrToken(u.id)); // self-check + its bump → seq 1
      expect(await seq()).toBe(1);

      // Hold the board row on another connection so the bump hits lock_timeout (1 s).
      const locker = new PrismaClient({ datasources: { db: { url: buildPipelineDbUrl(process.env.DATABASE_URL, 1)! } } });
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      let markLocked!: () => void;
      const locked = new Promise<void>((r) => (markLocked = r));
      const holder = locker.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT seq FROM pipeline_board_state WHERE id = 1 FOR UPDATE`;
          markLocked();
          await hold;
        },
        { maxWait: 5000, timeout: 15000 },
      );
      await locked;
      const result = await bumpBoard();
      release();
      await holder;
      await locker.$disconnect();

      expect(result).toBeNull();
      expect(isBoardBumpPending()).toBe(true);
      expect(await seq()).toBe(1);

      await get(DIR, hrToken(u.id));
      expect(isBoardBumpPending()).toBe(false);
      expect(await seq()).toBe(2);
    });

    it("a bump that fails while another bump is in flight stays pending when that other bump succeeds", async () => {
      // Spec §5.1: a success may only clear failures that happened BEFORE it started. A bump
      // whose UPDATE ran before writer B committed cannot cover B's change, so B's failed
      // bump must stay pending even though a bump succeeded after it failed.
      const u = await createPipelineUser({ name: "Rae Race", tag: "b-race" });
      await setPipelineSetting("pipeline.mode", "on");
      await get(DIR, hrToken(u.id)); // self-check bump → seq 1
      expect(await seq()).toBe(1);

      // Hold every slot so bump A queues (it has started), then fill the queue so bump B
      // is refused immediately (queue_full) while A is still in flight.
      const s = pipelineGate.stats();
      const held = await Promise.all(Array.from({ length: s.max }, () => pipelineGate.acquire("read")));
      const a = bumpBoard();
      const fillers = Array.from({ length: s.queue - 1 }, () => pipelineGate.run("read", async () => undefined));
      expect(pipelineGate.stats().queued).toBe(s.queue);
      expect(await bumpBoard()).toBeNull(); // B fails → pending
      expect(isBoardBumpPending()).toBe(true);

      for (const release of held) release();
      expect(await a).toBe(2); // A succeeds (queued writes go first)…
      await Promise.all(fillers);
      expect(isBoardBumpPending()).toBe(true); // …but must not clear B's failure

      // The next gated request heals it.
      await get(DIR, hrToken(u.id));
      expect(isBoardBumpPending()).toBe(false);
      expect(await seq()).toBe(3);
    });

    it("a bump that succeeds after an earlier failure clears the pending flag", async () => {
      await setPipelineSetting("pipeline.mode", "on");
      const s = pipelineGate.stats();
      const held = await Promise.all(Array.from({ length: s.max }, () => pipelineGate.acquire("read")));
      const fillers = Array.from({ length: s.queue }, () => pipelineGate.run("read", async () => undefined));
      expect(await bumpBoard()).toBeNull();
      expect(isBoardBumpPending()).toBe(true);
      for (const release of held) release();
      await Promise.all(fillers);
      expect(await bumpBoard()).not.toBeNull(); // started after the failure → covers it
      expect(isBoardBumpPending()).toBe(false);
    });

    it("a failing heal is attempted at most once per 5 s, so a stuck board row cannot slow every request", async () => {
      const u = await createPipelineUser({ name: "Tia Throttle", tag: "b-throttle" });
      await setPipelineSetting("pipeline.mode", "on");
      await get(DIR, hrToken(u.id)); // self-check bump → seq 1

      const locker = new PrismaClient({ datasources: { db: { url: buildPipelineDbUrl(process.env.DATABASE_URL, 1)! } } });
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      let markLocked!: () => void;
      const locked = new Promise<void>((r) => (markLocked = r));
      const holder = locker.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT seq FROM pipeline_board_state WHERE id = 1 FOR UPDATE`;
          markLocked();
          await hold;
        },
        { maxWait: 5000, timeout: 20000 },
      );
      try {
        await locked;
        expect(await bumpBoard()).toBeNull(); // fails on lock_timeout → pending
        expect(isBoardBumpPending()).toBe(true);

        // The next request tries the heal once (and pays the 1 s lock_timeout)…
        let t0 = Date.now();
        expect((await get(DIR, hrToken(u.id))).status).toBe(200);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
        // …the one right after does not retry it and is fast.
        t0 = Date.now();
        expect((await get(DIR, hrToken(u.id))).status).toBe(200);
        expect(Date.now() - t0).toBeLessThan(500);
        expect(isBoardBumpPending()).toBe(true);
      } finally {
        release();
        await holder;
        await locker.$disconnect();
      }

      // Unlocked, but still inside the 5 s window: no attempt yet.
      await get(DIR, hrToken(u.id));
      expect(isBoardBumpPending()).toBe(true);
      expect(await seq()).toBe(1);

      // After the window the next request heals it.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 6_000);
        await get(DIR, hrToken(u.id));
      } finally {
        vi.useRealTimers();
      }
      expect(isBoardBumpPending()).toBe(false);
      expect(await seq()).toBe(2);
    });
  });
});
