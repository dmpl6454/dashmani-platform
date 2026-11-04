/**
 * pipeline/conversations.test.ts — sales-portal chat: Slack-style channels and DMs
 * (conversations.service.ts, scripts/pipeline-chat-ddl.sql).
 *
 * Locks: create / browse / join / leave / add / remove / rename / public ↔ private by the
 * Slack rules; a private channel or DM is invisible to non-members on EVERY read path
 * (detail, history, replies, sync, post, react); a mention never grants access; and no
 * channel or DM ever reaches a project surface (board, archived list, workload, my-work).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { getBoardSnapshot } from "../../src/services/pipeline/board";
import { purgeDeletedProjects } from "../../src/services/pipeline/jobs";
import { onlineUserIds, resetPresenceForTests, touchPresence, PRESENCE_WINDOW_MS } from "../../src/services/pipeline/live";
import { dmKeyOf } from "../../src/services/pipeline/conversations.service";
import { pipelineValidators as V } from "@dashmani/shared";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const B = "/v1/pipeline";
const uuid = () => crypto.randomUUID();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function person(name: string, roleNames?: string[]) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-"), roleNames });
  return { ...u, token: hrToken(u.id) };
}

async function newChannel(token: string, body: Record<string, unknown>) {
  return request(app).post(`${B}/channels`).set(auth(token)).send({ clientId: uuid(), ...body });
}

async function post(token: string, id: string, body: string) {
  return request(app).post(`${B}/projects/${id}/messages`).set(auth(token)).send({ clientId: uuid(), body });
}

describe("pipeline chat: channels and DMs", () => {
  beforeEach(async () => {
    resetPipelineStateForTests();
    resetPresenceForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
  });

  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  it("slugs channel names the Slack way", () => {
    expect(V.slugifyChannelName("Social Team!")).toBe("social-team");
    expect(V.slugifyChannelName("  --Hello   World--  ")).toBe("hello-world");
    expect(V.slugifyChannelName("q4_launch")).toBe("q4_launch");
    expect(V.createChannelSchema.safeParse({ clientId: uuid(), name: "!!!" }).success).toBe(false);
  });

  it("creates a public channel: owner + members, sidebar, browse, duplicate name refused", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const r = await newChannel(asha.token, { name: "Social Team", description: "All things social", memberIds: [ravi.id] });
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    expect(r.body.data.header).toMatchObject({ title: "social-team", kind: "channel", isPrivate: false, ownerId: asha.id, memberCount: 2 });
    expect(r.body.data.participants.map((p: { userId: string }) => p.userId).sort()).toEqual([asha.id, ravi.id].sort());

    const side = await request(app).get(`${B}/conversations`).set(auth(ravi.token));
    expect(side.status).toBe(200);
    expect(side.body.data.channels).toEqual([expect.objectContaining({ id, name: "social-team", isPrivate: false, unread: 0, ownerId: asha.id })]);

    const dup = await newChannel(ravi.token, { name: "SOCIAL team" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CHANNEL_NAME_TAKEN");

    // Idempotent create: the same clientId returns the same channel (200).
    const key = uuid();
    const a = await request(app).post(`${B}/channels`).set(auth(asha.token)).send({ clientId: key, name: "launch" });
    const b = await request(app).post(`${B}/channels`).set(auth(asha.token)).send({ clientId: key, name: "launch" });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.data.id).toBe(a.body.data.id);
  });

  it("public channel: anyone browses and joins; only members post; leave works", async () => {
    const asha = await person("Asha Rao");
    const meera = await person("Meera Das");
    const id = (await newChannel(asha.token, { name: "general" })).body.data.id as string;

    const br = await request(app).get(`${B}/channels/browse`).set(auth(meera.token));
    expect(br.body.data.channels).toEqual([expect.objectContaining({ id, name: "general", joined: false, memberCount: 1 })]);

    // Readable before joining (like Slack's preview), but posting needs a join.
    expect((await request(app).get(`${B}/projects/${id}`).set(auth(meera.token))).status).toBe(200);
    const early = await post(meera.token, id, "hi");
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe("NOT_A_MEMBER");

    const j = await request(app).post(`${B}/channels/${id}/join`).set(auth(meera.token));
    expect(j.status).toBe(200);
    expect(j.body.data.header.memberCount).toBe(2);
    expect((await post(meera.token, id, "hello all")).status).toBe(201);

    const unread = await request(app).get(`${B}/conversations`).set(auth(asha.token));
    expect(unread.body.data.channels[0].unread).toBe(1);

    const l = await request(app).post(`${B}/channels/${id}/leave`).set(auth(meera.token));
    expect(l.status).toBe(200);
    expect((await request(app).get(`${B}/conversations`).set(auth(meera.token))).body.data.channels).toEqual([]);
  });

  it("private channel and DM are invisible to outsiders on every read and write path", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const out = await person("Outsider Kumar");
    const priv = (await newChannel(asha.token, { name: "leadership", isPrivate: true, memberIds: [ravi.id] })).body.data.id as string;
    const dm = (await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: ravi.id })).body.data.id as string;

    for (const id of [priv, dm]) {
      const m = await post(asha.token, id, "secret plan");
      expect(m.status).toBe(201);
      const mid = m.body.data.message.id as string;

      expect((await request(app).get(`${B}/projects/${id}`).set(auth(out.token))).status).toBe(404);
      expect((await request(app).get(`${B}/projects/${id}/messages`).set(auth(out.token))).status).toBe(404);
      expect((await request(app).get(`${B}/messages/${mid}/replies`).set(auth(out.token))).status).toBe(404);
      expect((await post(out.token, id, "let me in")).status).toBe(404);
      expect((await request(app).put(`${B}/messages/${mid}/reactions/thumbs_up`).set(auth(out.token)).send({ on: true })).status).toBe(404);
      expect((await request(app).post(`${B}/channels/${id}/join`).set(auth(out.token))).status).toBe(404);

      const s = await request(app).post(`${B}/sync`).set(auth(out.token)).send({ clientBuild: 1, project: { id, rev: 0, hv: 0 } });
      expect(s.status).toBe(200);
      expect(s.body.data.project).toMatchObject({ status: "deleted", messages: [], header: null });

      // The member sees it all.
      const ok = await request(app).post(`${B}/sync`).set(auth(ravi.token)).send({ clientBuild: 1, project: { id, rev: 0, hv: 0 } });
      expect(ok.body.data.project.status).toBe("ok");
      expect(ok.body.data.project.messages.map((x: { body: string }) => x.body)).toEqual(["secret plan"]);
    }

    const br = await request(app).get(`${B}/channels/browse`).set(auth(out.token));
    expect(br.body.data.channels).toEqual([]);
  });

  it("a mention in a private channel neither notifies nor adds a non-member", async () => {
    const asha = await person("Asha Rao");
    const out = await person("Outsider Kumar");
    const id = (await newChannel(asha.token, { name: "hush", isPrivate: true })).body.data.id as string;
    const m = await post(asha.token, id, `ping @{${out.id}}`);
    expect(m.status).toBe(201);
    expect(m.body.data.notified).toEqual([]);
    expect(m.body.data.notNotified).toEqual([{ id: out.id, reason: "not_member" }]);
    expect(await prisma.pipelineParticipant.count({ where: { projectId: id, userId: out.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: out.id } })).toBe(0);
    expect((await request(app).get(`${B}/projects/${id}`).set(auth(out.token))).status).toBe(404);
  });

  it("membership rules: members add, only owner/admin remove, rename and change privacy", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const meera = await person("Meera Das");
    const admin = await person("Admin Person", ["Admin"]);
    const id = (await newChannel(asha.token, { name: "design", memberIds: [ravi.id] })).body.data.id as string;

    const add = await request(app).post(`${B}/channels/${id}/members`).set(auth(ravi.token)).send({ userIds: [meera.id] });
    expect(add.status).toBe(200);
    expect(add.body.data.header.memberCount).toBe(3);

    const rm = await request(app).delete(`${B}/channels/${id}/members/${meera.id}`).set(auth(ravi.token));
    expect(rm.status).toBe(403);
    expect(rm.body.error.code).toBe("NOT_ALLOWED");
    expect((await request(app).patch(`${B}/channels/${id}`).set(auth(ravi.token)).send({ isPrivate: true })).status).toBe(403);
    expect((await request(app).patch(`${B}/channels/${id}`).set(auth(ravi.token)).send({ name: "x" })).status).toBe(403);

    const owner = await request(app).delete(`${B}/channels/${id}/members/${meera.id}`).set(auth(asha.token));
    expect(owner.status).toBe(200);
    expect(owner.body.data.header.memberCount).toBe(2);

    const flip = await request(app).patch(`${B}/channels/${id}`).set(auth(admin.token)).send({ isPrivate: true, name: "Design Crew" });
    expect(flip.status).toBe(200);
    expect(flip.body.data.header).toMatchObject({ isPrivate: true, title: "design-crew" });
    // Now private: Meera (removed) can't see it any more.
    expect((await request(app).get(`${B}/projects/${id}`).set(auth(meera.token))).status).toBe(404);

    expect((await request(app).delete(`${B}/channels/${id}/members/${asha.id}`).set(auth(admin.token))).body.error.code).toBe("CANT_REMOVE_OWNER");
  });

  it("DMs: one per pair (either side opens the same one), the self-DM, fixed members", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const a = await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: ravi.id });
    const b = await request(app).post(`${B}/dms`).set(auth(ravi.token)).send({ userId: asha.id });
    expect(a.status).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(a.body.data.header).toMatchObject({ kind: "dm", isPrivate: true, memberCount: 2 });
    const id = a.body.data.id as string;
    expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id } })).dmKey).toBe(dmKeyOf(asha.id, ravi.id));

    const self = await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: asha.id });
    expect(self.body.data.header.memberCount).toBe(1);

    await post(ravi.token, id, "hey");
    const side = await request(app).get(`${B}/conversations`).set(auth(asha.token));
    expect(side.body.data.dms[0]).toMatchObject({ isSelf: true, userId: asha.id });
    expect(side.body.data.dms[1]).toMatchObject({ id, userId: ravi.id, isSelf: false, unread: 1 });

    expect((await request(app).post(`${B}/channels/${id}/members`).set(auth(asha.token)).send({ userIds: [uuid()] })).status).toBe(409);
    expect((await request(app).post(`${B}/channels/${id}/leave`).set(auth(asha.token))).body.error.code).toBe("CANT_LEAVE_DM");
    // A DM message writes no bell row (the bells link to the HR portal, which has no chat).
    expect(await prisma.notification.count({ where: { userId: asha.id } })).toBe(0);
  });

  it("channels and DMs never reach a project surface", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const proj = await request(app).post(`${B}/projects`).set(auth(asha.token)).send({ clientId: uuid(), title: "Real project" });
    expect(proj.status).toBe(201);
    const ch = (await newChannel(asha.token, { name: "random" })).body.data.id as string;
    const dm = (await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: ravi.id })).body.data.id as string;

    const v = (await prisma.pipelineBoardState.findUniqueOrThrow({ where: { id: 1 } })).seq;
    const snap = await getBoardSnapshot(v);
    expect(snap.cards.map((c) => c.id)).toEqual([proj.body.data.card.id]);

    // Project-only writes refuse a channel (lockProject filters kind = 'project').
    expect((await request(app).patch(`${B}/projects/${ch}`).set(auth(asha.token)).send({ changes: { title: "x" }, base: { title: "random" } })).status).toBe(404);
    expect((await request(app).post(`${B}/projects/${ch}/move`).set(auth(asha.token)).send({ toPhaseId: proj.body.data.card.phaseId, basePhaseId: proj.body.data.card.phaseId, afterId: null })).status).toBe(404);

    const wl = await request(app).get(`${B}/workload`).set(auth(asha.token));
    expect(wl.status).toBe(200);
    const mine = (wl.body.data.people ?? wl.body.data).find?.((p: { userId: string }) => p.userId === asha.id);
    if (mine && "projects" in mine) expect(mine.projects).toBe(1);

    for (const id of [ch, dm]) {
      expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id } })).kind).not.toBe("project");
    }
  });

  it("campaign channels: live in the campaign's sidebar, public ones start with the campaign's members", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const meera = await person("Meera Das");
    const proj = await request(app).post(`${B}/projects`).set(auth(asha.token)).send({ clientId: uuid(), title: "Jio Campaign", memberIds: [ravi.id] });
    expect(proj.status).toBe(201);
    const pid = proj.body.data.card.id as string;

    const pub = await newChannel(asha.token, { name: "shoot-day", projectId: pid });
    expect(pub.status).toBe(201);
    expect(pub.body.data.header).toMatchObject({ parentProjectId: pid, parentTitle: "Jio Campaign", memberCount: 2 });
    const priv = await newChannel(asha.token, { name: "client-approvals", projectId: pid, isPrivate: true });
    expect(priv.body.data.header.memberCount).toBe(1);

    // The same name is fine in another campaign or team-wide, not twice in one campaign.
    expect((await newChannel(asha.token, { name: "shoot-day" })).status).toBe(201);
    expect((await newChannel(ravi.token, { name: "Shoot Day", projectId: pid })).body.error.code).toBe("CHANNEL_NAME_TAKEN");

    const ravis = await request(app).get(`${B}/projects/${pid}/channels`).set(auth(ravi.token));
    expect(ravis.status).toBe(200);
    expect(ravis.body.data.channels.map((c: { name: string; joined: boolean }) => [c.name, c.joined])).toEqual([["shoot-day", true]]);
    const meeras = await request(app).get(`${B}/projects/${pid}/channels`).set(auth(meera.token));
    expect(meeras.body.data.channels).toEqual([expect.objectContaining({ name: "shoot-day", joined: false, unread: 0 })]);

    // Not in the main sidebar or the team-wide browse.
    const side = await request(app).get(`${B}/conversations`).set(auth(ravi.token));
    expect(side.body.data.channels).toEqual([]);
    expect(side.body.data.campaignChannelIds).toEqual([pub.body.data.id]);
    const br = await request(app).get(`${B}/channels/browse`).set(auth(meera.token));
    expect(br.body.data.channels.map((c: { name: string }) => c.name)).toEqual(["shoot-day"]);
    expect(br.body.data.channels[0].id).not.toBe(pub.body.data.id);

    // An archived campaign takes no new channels; an unknown one is a 404.
    expect((await newChannel(asha.token, { name: "x", projectId: uuid() })).status).toBe(404);
    await request(app).post(`${B}/projects/${pid}/archive`).set(auth(asha.token)).send({});
    expect((await newChannel(asha.token, { name: "late", projectId: pid })).body.error.code).toBe("PROJECT_ARCHIVED");
  });

  it("delete a channel: owner or admin only, typed name confirms, gone everywhere, name free again", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const proj = await request(app).post(`${B}/projects`).set(auth(asha.token)).send({ clientId: uuid(), title: "Jio Campaign", memberIds: [ravi.id] });
    const pid = proj.body.data.card.id as string;
    const id = (await newChannel(asha.token, { name: "shoot-day", projectId: pid })).body.data.id as string;
    await post(ravi.token, id, "call time 9am");

    const notOwner = await request(app).delete(`${B}/channels/${id}`).set(auth(ravi.token)).send({ confirmName: "shoot-day" });
    expect(notOwner.body.error.code).toBe("NOT_ALLOWED");
    const wrong = await request(app).delete(`${B}/channels/${id}`).set(auth(asha.token)).send({ confirmName: "shoot" });
    expect(wrong.body.error.code).toBe("CONFIRM_MISMATCH");
    const ok = await request(app).delete(`${B}/channels/${id}`).set(auth(asha.token)).send({ confirmName: "#Shoot-Day" });
    expect(ok.status).toBe(200);

    expect((await request(app).get(`${B}/projects/${pid}/channels`).set(auth(ravi.token))).body.data.channels).toEqual([]);
    expect((await request(app).get(`${B}/conversations`).set(auth(ravi.token))).body.data.campaignChannelIds).toEqual([]);
    expect((await request(app).get(`${B}/projects/${id}`).set(auth(ravi.token))).status).toBe(404);
    expect((await post(ravi.token, id, "still there?")).status).toBe(404);
    const s = await request(app).post(`${B}/sync`).set(auth(ravi.token)).send({ clientBuild: 1, project: { id, rev: 0, hv: 0 } });
    expect(s.body.data.project.status).toBe("deleted");
    expect((await newChannel(asha.token, { name: "shoot-day", projectId: pid })).status).toBe(201);

    const dm = (await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: ravi.id })).body.data.id as string;
    expect((await request(app).delete(`${B}/channels/${dm}`).set(auth(asha.token)).send({ confirmName: "x" })).body.error.code).toBe("CANT_DELETE_DM");
  });

  it("review fixes: owner can't leave, non-members can't react, a campaign's channels go (and come back) with it, purge chunks them", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const meera = await person("Meera Das");
    const proj = await request(app).post(`${B}/projects`).set(auth(asha.token)).send({ clientId: uuid(), title: "Jio Campaign", memberIds: [ravi.id] });
    const pid = proj.body.data.card.id as string;
    const id = (await newChannel(asha.token, { name: "shoot-day", projectId: pid })).body.data.id as string;

    // The owner can't walk away (by leave or by removing themself); others still can.
    expect((await request(app).post(`${B}/channels/${id}/leave`).set(auth(asha.token))).body.error.code).toBe("OWNER_CANT_LEAVE");
    expect((await request(app).delete(`${B}/channels/${id}/members/${asha.id}`).set(auth(asha.token))).body.error.code).toBe("OWNER_CANT_LEAVE");

    // Reacting in a channel needs membership, like posting (public channels are still readable).
    const mid = (await post(ravi.token, id, "call time 9am")).body.data.message.id as string;
    const r = await request(app).put(`${B}/messages/${mid}/reactions/thumbs_up`).set(auth(meera.token)).send({ on: true });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("NOT_A_MEMBER");
    expect((await request(app).put(`${B}/messages/${mid}/reactions/thumbs_up`).set(auth(asha.token)).send({ on: true })).status).toBe(200);

    // Deleting the campaign takes its channels with it on every path …
    expect((await request(app).delete(`${B}/projects/${pid}`).set(auth(asha.token)).send({ confirmTitle: "Jio Campaign" })).status).toBe(200);
    expect((await request(app).get(`${B}/projects/${id}`).set(auth(ravi.token))).status).toBe(404);
    expect((await post(ravi.token, id, "still there?")).status).toBe(404);
    expect((await request(app).post(`${B}/channels/${id}/join`).set(auth(meera.token))).status).toBe(404);
    const s = await request(app).post(`${B}/sync`).set(auth(ravi.token)).send({ clientBuild: 1, project: { id, rev: 0, hv: 0 } });
    expect(s.body.data.project.status).toBe("deleted");

    // … restoring it brings them back.
    expect((await request(app).post(`${B}/projects/${pid}/restore`).set(auth(asha.token)).send({})).status).toBe(200);
    expect((await request(app).get(`${B}/projects/${id}`).set(auth(ravi.token))).status).toBe(200);

    // Purge: the campaign's channel messages are deleted in the chunked phases, then the rows.
    await request(app).delete(`${B}/projects/${pid}`).set(auth(asha.token)).send({ confirmTitle: "Jio Campaign" });
    await pipelineDb.$executeRaw`UPDATE pipeline_projects SET deleted_at = deleted_at - interval '31 days' WHERE id = ${pid}`;
    const chunks: Array<{ phase: string; rows: number }> = [];
    expect(await purgeDeletedProjects({ onChunk: (c) => chunks.push(c) })).toEqual({ purged: 1 });
    // The campaign's own thread is empty, so the one root deleted in a chunk is the channel's.
    expect(chunks.filter((c) => c.phase === "roots").reduce((n, c) => n + c.rows, 0)).toBe(1);
    expect(await pipelineDb.pipelineProject.findUnique({ where: { id } })).toBeNull();
    expect(await pipelineDb.pipelineMessage.count({ where: { projectId: id } })).toBe(0);
  });

  it("deleting a DM hides it from my list only; a new message or reopening brings it back", async () => {
    const asha = await person("Asha Rao");
    const ravi = await person("Ravi Jain");
    const id = (await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: ravi.id })).body.data.id as string;
    await post(ravi.token, id, "hello");

    expect((await request(app).post(`${B}/dms/${id}/hide`).set(auth(asha.token))).status).toBe(200);
    let side = (await request(app).get(`${B}/conversations`).set(auth(asha.token))).body.data;
    expect(side.dms).toEqual([]);
    expect(side.hiddenDmIds).toEqual([id]);
    // Ravi still has it, with its history.
    expect((await request(app).get(`${B}/conversations`).set(auth(ravi.token))).body.data.dms.map((d: { id: string }) => d.id)).toEqual([id]);
    expect((await request(app).get(`${B}/projects/${id}/messages`).set(auth(ravi.token))).body.data.messages).toHaveLength(1);

    await post(ravi.token, id, "are you there?");
    side = (await request(app).get(`${B}/conversations`).set(auth(asha.token))).body.data;
    expect(side.dms).toEqual([expect.objectContaining({ id, unread: 1 })]);

    await request(app).post(`${B}/dms/${id}/hide`).set(auth(asha.token));
    await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: ravi.id });
    expect((await request(app).get(`${B}/conversations`).set(auth(asha.token))).body.data.dms.map((d: { id: string }) => d.id)).toEqual([id]);

    const ch = (await newChannel(asha.token, { name: "not-a-dm" })).body.data.id as string;
    expect((await request(app).post(`${B}/dms/${ch}/hide`).set(auth(asha.token))).body.error.code).toBe("NOT_A_DM");
  });

  it("presence: seen within a minute is online, then it ages out", () => {
    const t = 1_000_000;
    touchPresence("u1", t);
    touchPresence("u2", t - PRESENCE_WINDOW_MS - 1);
    expect(onlineUserIds(t)).toEqual(["u1"]);
    expect(onlineUserIds(t + PRESENCE_WINDOW_MS + 1)).toEqual([]);
  });

  it("GET /presence lists the caller once they hit any gated route", async () => {
    const asha = await person("Asha Rao");
    const r = await request(app).get(`${B}/presence`).set(auth(asha.token));
    expect(r.status).toBe(200);
    expect(r.body.data.online).toContain(asha.id);
  });
});

describe("scripts/pipeline-chat-ddl.sql (static)", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../../../../scripts/pipeline-chat-ddl.sql"), "utf8");
  it("is one guarded, additive, re-runnable transaction", () => {
    expect(sql).toMatch(/BEGIN;[\s\S]*SET LOCAL lock_timeout = '3s';[\s\S]*COMMIT;/);
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "kind" VARCHAR(8) NOT NULL DEFAULT 'project'`);
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "is_private" BOOLEAN NOT NULL DEFAULT false`);
    expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "dm_key" TEXT`);
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_projects_dm_key_key"`);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });
});
