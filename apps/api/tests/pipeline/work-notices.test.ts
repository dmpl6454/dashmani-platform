/**
 * pipeline/work-notices.test.ts — the dedicated bell rows for Pipeline work (2026-11-02).
 *
 * The rules locked here:
 *   - "please review" reaches the reviewer as a `review` row (not a "mentioned you" row), and
 *     a newer request withdraws the row of the request it replaced;
 *   - a decision reaches whoever asked, as a `reviewed` row (again no mention row);
 *   - a page's assignee gets an `assigned` row; reassigning moves it, unassigning or deleting
 *     the page withdraws it;
 *   - publishing a page tells its creator and assignee (never the person who published);
 *   - a shoot's camera person gets a `shoot` row, moved on reassignment;
 *   - every work row opens the Work tab (or the shoot desk) and never notifies the actor.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { istCallLabel } from "../../src/services/pipeline/shoots.service";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const P = "/v1/pipeline/projects";
const uuid = () => crypto.randomUUID();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function hrUser(name: string) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-") });
  return { ...u, token: hrToken(u.id) };
}

async function newProject(token: string, title = "Reel: premiere") {
  const r = await request(app).post(P).set(auth(token)).send({ clientId: uuid(), title });
  expect(r.status).toBe(201);
  return r.body.data.card.id as string;
}

type Row = { title: string; message: string; read: boolean; metadata: Record<string, unknown> };

/** The user's PIPELINE rows of one metadata.kind. */
async function rows(userId: string, kind: string): Promise<Row[]> {
  const all = await prisma.notification.findMany({ where: { userId, type: "PIPELINE" }, orderBy: { createdAt: "asc" } });
  return all
    .map((n) => ({ title: n.title, message: n.message, read: n.read, metadata: (n.metadata ?? {}) as Record<string, unknown> }))
    .filter((n) => n.metadata.kind === kind);
}

describe("Pipeline work notices", () => {
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

  it("a review request and its decision get their own rows, not mention rows", async () => {
    const editor = await hrUser("Ravi Editor");
    const lead = await hrUser("Kabir Lead");
    const other = await hrUser("Nisha Lead");
    const id = await newProject(editor.token, "Diwali reel");
    await request(app).post(`${P}/${id}/versions`).set(auth(editor.token)).send({ kind: "video", url: "https://nas.example/v1.mp4" });

    const first = (await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: other.id, message: "Before 5" })).body.data.id;
    expect(await rows(other.id, "review")).toHaveLength(1);

    // A new request to someone else replaces the first: Nisha's row goes, Kabir gets one.
    const rid = (await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: lead.id })).body.data.id;
    expect(first).not.toBe(rid);
    expect(await rows(other.id, "review")).toEqual([]);
    const [ask] = await rows(lead.id, "review");
    expect(ask.title).toBe("Ravi Editor asked you to review “Diwali reel”");
    expect(ask.message).toBe("Video v1");
    expect(ask.metadata.path).toBe(`/pipeline/${id}?tab=work`);
    expect(String(ask.metadata.url)).toMatch(/\/pipeline\/[0-9a-f-]+\?tab=work$/);

    // The thread line still mentions the reviewer (that is what emails them)…
    const line = await prisma.pipelineMessage.findFirst({ where: { projectId: id }, orderBy: { seq: "desc" } });
    expect(line?.mentionIds).toContain(lead.id);
    // …but the bell shows one row, not a second "mentioned you".
    expect(await rows(lead.id, "mention")).toEqual([]);

    const decided = await request(app).post(`/v1/pipeline/reviews/${rid}/decision`).set(auth(lead.token))
      .send({ decision: "changes_requested", note: "Trim the intro" });
    expect(decided.status).toBe(200);
    const [back] = await rows(editor.id, "reviewed");
    expect(back.title).toBe("Kabir Lead asked for changes on “Diwali reel”");
    expect(back.message).toBe("Video v1 — Trim the intro");
    expect(await rows(editor.id, "mention")).toEqual([]);
    // Nobody is told about their own action.
    expect(await rows(lead.id, "reviewed")).toEqual([]);
  });

  it("page assignment follows the assignee; publishing tells the creator and assignee", async () => {
    const editor = await hrUser("Meera Editor");
    const pubA = await hrUser("Asha Publisher");
    const pubB = await hrUser("Bilal Publisher");
    const id = await newProject(editor.token, "Trailer drop");

    const d = (await request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token))
      .send({ platform: "instagram", destination: "@bollywood", assigneeId: pubA.id })).body.data;
    const [a] = await rows(pubA.id, "assigned");
    expect(a.title).toBe("Meera Editor assigned you a page in “Trailer drop”");
    expect(a.message).toBe("Instagram · @bollywood");

    // Reassign to Bilal: Asha's row is withdrawn, Bilal gets one.
    const moved = await request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(editor.token))
      .send({ base: d.rev, changes: { assigneeId: pubB.id } });
    expect(moved.status).toBe(200);
    expect(await rows(pubA.id, "assigned")).toEqual([]);
    expect(await rows(pubB.id, "assigned")).toHaveLength(1);

    // Bilal publishes (no versions on the project, so no approval needed): the creator hears,
    // Bilal does not.
    const live = await request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(pubB.token))
      .send({ base: moved.body.data.rev, changes: { status: "published", liveUrl: "https://instagram.com/p/abc" } });
    expect(live.status).toBe(200);
    const [pub] = await rows(editor.id, "published");
    expect(pub.title).toBe("Bilal Publisher published “Trailer drop”");
    expect(pub.message).toBe("Instagram · @bollywood");
    expect(await rows(pubB.id, "published")).toEqual([]);

    // A second page, unassigned then deleted: the row goes with it.
    const d2 = (await request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token))
      .send({ platform: "facebook", destination: "Bollywood Page", assigneeId: pubA.id })).body.data;
    expect(await rows(pubA.id, "assigned")).toHaveLength(1);
    expect((await request(app).delete(`/v1/pipeline/deliverables/${d2.id}`).set(auth(editor.token))).status).toBe(200);
    expect(await rows(pubA.id, "assigned")).toEqual([]);
  });

  it("a shoot's camera person is notified, and the row moves with the shoot", async () => {
    const desk = await hrUser("Desk Lead");
    const camA = await hrUser("Cam One");
    const camB = await hrUser("Cam Two");
    const call = new Date("2026-11-03T11:00:00.000Z"); // 4:30 pm IST
    const s = (await request(app).post("/v1/pipeline/shoots").set(auth(desk.token))
      .send({ title: "Airport arrival", callTime: call.toISOString(), location: "T2 Mumbai", cameraId: camA.id })).body.data;
    const [row] = await rows(camA.id, "shoot");
    expect(row.title).toBe("Desk Lead assigned you a shoot: Airport arrival");
    expect(row.message).toBe("Call Tue 3 Nov, 4:30 pm IST · T2 Mumbai");
    expect(row.metadata.path).toBe("/pipeline/shoots?view=mine");
    expect(row.metadata.pid).toBeNull();
    expect(istCallLabel(call)).toBe("Tue 3 Nov, 4:30 pm IST");

    const edit = await request(app).patch(`/v1/pipeline/shoots/${s.id}`).set(auth(desk.token))
      .send({ base: s.rev, changes: { cameraId: camB.id } });
    expect(edit.status).toBe(200);
    expect(await rows(camA.id, "shoot")).toEqual([]);
    expect(await rows(camB.id, "shoot")).toHaveLength(1);

    // A camera person who assigns a shoot to themself is not notified.
    await request(app).post("/v1/pipeline/shoots").set(auth(camA.token))
      .send({ title: "Self", callTime: call.toISOString(), cameraId: camA.id });
    expect(await rows(camA.id, "shoot")).toEqual([]);
  });
});
