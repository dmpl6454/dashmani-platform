/**
 * pipeline/work.test.ts — work tracking on a Pipeline project (2026-11-02):
 * versions, version-bound reviews, one publishing record per page, and My Work.
 *
 * The rules locked here:
 *   - versions are numbered per (project, kind);
 *   - a review is pinned to the newest version of every kind, and a newer version makes it
 *     OUTDATED: it can no longer be decided, and an earlier approval stops counting;
 *   - a page can be scheduled or published only under the CURRENT approval (when the project
 *     has versions), and records which approval that was;
 *   - publishing one page never completes another; a published page needs its live link and
 *     can't be deleted;
 *   - My Work lists exactly what waits on the person.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "@dashmani/db";
import { pipelineWork as W } from "@dashmani/shared";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
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

const addVersion = (token: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`${P}/${id}/versions`).set(auth(token)).send(body);

const work = async (token: string, id: string) => {
  const r = await request(app).get(`${P}/${id}/work`).set(auth(token));
  expect(r.status).toBe(200);
  return r.body.data as W.PipelineWorkDto;
};

describe("approval logic (pure)", () => {
  const v = (id: string, kind: string, number: number) => ({ id, kind, number });
  const r = (id: string, status: string, versionIds: string[], createdAt: string) => ({ id, status, versionIds, createdAt });

  it("takes the newest version of each kind", () => {
    expect(W.latestVersionIds([v("a", "video", 1), v("b", "video", 2), v("c", "caption", 1)])).toEqual(["b", "c"]);
  });

  it("is approved only while the approval covers the newest version of every kind", () => {
    const versions = [v("a", "video", 1), v("c", "caption", 1)];
    const ok = r("r1", "approved", ["a", "c"], "2026-11-01T10:00:00Z");
    expect(W.approvalSummary(versions, [ok])).toEqual({ state: "approved", approvedReviewId: "r1", reviewId: "r1" });
    // A new video, or a first thumbnail, makes it outdated.
    expect(W.approvalSummary([...versions, v("b", "video", 2)], [ok]).state).toBe("outdated");
    expect(W.approvalSummary([...versions, v("t", "thumbnail", 1)], [ok]).approvedReviewId).toBeNull();
  });

  it("reads the newest non-superseded review", () => {
    const versions = [v("a", "video", 1)];
    expect(W.approvalSummary(versions, [])).toEqual({ state: "none", approvedReviewId: null, reviewId: null });
    expect(
      W.approvalSummary(versions, [
        r("old", "approved", ["a"], "2026-11-01T10:00:00Z"),
        r("new", "changes_requested", ["a"], "2026-11-01T11:00:00Z"),
      ]).state,
    ).toBe("changes_requested");
    expect(
      W.approvalSummary(versions, [
        r("old", "approved", ["a"], "2026-11-01T10:00:00Z"),
        r("gone", "superseded", ["a"], "2026-11-01T11:00:00Z"),
      ]).approvedReviewId,
    ).toBe("old");
  });

  it("rejects unsafe links and requires a file link or caption text", () => {
    expect(W.addVersionSchema.safeParse({ kind: "video", url: "javascript:alert(1)" }).success).toBe(false);
    expect(W.addVersionSchema.safeParse({ kind: "video" }).success).toBe(false);
    expect(W.addVersionSchema.safeParse({ kind: "caption", body: "Out now" }).success).toBe(true);
    expect(W.addVersionSchema.safeParse({ kind: "video", url: "https://nas.example/clip.mp4" }).success).toBe(true);
    expect(W.decideReviewSchema.safeParse({ decision: "changes_requested" }).success).toBe(false);
  });
});

describe("pipeline work tracking (API)", () => {
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

  it("numbers versions per kind", async () => {
    const editor = await hrUser("Ravi Editor");
    const id = await newProject(editor.token);
    expect((await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v1.mp4" })).body.data.number).toBe(1);
    expect((await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v2.mp4" })).body.data.number).toBe(2);
    expect((await addVersion(editor.token, id, { kind: "caption", body: "Premiere tonight" })).body.data.number).toBe(1);
    const bad = await addVersion(editor.token, id, { kind: "video", url: "ftp://x" });
    expect(bad.status).toBe(400);
    const w = await work(editor.token, id);
    expect(w.versions.map((x) => `${x.kind}${x.number}`)).toEqual(["caption1", "video2", "video1"]);
    expect(w.approval.state).toBe("none");
  });

  it("pins a review to the newest versions; a new version makes it outdated and undecidable", async () => {
    const editor = await hrUser("Sana Editor");
    const lead = await hrUser("Kabir Lead");
    const id = await newProject(editor.token);

    const noVersions = await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: lead.id });
    expect(noVersions.status).toBe(409);
    expect(noVersions.body.error.code).toBe("NO_VERSIONS");

    const v1 = (await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v1.mp4" })).body.data.id;
    const self = await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: editor.id });
    expect(self.body.error.code).toBe("SELF_REVIEW");

    const req = await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: lead.id });
    expect(req.status).toBe(201);
    expect(req.body.data.versionIds).toEqual([v1]);
    const rid = req.body.data.id as string;

    // The request posted a thread line mentioning the reviewer.
    const msg = await prisma.pipelineMessage.findFirst({ where: { projectId: id }, orderBy: { seq: "desc" } });
    expect(msg?.body).toContain(`@{${lead.id}}`);
    expect(msg?.mentionIds).toContain(lead.id);

    // Only the reviewer may decide.
    const notMe = await request(app).post(`/v1/pipeline/reviews/${rid}/decision`).set(auth(editor.token)).send({ decision: "approved" });
    expect(notMe.status).toBe(403);

    // A new version arrives: the review is outdated and can't be approved.
    await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v2.mp4" });
    const late = await request(app).post(`/v1/pipeline/reviews/${rid}/decision`).set(auth(lead.token)).send({ decision: "approved" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("REVIEW_OUTDATED");
    const w = await work(editor.token, id);
    expect(w.approval.state).toBe("outdated");
    expect(w.reviews[0].outdated).toBe(true);
  });

  it("a new request replaces a pending one; approval holds until a newer version", async () => {
    const editor = await hrUser("Meera Editor");
    const lead = await hrUser("Arjun Lead");
    const id = await newProject(editor.token);
    await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v1.mp4" });
    const first = (await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: lead.id })).body.data.id;
    const second = (await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: lead.id })).body.data.id;
    expect((await prisma.pipelineReview.findUniqueOrThrow({ where: { id: first } })).status).toBe("superseded");

    const changes = await request(app).post(`/v1/pipeline/reviews/${second}/decision`).set(auth(lead.token))
      .send({ decision: "changes_requested", note: "Trim the intro" });
    expect(changes.status).toBe(200);
    expect((await work(editor.token, id)).approval.state).toBe("changes_requested");

    // My Work: the editor sees the changes; once a new request is made it drops out.
    let mine = (await request(app).get("/v1/pipeline/my-work").set(auth(editor.token))).body.data as W.PipelineMyWorkDto;
    expect(mine.changesRequested.map((x) => x.review.id)).toEqual([second]);

    await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v2.mp4" });
    const third = (await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: lead.id })).body.data.id;
    mine = (await request(app).get("/v1/pipeline/my-work").set(auth(editor.token))).body.data;
    expect(mine.changesRequested).toEqual([]);
    const leadWork = (await request(app).get("/v1/pipeline/my-work").set(auth(lead.token))).body.data as W.PipelineMyWorkDto;
    expect(leadWork.reviewsToDo.map((x) => x.review.id)).toEqual([third]);

    const ok = await request(app).post(`/v1/pipeline/reviews/${third}/decision`).set(auth(lead.token)).send({ decision: "approved" });
    expect(ok.status).toBe(200);
    const w = await work(editor.token, id);
    expect(w.approval).toEqual({ state: "approved", approvedReviewId: third, reviewId: third });

    const again = await request(app).post(`/v1/pipeline/reviews/${third}/decision`).set(auth(lead.token)).send({ decision: "approved" });
    expect(again.body.error.code).toBe("REVIEW_CLOSED");
  });

  it("schedules and publishes each page on its own, only under the current approval", async () => {
    const editor = await hrUser("Isha Editor");
    const lead = await hrUser("Dev Lead");
    const pub = await hrUser("Tara Publisher");
    const id = await newProject(editor.token);
    await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v1.mp4" });

    const mk = (destination: string, platform: string) =>
      request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token)).send({ platform, destination, assigneeId: pub.id });
    const ig = (await mk("@paparazzi", "instagram")).body.data as W.PipelineDeliverableDto;
    const fb = (await mk("Paparazzi Page", "facebook")).body.data as W.PipelineDeliverableDto;
    expect(ig.status).toBe("draft");

    const patch = (d: { id: string }, base: number, changes: Record<string, unknown>, token = pub.token) =>
      request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(token)).send({ base, changes });

    // Not approved yet → refused.
    const blocked = await patch(ig, 1, { status: "published", liveUrl: "https://instagram.com/reel/abc" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("APPROVAL_REQUIRED");

    const rid = (await request(app).post(`${P}/${id}/reviews`).set(auth(editor.token)).send({ reviewerId: lead.id })).body.data.id;
    await request(app).post(`/v1/pipeline/reviews/${rid}/decision`).set(auth(lead.token)).send({ decision: "approved" });

    // Published needs a live link; scheduled needs a time.
    expect((await patch(ig, 1, { status: "published" })).body.error.code).toBe("LIVE_URL_REQUIRED");
    expect((await patch(fb, 1, { status: "scheduled" })).body.error.code).toBe("SCHEDULE_REQUIRED");

    const live = await patch(ig, 1, { status: "published", liveUrl: "https://instagram.com/reel/abc" });
    expect(live.status).toBe(200);
    expect(live.body.data).toMatchObject({ status: "published", approvedReviewId: rid, rev: 2, publishedBy: { id: pub.id } });

    // The other page is untouched.
    const other = await prisma.pipelineDeliverable.findUniqueOrThrow({ where: { id: fb.id } });
    expect(other.status).toBe("draft");

    // A stale rev is a conflict carrying the current row.
    const stale = await patch(ig, 1, { note: "late edit" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("DELIVERABLE_CONFLICT");

    // A new version voids the approval: the next page can't be scheduled until it's re-approved.
    await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v2.mp4" });
    const later = await patch(fb, 1, { status: "scheduled", scheduledAt: "2026-11-05T12:30:00.000Z" });
    expect(later.body.error.code).toBe("APPROVAL_REQUIRED");

    // A published page is a record: it can't be deleted; a draft can.
    expect((await request(app).delete(`/v1/pipeline/deliverables/${ig.id}`).set(auth(editor.token))).status).toBe(409);
    expect((await request(app).delete(`/v1/pipeline/deliverables/${fb.id}`).set(auth(editor.token))).status).toBe(200);

    // My Work for the publisher: the published page is done; nothing else is assigned.
    const mine = (await request(app).get("/v1/pipeline/my-work").set(auth(pub.token))).body.data as W.PipelineMyWorkDto;
    expect(mine.deliverables).toEqual([]);
  });

  it("lets a page go live without approval when the project tracks no versions", async () => {
    const editor = await hrUser("Nikhil Editor");
    const id = await newProject(editor.token);
    const d = (await request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token))
      .send({ platform: "youtube", destination: "Movified" })).body.data;
    const r = await request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(editor.token))
      .send({ base: 1, changes: { status: "published", liveUrl: "https://youtu.be/abcdefghijk" } });
    expect(r.status).toBe(200);
    expect(r.body.data.approvedReviewId).toBeNull();
  });

  it("refuses work on an archived project and unknown people", async () => {
    const editor = await hrUser("Zoya Editor");
    const id = await newProject(editor.token);
    const ghost = await request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token))
      .send({ platform: "instagram", destination: "x", assigneeId: uuid() });
    expect(ghost.body.error.code).toBe("USER_NOT_PICKABLE");
    await request(app).post(`${P}/${id}/archive`).set(auth(editor.token)).send({});
    const r = await addVersion(editor.token, id, { kind: "video", url: "https://nas.example/v1.mp4" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PROJECT_ARCHIVED");
  });

  it("My Work lists my live projects with a due date, soonest first", async () => {
    const owner = await hrUser("Ritu Owner");
    const a = await newProject(owner.token, "Later");
    const b = await newProject(owner.token, "Sooner");
    await prisma.pipelineProject.update({ where: { id: a }, data: { dueDate: new Date("2026-12-10") } });
    await prisma.pipelineProject.update({ where: { id: b }, data: { dueDate: new Date("2026-11-20") } });
    await newProject(owner.token, "No date");
    const mine = (await request(app).get("/v1/pipeline/my-work").set(auth(owner.token))).body.data as W.PipelineMyWorkDto;
    expect(mine.dueProjects.map((p) => [p.title, p.dueDate])).toEqual([["Sooner", "2026-11-20"], ["Later", "2026-12-10"]]);
  });
});

describe("scripts/pipeline-work-ddl.sql (static)", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../../../../scripts/pipeline-work-ddl.sql"), "utf8");
  const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("is one guarded, additive, re-runnable transaction with no FK into users", () => {
    expect(body).toMatch(/^BEGIN;/m);
    expect(body).toMatch(/^COMMIT;/m);
    expect(body).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(body).not.toMatch(/DROP|ALTER TABLE "(users|notifications|pipeline_projects)"/);
    expect(body).not.toMatch(/REFERENCES "users"/);
    for (const t of ["pipeline_versions", "pipeline_reviews", "pipeline_deliverables"]) {
      expect(body).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"`));
      expect(body).toMatch(new RegExp(`conname = '${t}_project_id_fkey'`));
    }
  });
});
