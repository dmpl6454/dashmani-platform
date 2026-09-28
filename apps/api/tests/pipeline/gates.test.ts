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
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma, PrismaClient } from "@dashmani/db";
import app from "../../src/app";
import { invalidatePipelineCaches } from "../../src/services/pipeline";
import { __setPipelineSettingsLoaderForTests, __expirePipelineSettingsMemoForTests } from "../../src/services/pipeline/settings";
import { __setPipelineSchemaOkForTests, isPipelineSchemaOk } from "../../src/services/pipeline/self-check";
import { bumpBoard, isBoardBumpPending } from "../../src/services/pipeline/board";
import { pipelineDb, buildPipelineDbUrl } from "../../src/services/pipeline/db";
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
    invalidatePipelineCaches();
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
      for (const path of [BOOT, DIR]) {
        expect((await get(path)).status).toBe(401);
        expect((await get(path, hrToken(u.id, { expiresIn: -60 }))).status).toBe(401);
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
  });
});
