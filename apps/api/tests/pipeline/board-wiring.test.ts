/**
 * pipeline/board-wiring.test.ts — the REAL board snapshot builder is installed behind route
 * #3's `board` field when the pipeline services load.
 *
 * sync.test.ts drives the provider seam with fakes (and nulls it in beforeEach), so it could
 * not see that nothing in src ever registered getBoardSnapshot: every board-mounted client
 * got `board: null` and its own v back forever, and the HR board never left its skeleton.
 * Found by the integration browser E2E, 2026-09-29.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { invalidateBoardSnapshot } from "../../src/services/pipeline/board";
import { pipelineDb } from "../../src/services/pipeline/db";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import { createProjectFixture } from "./fixtures-messages";

describe("pipeline board snapshot wiring", () => {
  beforeEach(async () => {
    resetPipelineStateForTests();
    invalidateBoardSnapshot();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
  });

  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  it("a board-mounted first sync (v -1) gets the real snapshot with the live phases and cards", async () => {
    const owner = await createPipelineUser({ name: "Wiring Owner", tag: "wiring-owner" });
    const project = await createProjectFixture({ ownerId: owner.id, title: "Wired card" });
    const res = await request(app)
      .post("/v1/pipeline/sync")
      .set({ Authorization: `Bearer ${hrToken(owner.id)}` })
      .send({ clientBuild: 1, board: { v: -1 } });
    expect(res.status).toBe(200);
    const { v, board } = res.body.data;
    expect(board).not.toBeNull();
    expect(board.v).toBe(v);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(board.phases.map((p: { key: string }) => p.key)).toEqual([
      "brief", "planning", "in_production", "review", "approved", "live", "done",
    ]);
    expect(board.cards.map((c: { id: string }) => c.id)).toContain(project.id);

    // Holding that v, the next tick costs nothing: no snapshot on the wire.
    const again = await request(app)
      .post("/v1/pipeline/sync")
      .set({ Authorization: `Bearer ${hrToken(owner.id)}` })
      .send({ clientBuild: 1, board: { v } });
    expect(again.body.data.board).toBeNull();
    expect(again.body.data.v).toBe(v);
  });
});
