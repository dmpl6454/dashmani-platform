/**
 * pipeline/activity.test.ts — a project's activity timeline (2026-11-24).
 *
 * The rules locked here:
 *   - creating, moving, documents (add / status / delete / shared in chat), reviews (asked /
 *     decided), a page going live, status notes and versions each write one row, newest first;
 *   - a quick run of moves by one person is ONE row, and a run back to the start removes it;
 *   - the timeline is separate from the chat: deleting a message changes nothing;
 *   - an activity write that fails never fails the action (the savepoint);
 *   - a project older than the timeline still shows its creation.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { activityText, type PipelineActivityDto } from "@dashmani/shared";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const B = "/v1/pipeline";
const P = `${B}/projects`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function hrUser(name: string) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-") });
  return { ...u, token: hrToken(u.id) };
}

async function newProject(token: string, title = "Diwali") {
  const r = await request(app).post(P).set(auth(token)).send({ clientId: crypto.randomUUID(), title });
  expect(r.status).toBe(201);
  return r.body.data.card.id as string;
}

const activity = async (token: string, id: string) => {
  const r = await request(app).get(`${P}/${id}/activity`).set(auth(token));
  expect(r.status).toBe(200);
  return (r.body.data as PipelineActivityDto).items;
};

const phaseId = async (key: string) => (await prisma.pipelinePhase.findFirstOrThrow({ where: { key } })).id;
const move = (token: string, id: string, toPhaseId: string, basePhaseId: string) =>
  request(app).post(`${P}/${id}/move`).set(auth(token)).send({ toPhaseId, basePhaseId, afterId: null });

describe("project activity timeline", () => {
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

  it("records the project's story, newest first, and survives chat deletion", async () => {
    const asha = await hrUser("Asha Act");
    const ravi = await hrUser("Ravi Act");
    const id = await newProject(asha.token);
    const brief = await phaseId("brief");
    const planning = await phaseId("planning");

    expect((await move(asha.token, id, planning, brief)).status).toBe(200);
    const doc = await request(app).post(`${P}/${id}/documents`).set(auth(asha.token)).send({ type: "pitch", title: "Pitch v1", url: "https://example.com/p" });
    await request(app).patch(`${B}/documents/${doc.body.data.id}`).set(auth(asha.token)).send({ base: 1, changes: { status: "sent" } });
    await request(app).post(`${P}/${id}/versions`).set(auth(asha.token)).send({ kind: "video", url: "https://example.com/v" });
    await request(app).post(`${P}/${id}/reviews`).set(auth(asha.token)).send({ reviewerId: ravi.id });
    const page = (await request(app).post(`${P}/${id}/deliverables`).set(auth(asha.token)).send({ platform: "instagram", destination: "@diwali" })).body.data;
    // Publishing needs a current approval when there are versions: approve first.
    const rev = (await request(app).get(`${P}/${id}/work`).set(auth(ravi.token))).body.data.reviews[0];
    await request(app).post(`${B}/reviews/${rev.id}/decision`).set(auth(ravi.token)).send({ decision: "approved" });
    const pub = await request(app).patch(`${B}/deliverables/${page.id}`).set(auth(asha.token))
      .send({ base: page.rev, changes: { status: "published", liveUrl: "https://instagram.com/p/x" } });
    expect(pub.status).toBe(200);
    await request(app).put(`${P}/${id}/status-note`).set(auth(asha.token)).send({ text: "Client happy" });

    const items = await activity(asha.token, id);
    expect(items.map((i) => i.kind)).toEqual([
      "note", "page_published", "review_decided", "review_requested", "version_added", "doc_status", "doc_added", "moved", "created",
    ]);
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(byKind.moved.text).toBe("moved it from Brief to Planning");
    expect(byKind.doc_status.text).toBe("marked pitch deck “Pitch v1” as sent");
    expect(byKind.review_requested.text).toBe("asked Ravi Act to review");
    expect(byKind.review_decided).toMatchObject({ text: "approved the review", actor: { id: ravi.id } });
    expect(byKind.page_published).toMatchObject({ text: "went live on Instagram · @diwali", href: "https://instagram.com/p/x" });
    expect(byKind.note.text).toBe("set the status: “Client happy”");
    expect(byKind.created).toMatchObject({ text: "created the project in Brief", actor: { id: asha.id, name: "Asha Act" } });

    // Chat deletion doesn't touch it.
    const msg = await request(app).post(`${P}/${id}/messages`).set(auth(asha.token)).send({ clientId: crypto.randomUUID(), body: "hello" });
    await request(app).delete(`${B}/messages/${msg.body.data.message.id}`).set(auth(asha.token));
    expect((await activity(asha.token, id)).length).toBe(items.length);
  });

  it("merges one person's quick run of moves, and drops a run that ends where it started", async () => {
    const asha = await hrUser("Asha Moves");
    const id = await newProject(asha.token);
    const [brief, planning, review] = [await phaseId("brief"), await phaseId("planning"), await phaseId("review")];
    await move(asha.token, id, planning, brief);
    await move(asha.token, id, review, planning);
    let moves = (await activity(asha.token, id)).filter((i) => i.kind === "moved");
    expect(moves.map((m) => m.text)).toEqual(["moved it from Brief to Review"]);
    await move(asha.token, id, brief, review);
    moves = (await activity(asha.token, id)).filter((i) => i.kind === "moved");
    expect(moves).toEqual([]);
  });

  it("a failed activity write never fails the action, and old projects still show their creation", async () => {
    const asha = await hrUser("Asha Safe");
    const id = await newProject(asha.token);
    // Old project: no rows at all → a synthetic "created" row.
    await prisma.pipelineActivity.deleteMany({ where: { projectId: id } });
    expect((await activity(asha.token, id)).map((i) => i.kind)).toEqual(["created"]);

    // Break the table for this transaction's inserts: the move must still succeed.
    await prisma.$executeRawUnsafe(`ALTER TABLE pipeline_activity ADD CONSTRAINT pl_activity_block CHECK (kind <> 'moved') NOT VALID`);
    try {
      const r = await move(asha.token, id, await phaseId("planning"), await phaseId("brief"));
      expect(r.status).toBe(200);
      expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id } })).phaseId).toBe(await phaseId("planning"));
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE pipeline_activity DROP CONSTRAINT pl_activity_block`);
    }
  });

  it("words every kind (pure)", () => {
    expect(activityText("doc_added", { type: "photo", title: "shoot", via: "chat" })).toBe("shared photo “shoot” in the chat");
    expect(activityText("doc_added", { type: "quote", title: "Q", status: "accepted" })).toBe("added quote “Q” as accepted");
    expect(activityText("doc_deleted", { type: "brief", title: "B" })).toBe("deleted brief “B”");
    expect(activityText("review_decided", { decision: "changes_requested" })).toBe("asked for changes");
    expect(activityText("note", { text: "" })).toBe("cleared the status note");
    expect(activityText("version_added", { kind: "thumbnail", number: 2 })).toBe("added thumbnail v2");
    expect(activityText("mystery", {})).toBe("updated the project");
  });
});
