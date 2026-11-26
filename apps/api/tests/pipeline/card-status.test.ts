/**
 * pipeline/card-status.test.ts — the board card's status line (2026-11-23).
 *
 * The rules locked here:
 *   - the board snapshot's card carries a summary: the "current status" note, the newest
 *     non-draft document move, the newest live review, pages live / total;
 *   - a document, review, page or note change bumps the board, so a board holding the old v gets
 *     the new card on its next tick;
 *   - the note is one cleaned line ≤ 140, stamped with who and when; "" clears it; it rides in
 *     the project header too;
 *   - cardStatusParts words it with at most two parts, most important first.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { cardStatusParts, overdueDays, type PipelineCard, type PipelineCardSummary } from "@dashmani/shared";
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

async function newProject(token: string, title = "Diwali campaign") {
  const r = await request(app).post(P).set(auth(token)).send({ clientId: crypto.randomUUID(), title });
  expect(r.status).toBe(201);
  return r.body.data.card.id as string;
}

/** The board as a client holding `v` sees it: null when unchanged. */
async function board(token: string, v: number) {
  const r = await request(app).post(`${B}/sync`).set(auth(token)).send({ clientBuild: 1, board: { v } });
  expect(r.status).toBe(200);
  return r.body.data as { v: number; board: { cards: PipelineCard[] } | null };
}

const cardOf = async (token: string, id: string) => {
  const b = await board(token, -1);
  return b.board!.cards.find((c) => c.id === id)!;
};

describe("card status line (API)", () => {
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

  it("an empty project's card has an empty summary", async () => {
    const asha = await hrUser("Asha Empty");
    const id = await newProject(asha.token);
    expect((await cardOf(asha.token, id)).summary).toEqual({ note: null, doc: null, review: null, pages: null, files: 0 });
  });

  it("sets, cleans and clears the note; the header and the board card carry it", async () => {
    const asha = await hrUser("Asha Note");
    const ravi = await hrUser("Ravi Note");
    const id = await newProject(asha.token);
    const before = await board(asha.token, -1);

    const r = await request(app).put(`${P}/${id}/status-note`).set(auth(ravi.token)).send({ text: "  Client wants\nrevised rates  " });
    expect(r.status).toBe(200);
    expect(r.body.data.statusNote).toMatchObject({ byId: ravi.id });
    expect(r.body.data.statusNote.text).not.toMatch(/\n/);
    const text = r.body.data.statusNote.text as string;

    // The board moved on, and the card shows the note.
    const after = await board(asha.token, before.v);
    expect(after.board).not.toBeNull();
    expect(after.board!.cards.find((c) => c.id === id)!.summary!.note).toMatchObject({ text, byId: ravi.id });

    const detail = await request(app).get(`${P}/${id}`).set(auth(asha.token));
    expect(detail.body.data.header.statusNote).toMatchObject({ text, byId: ravi.id });

    // Same text again: nothing changes, the board stays put.
    const v = (await board(asha.token, -1)).v;
    await request(app).put(`${P}/${id}/status-note`).set(auth(asha.token)).send({ text });
    expect((await board(asha.token, v)).board).toBeNull();

    expect((await request(app).put(`${P}/${id}/status-note`).set(auth(asha.token)).send({ text: "x".repeat(141) })).status).toBe(400);
    const cleared = await request(app).put(`${P}/${id}/status-note`).set(auth(asha.token)).send({ text: "" });
    expect(cleared.body.data.statusNote).toBeNull();
    expect((await cardOf(asha.token, id)).summary!.note).toBeNull();
  });

  it("shows the newest non-draft document move, and a document change bumps the board", async () => {
    const asha = await hrUser("Asha Doc");
    const id = await newProject(asha.token);
    const draft = await request(app).post(`${P}/${id}/documents`).set(auth(asha.token)).send({ type: "pitch", title: "Pitch", url: "https://example.com/p" });
    expect((await cardOf(asha.token, id)).summary!.doc).toBeNull(); // drafts don't count

    const v = (await board(asha.token, -1)).v;
    const sent = await request(app).patch(`${B}/documents/${draft.body.data.id}`).set(auth(asha.token)).send({ base: 1, changes: { status: "sent" } });
    expect(sent.status).toBe(200);
    const after = await board(asha.token, v);
    expect(after.board).not.toBeNull();
    expect(after.board!.cards.find((c) => c.id === id)!.summary!.doc).toMatchObject({ type: "pitch", status: "sent" });
  });

  it("counts pages live / total (cancelled ones don't count) and shows a pending review", async () => {
    const asha = await hrUser("Asha Pages");
    const ravi = await hrUser("Ravi Pages");
    const id = await newProject(asha.token);
    const add = (destination: string) => request(app).post(`${P}/${id}/deliverables`).set(auth(asha.token)).send({ platform: "instagram", destination });
    const a = (await add("@one")).body.data;
    await add("@two");
    const c = (await add("@three")).body.data;
    await request(app).patch(`${B}/deliverables/${a.id}`).set(auth(asha.token)).send({ base: a.rev, changes: { status: "published", liveUrl: "https://instagram.com/p/x" } });
    await request(app).patch(`${B}/deliverables/${c.id}`).set(auth(asha.token)).send({ base: c.rev, changes: { status: "cancelled" } });
    expect((await cardOf(asha.token, id)).summary!.pages).toEqual({ live: 1, total: 2 });

    await request(app).post(`${P}/${id}/versions`).set(auth(asha.token)).send({ kind: "video", url: "https://example.com/v1" });
    const v = (await board(asha.token, -1)).v;
    expect((await request(app).post(`${P}/${id}/reviews`).set(auth(asha.token)).send({ reviewerId: ravi.id })).status).toBe(201);
    const after = await board(asha.token, v);
    expect(after.board!.cards.find((x) => x.id === id)!.summary!.review).toBe("pending");
  });

  it("a moved, unarchived or restored card comes back WITH its summary (the client replaces the card)", async () => {
    const asha = await hrUser("Asha Move");
    const id = await newProject(asha.token);
    await request(app).put(`${P}/${id}/status-note`).set(auth(asha.token)).send({ text: "Waiting on rates" });
    const from = (await prisma.pipelineProject.findUniqueOrThrow({ where: { id } })).phaseId;
    const to = (await prisma.pipelinePhase.findFirstOrThrow({ where: { key: "planning" } })).id;

    const moved = await request(app).post(`${P}/${id}/move`).set(auth(asha.token)).send({ toPhaseId: to, basePhaseId: from, afterId: null });
    expect(moved.status).toBe(200);
    expect(moved.body.data.card.summary?.note).toMatchObject({ text: "Waiting on rates" });

    await request(app).post(`${P}/${id}/archive`).set(auth(asha.token)).send({});
    const back = await request(app).post(`${P}/${id}/unarchive`).set(auth(asha.token)).send({});
    expect(back.status).toBe(200);
    expect(back.body.data.card.summary?.note).toMatchObject({ text: "Waiting on rates" });

    await request(app).delete(`${P}/${id}`).set(auth(asha.token));
    const restored = await request(app).post(`${P}/${id}/restore`).set(auth(asha.token)).send({});
    expect(restored.status).toBe(200);
    expect(restored.body.data.card.summary?.note).toMatchObject({ text: "Waiting on rates" });
  });

  it("edits that can't change the card leave every board as it is", async () => {
    const asha = await hrUser("Asha Quiet");
    const id = await newProject(asha.token);
    // A draft document: adding or deleting it changes the card's file count, renaming it doesn't.
    const draft = (await request(app).post(`${P}/${id}/documents`).set(auth(asha.token)).send({ type: "pitch", title: "Pitch", url: "https://example.com/p" })).body.data;
    expect((await cardOf(asha.token, id)).summary!.files).toBe(1);
    let v = (await board(asha.token, -1)).v;
    expect((await request(app).patch(`${B}/documents/${draft.id}`).set(auth(asha.token)).send({ base: draft.rev, changes: { title: "Pitch v2" } })).status).toBe(200);
    expect((await board(asha.token, v)).board).toBeNull();
    expect((await request(app).delete(`${B}/documents/${draft.id}`).set(auth(asha.token))).status).toBe(200);
    const afterDelete = await board(asha.token, v);
    expect(afterDelete.board).not.toBeNull();
    expect(afterDelete.board!.cards.find((c) => c.id === id)!.summary!.files).toBe(0);

    // A page: a caption edit doesn't move "n/m pages live"; a status change does.
    const page = (await request(app).post(`${P}/${id}/deliverables`).set(auth(asha.token)).send({ platform: "instagram", destination: "@one" })).body.data;
    v = (await board(asha.token, -1)).v;
    const cap = await request(app).patch(`${B}/deliverables/${page.id}`).set(auth(asha.token)).send({ base: page.rev, changes: { caption: "New caption" } });
    expect(cap.status).toBe(200);
    expect((await board(asha.token, v)).board).toBeNull();
    const cancelled = await request(app).patch(`${B}/deliverables/${page.id}`).set(auth(asha.token)).send({ base: cap.body.data.rev, changes: { status: "cancelled" } });
    expect(cancelled.status).toBe(200);
    expect((await board(asha.token, v)).board).not.toBeNull();
  });
});

describe("card status line (pure)", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const base: PipelineCardSummary = { note: null, doc: null, review: null, pages: null, files: 0 };

  it("a card with only files says how many; files never push out a more important part", () => {
    expect(cardStatusParts({ ...base, files: 1 }, now)).toEqual([{ text: "📎 1 file", tone: "muted" }]);
    expect(cardStatusParts({ ...base, files: 3 }, now)).toEqual([{ text: "📎 3 files", tone: "muted" }]);
    expect(cardStatusParts({ ...base, files: 3, review: "pending", pages: { live: 1, total: 2 } }, now).map((p) => p.text)).toEqual([
      "Waiting for review",
      "1/2 pages live",
    ]);
  });

  it("words the parts, most important first, at most two", () => {
    expect(cardStatusParts(base, now)).toEqual([]);
    expect(cardStatusParts({ ...base, doc: { type: "pitch", status: "sent", at: "2026-11-21T12:00:00.000Z" } }, now)).toEqual([
      { text: "Pitch sent 2d ago", tone: "info" },
    ]);
    const all = cardStatusParts(
      { ...base, review: "changes_requested", doc: { type: "quote", status: "accepted", at: "2026-11-23T11:00:00.000Z" }, pages: { live: 3, total: 5 } },
      now,
    );
    expect(all).toEqual([
      { text: "Changes requested", tone: "danger" },
      { text: "Quote accepted 1h ago", tone: "success" },
    ]);
    expect(cardStatusParts({ ...base, pages: { live: 2, total: 2 }, review: "approved" }, now)).toEqual([
      { text: "2/2 pages live", tone: "success" },
      { text: "Approved", tone: "success" },
    ]);
    expect(cardStatusParts(undefined, now)).toEqual([]);
  });

  it("counts whole overdue days", () => {
    expect(overdueDays("2026-11-21", "2026-11-23")).toBe(2);
    expect(overdueDays("2026-11-23", "2026-11-23")).toBe(0);
    expect(overdueDays(null, "2026-11-23")).toBe(0);
    expect(overdueDays("garbage", "2026-11-23")).toBe(0);
  });
});
