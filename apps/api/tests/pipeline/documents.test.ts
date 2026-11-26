/**
 * pipeline/documents.test.ts — project documents (2026-11-20): pitch deck, brief, quote, report.
 *
 * The rules locked here:
 *   - a document lives on the project, not in the chat: deleting a message never touches one;
 *   - a document is a link OR an uploaded file, never both, never neither; links are http(s) only;
 *   - a status change stamps who and when; other edits don't move that stamp; edits carry the
 *     rev they read (409 DOCUMENT_CONFLICT with the current row);
 *   - a draft can be deleted by anyone; a sent one only by the project owner or an admin;
 *   - an uploaded file is checked against what R2 holds, and one file backs one row across
 *     documents and versions;
 *   - the nightly upload sweep keeps a file a document points at.
 * R2 is faked behind a stubbed fetch, like uploads.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "@dashmani/db";
import { pipelineDocs as D } from "@dashmani/shared";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { sweepOrphanUploads, UPLOAD_SWEEP_CURSOR_KEY } from "../../src/services/pipeline/jobs";
import { isMissingDocsSchema } from "../../src/services/pipeline/documents.service";
import { notificationSnippet, splitFileTokens, withFileTokens } from "@dashmani/shared";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const B = "/v1/pipeline";
const P = `${B}/projects`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PDF = "application/pdf";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

async function hrUser(name: string, roleNames?: string[]) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-"), roleNames });
  return { ...u, token: hrToken(u.id) };
}

async function newProject(token: string, title = "Diwali campaign") {
  const r = await request(app).post(P).set(auth(token)).send({ clientId: crypto.randomUUID(), title });
  expect(r.status).toBe(201);
  return r.body.data.card.id as string;
}

const addDoc = (token: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`${P}/${id}/documents`).set(auth(token)).send(body);
const listDocs = async (token: string, id: string) => {
  const r = await request(app).get(`${P}/${id}/documents`).set(auth(token));
  expect(r.status).toBe(200);
  return r.body.data as D.PipelineDocsDto;
};
const editDoc = (token: string, docId: string, body: Record<string, unknown>) =>
  request(app).patch(`${B}/documents/${docId}`).set(auth(token)).send(body);
const delDoc = (token: string, docId: string) => request(app).delete(`${B}/documents/${docId}`).set(auth(token));

const pitch = { type: "pitch", title: "Diwali pitch v1", url: "https://docs.google.com/presentation/d/abc" };

// ⚠️ Called INSIDE each describe: a file-level beforeEach would run before tests/setup.ts
// truncates the tables, and the seeded phases would be wiped (PHASE_NOT_FOUND).
async function freshPipeline() {
  resetPipelineStateForTests();
  await clearPipelineSettings();
  await seedPipelinePhases();
  await setPipelineSetting("pipeline.mode", "on");
}

afterAll(async () => {
  await clearPipelineSettings();
  resetPipelineStateForTests();
  await pipelineDb.$disconnect();
});

describe("project documents (links)", () => {
  beforeEach(freshPipeline);

  it("adds a link document as a draft, stamped with who added it, and lists newest first", async () => {
    const asha = await hrUser("Asha Docs");
    const id = await newProject(asha.token);
    const r = await addDoc(asha.token, id, pitch);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      type: "pitch",
      title: "Diwali pitch v1",
      url: pitch.url,
      file: null,
      status: "draft",
      statusChangedBy: { id: asha.id, name: "Asha Docs" },
      createdBy: { id: asha.id },
      rev: 1,
    });
    await addDoc(asha.token, id, { type: "brief", title: "Client brief", url: "https://drive.google.com/x" });
    const list = await listDocs(asha.token, id);
    expect(list.documents.map((d) => d.title)).toEqual(["Client brief", "Diwali pitch v1"]);
    expect(list.uploads).toBe(false);
  });

  it("needs exactly one of a link or a file, and only http(s) links", async () => {
    const asha = await hrUser("Asha Valid");
    const id = await newProject(asha.token);
    expect((await addDoc(asha.token, id, { type: "pitch", title: "x" })).status).toBe(400);
    expect((await addDoc(asha.token, id, { ...pitch, url: "javascript:alert(1)" })).status).toBe(400);
    expect((await addDoc(asha.token, id, { ...pitch, title: "" })).status).toBe(400);
    expect((await addDoc(asha.token, id, { ...pitch, type: "invoice" })).status).toBe(400);
    const both = await addDoc(asha.token, id, { ...pitch, fileKey: `pipeline/${id}/${"a".repeat(32)}` });
    expect(both.status).toBe(400);
  });

  it("survives the chat: deleting the message that shared the pitch leaves the document", async () => {
    const asha = await hrUser("Asha Chat");
    const id = await newProject(asha.token);
    const doc = (await addDoc(asha.token, id, pitch)).body.data as D.PipelineDocDto;
    const msg = await request(app).post(`${P}/${id}/messages`).set(auth(asha.token)).send({ clientId: crypto.randomUUID(), body: `Pitch: ${pitch.url}` });
    expect(msg.status).toBe(201);
    expect((await request(app).delete(`${B}/messages/${msg.body.data.message.id}`).set(auth(asha.token))).status).toBe(200);
    const list = await listDocs(asha.token, id);
    expect(list.documents.map((d) => d.id)).toEqual([doc.id]);
    expect(list.documents[0].url).toBe(pitch.url);
  });

  it("stamps a status change with who and when; other edits keep the stamp; a stale rev is refused", async () => {
    const asha = await hrUser("Asha Status");
    const ravi = await hrUser("Ravi Status");
    const id = await newProject(asha.token);
    const doc = (await addDoc(asha.token, id, pitch)).body.data as D.PipelineDocDto;

    const sent = await editDoc(ravi.token, doc.id, { base: 1, changes: { status: "sent" } });
    expect(sent.status).toBe(200);
    expect(sent.body.data).toMatchObject({ status: "sent", rev: 2, statusChangedBy: { id: ravi.id } });
    const sentAt = sent.body.data.statusChangedAt as string;
    expect(Date.parse(sentAt)).toBeGreaterThanOrEqual(Date.parse(doc.statusChangedAt));

    const renamed = await editDoc(asha.token, doc.id, { base: 2, changes: { title: "Diwali pitch (final)", note: "Client wants revised rates" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ title: "Diwali pitch (final)", note: "Client wants revised rates", status: "sent", rev: 3 });
    expect(renamed.body.data.statusChangedAt).toBe(sentAt);
    expect(renamed.body.data.statusChangedBy.id).toBe(ravi.id);

    const stale = await editDoc(ravi.token, doc.id, { base: 2, changes: { status: "accepted" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("DOCUMENT_CONFLICT");
    expect(stale.body.error.details?.current?.rev ?? stale.body.error.current?.rev).toBe(3);
  });

  it("lets anyone delete a draft, but a sent document only by the project owner or an admin", async () => {
    const owner = await hrUser("Owner Del");
    const other = await hrUser("Other Del");
    const admin = await hrUser("Admin Del", ["Admin"]);
    const id = await newProject(owner.token);

    const draft = (await addDoc(owner.token, id, pitch)).body.data as D.PipelineDocDto;
    expect((await delDoc(other.token, draft.id)).status).toBe(200);

    const a = (await addDoc(owner.token, id, { ...pitch, status: "sent" })).body.data as D.PipelineDocDto;
    const kept = await delDoc(other.token, a.id);
    expect(kept.status).toBe(403);
    expect(kept.body.error.code).toBe("DOCUMENT_KEPT");
    expect((await delDoc(admin.token, a.id)).status).toBe(200);

    const b = (await addDoc(other.token, id, { ...pitch, status: "accepted" })).body.data as D.PipelineDocDto;
    expect((await delDoc(owner.token, b.id)).status).toBe(200);
    expect((await listDocs(owner.token, id)).documents).toEqual([]);
  });

  it("is read-only on an archived project and 404s for a project that doesn't exist", async () => {
    const asha = await hrUser("Asha Archive");
    const id = await newProject(asha.token);
    await request(app).post(`${P}/${id}/archive`).set(auth(asha.token)).send({});
    const r = await addDoc(asha.token, id, pitch);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PROJECT_ARCHIVED");
    expect((await request(app).get(`${P}/${crypto.randomUUID()}/documents`).set(auth(asha.token))).status).toBe(404);
  });

  it("refuses to change the link of an uploaded document", async () => {
    const asha = await hrUser("Asha File");
    const id = await newProject(asha.token);
    const key = `pipeline/${id}/${"f".repeat(32)}`;
    const row = await prisma.pipelineDocument.create({
      data: { projectId: id, type: "pitch", title: "Deck", fileKey: key, fileName: "deck.pdf", fileSize: 10n, fileType: PDF, statusChangedById: asha.id, createdById: asha.id },
    });
    const r = await editDoc(asha.token, row.id, { base: 1, changes: { url: "https://example.com/x" } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("DOCUMENT_IS_FILE");
  });
});

describe("project documents (uploads)", () => {
  const stored = new Map<string, { size: number; type: string; modified?: Date }>();
  const deletedKeys: string[] = [];
  const realFetch = globalThis.fetch;

  function useR2() {
    vi.stubEnv("R2_ACCOUNT_ID", "acct");
    vi.stubEnv("R2_ACCESS_KEY_ID", "key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("R2_BUCKET", "media");
    vi.stubEnv("R2_ENDPOINT", "http://r2.test");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.host !== "r2.test") return realFetch(input, init);
      const method = init?.method ?? "GET";
      if (method === "GET" && u.searchParams.get("list-type") === "2") {
        const prefix = u.searchParams.get("prefix") ?? "";
        const after = u.searchParams.get("start-after") ?? "";
        const all = [...stored.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${all
          .map((k) => `<Contents><Key>${k}</Key><LastModified>${(stored.get(k)!.modified ?? new Date()).toISOString()}</LastModified><Size>${stored.get(k)!.size}</Size></Contents>`)
          .join("")}</ListBucketResult>`;
        return new Response(xml, { status: 200 });
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/media\//, ""));
      if (method === "DELETE") {
        deletedKeys.push(key);
        stored.delete(key);
        return new Response(null, { status: 204 });
      }
      const obj = stored.get(key);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(obj.size), "content-type": obj.type, "last-modified": (obj.modified ?? new Date()).toUTCString() },
      });
    });
  }

  beforeEach(async () => {
    await freshPipeline();
    stored.clear();
    deletedKeys.length = 0;
    await prisma.systemSetting.deleteMany({ where: { key: UPLOAD_SWEEP_CURSOR_KEY } });
    useR2();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const ticket = (token: string, id: string, body: Record<string, unknown>) =>
    request(app).post(`${P}/${id}/document-uploads`).set(auth(token)).send(body);

  it("signs an upload for office files and PDFs only, up to 200 MB", async () => {
    const asha = await hrUser("Asha Ticket");
    const id = await newProject(asha.token);
    const ok = await ticket(asha.token, id, { fileName: "pitch.pptx", contentType: PPTX, size: 5_000_000 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.key).toMatch(new RegExp(`^pipeline/${id}/[A-Za-z0-9_-]{32}$`));
    expect(ok.body.data.headers).toEqual({ "Content-Type": PPTX });
    expect((await ticket(asha.token, id, { fileName: "clip.mp4", contentType: "video/mp4", size: 10 })).status).toBe(400);
    expect((await ticket(asha.token, id, { fileName: "big.pdf", contentType: PDF, size: 201 * 1024 * 1024 })).status).toBe(400);
    expect((await listDocs(asha.token, id)).uploads).toBe(true);
  });

  it("accepts an uploaded file only after checking what R2 holds; one file backs one row", async () => {
    const asha = await hrUser("Asha Upload");
    const id = await newProject(asha.token);
    const key = (await ticket(asha.token, id, { fileName: "pitch.pdf", contentType: PDF, size: 1234 })).body.data.key as string;

    const missing = await addDoc(asha.token, id, { type: "pitch", title: "Deck", fileKey: key, fileName: "pitch.pdf" });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("UPLOAD_NOT_FOUND");

    stored.set(key, { size: 1234, type: "video/mp4" });
    expect((await addDoc(asha.token, id, { type: "pitch", title: "Deck", fileKey: key, fileName: "pitch.pdf" })).body.error.code).toBe("UPLOAD_WRONG_TYPE");

    stored.set(key, { size: 1234, type: PDF });
    const ok = await addDoc(asha.token, id, { type: "pitch", title: "Deck", fileKey: key, fileName: "pitch.pdf" });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ url: null, file: { name: "pitch.pdf", size: 1234, type: PDF } });

    const again = await addDoc(asha.token, id, { type: "report", title: "Copy", fileKey: key, fileName: "pitch.pdf" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("FILE_ALREADY_USED");

    // A file already on a version can't become a document either.
    const vKey = `pipeline/${id}/${"v".repeat(32)}`;
    stored.set(vKey, { size: 10, type: PDF });
    await prisma.pipelineVersion.create({ data: { projectId: id, kind: "other", number: 1, fileKey: vKey, createdById: asha.id } });
    expect((await addDoc(asha.token, id, { type: "report", title: "V", fileKey: vKey })).body.error.code).toBe("FILE_ALREADY_USED");

    const link = await request(app).get(`${B}/documents/${ok.body.data.id}/file?download=1`).set(auth(asha.token));
    expect(link.status).toBe(200);
    expect(decodeURIComponent(link.body.data.url)).toContain('attachment; filename="pitch.pdf"');
  });

  it("refuses another project's upload", async () => {
    const asha = await hrUser("Asha Cross");
    const a = await newProject(asha.token, "A");
    const b = await newProject(asha.token, "B");
    const key = `pipeline/${b}/${"b".repeat(32)}`;
    stored.set(key, { size: 10, type: PDF });
    const r = await addDoc(asha.token, a, { type: "pitch", title: "Deck", fileKey: key });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("UPLOAD_NOT_FOUND");
  });

  it("the nightly sweep keeps a document's file and deletes it once the document is gone", async () => {
    const asha = await hrUser("Asha Sweep");
    const id = await newProject(asha.token);
    const old = new Date(Date.now() - 30 * 3_600_000);
    const docKey = `pipeline/${id}/${"d".repeat(32)}`;
    const abandoned = `pipeline/${id}/${"z".repeat(32)}`;
    stored.set(docKey, { size: 10, type: PDF, modified: old });
    stored.set(abandoned, { size: 10, type: PDF, modified: old });
    const doc = await prisma.pipelineDocument.create({
      data: { projectId: id, type: "pitch", title: "Deck", fileKey: docKey, fileName: "deck.pdf", fileSize: 10n, fileType: PDF, statusChangedById: asha.id, createdById: asha.id },
    });

    expect(await sweepOrphanUploads()).toEqual({ scanned: 2, deleted: 1 });
    expect(deletedKeys).toEqual([abandoned]);
    expect(stored.has(docKey)).toBe(true);

    await prisma.pipelineDocument.delete({ where: { id: doc.id } });
    expect(await sweepOrphanUploads()).toEqual({ scanned: 1, deleted: 1 });
    expect(deletedKeys).toEqual([abandoned, docKey]);
  });

  // ── Chat attachments (📎, 2026-11-23) ───────────────────────────────────────────
  const attachTicket = (token: string, conv: string, body: Record<string, unknown>) =>
    request(app).post(`${P}/${conv}/attachment-uploads`).set(auth(token)).send(body);
  const attach = (token: string, conv: string, body: Record<string, unknown>) =>
    request(app).post(`${P}/${conv}/attachments`).set(auth(token)).send(body);
  const newChannel = async (token: string, body: Record<string, unknown>) => {
    const r = await request(app).post(`${B}/channels`).set(auth(token)).send({ clientId: crypto.randomUUID(), ...body });
    expect(r.status).toBe(201);
    return (r.body.data.id ?? r.body.data.header.id) as string;
  };

  it("files a photo shared in the project chat as a chat document, and the message keeps only its id", async () => {
    const asha = await hrUser("Asha Attach");
    const id = await newProject(asha.token);
    const t = await attachTicket(asha.token, id, { fileName: "shoot.jpg", contentType: "image/jpeg", size: 2048 });
    expect(t.status).toBe(201);
    const key = t.body.data.key as string;
    expect(key.startsWith(`pipeline/${id}/`)).toBe(true);
    stored.set(key, { size: 2048, type: "image/jpeg" });

    const a = await attach(asha.token, id, { fileKey: key, fileName: "shoot.jpg" });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ type: "photo", title: "shoot", source: "chat", conversationId: id, status: "draft", file: { name: "shoot.jpg", type: "image/jpeg" } });
    const docId = a.body.data.id as string;

    const body = withFileTokens("Today's shoot", [docId]);
    const msg = await request(app).post(`${P}/${id}/messages`).set(auth(asha.token)).send({ clientId: crypto.randomUUID(), body });
    expect(msg.status).toBe(201);
    expect(msg.body.data.message.body).toBe(body);

    // The file is in the Documents tab (with its thumbnail link), and one GET serves the chat card.
    const listed = (await listDocs(asha.token, id)).documents;
    expect(listed.map((d) => d.id)).toEqual([docId]);
    expect(listed[0].view?.url).toMatch(/response-content-disposition=inline/);
    const one = await request(app).get(`${B}/documents/${docId}`).set(auth(asha.token));
    expect(one.status).toBe(200);
    expect(one.body.data.title).toBe("shoot");
    // A photo's answer carries its inline preview link, so the card needs no second request.
    expect(one.body.data.view?.url).toContain(encodeURIComponent(key).replace(/%2F/g, "/"));
    expect(one.body.data.view?.url).toMatch(/response-content-disposition=inline/);
    expect(Date.parse(one.body.data.view.expiresAt)).toBeGreaterThan(Date.now());

    // Deleting the message leaves the file in Documents (the owner's rule).
    expect((await request(app).delete(`${B}/messages/${msg.body.data.message.id}`).set(auth(asha.token))).status).toBe(200);
    expect((await listDocs(asha.token, id)).documents.map((d) => d.id)).toEqual([docId]);
  });

  it("a channel made private later hides its earlier files from non-members, not from members", async () => {
    const asha = await hrUser("Asha Priv");
    const ravi = await hrUser("Ravi Priv");
    const pid = await newProject(asha.token, "Priv campaign");
    const ch = await newChannel(asha.token, { name: "shoot-later", projectId: pid });
    const t = await attachTicket(asha.token, ch, { fileName: "set.jpg", contentType: "image/jpeg", size: 50 });
    stored.set(t.body.data.key, { size: 50, type: "image/jpeg" });
    const doc = (await attach(asha.token, ch, { fileKey: t.body.data.key, fileName: "set.jpg" })).body.data;
    // Public: Ravi (not in the channel) sees it, like any project document.
    expect((await listDocs(ravi.token, pid)).documents.map((d) => d.id)).toEqual([doc.id]);

    expect((await request(app).patch(`${B}/channels/${ch}`).set(auth(asha.token)).send({ isPrivate: true })).status).toBe(200);
    expect((await listDocs(ravi.token, pid)).documents).toEqual([]);
    expect((await request(app).get(`${B}/documents/${doc.id}`).set(auth(ravi.token))).status).toBe(404);
    expect((await request(app).get(`${B}/documents/${doc.id}/file`).set(auth(ravi.token))).status).toBe(404);
    expect((await request(app).patch(`${B}/documents/${doc.id}`).set(auth(ravi.token)).send({ base: doc.rev, changes: { title: "x" } })).status).toBe(404);
    // A member still has it.
    expect((await listDocs(asha.token, pid)).documents.map((d) => d.id)).toEqual([doc.id]);
    expect((await request(app).get(`${B}/documents/${doc.id}`).set(auth(asha.token))).status).toBe(200);
  });

  it("a DM someone isn't in answers 404, like one that doesn't exist", async () => {
    const asha = await hrUser("Asha Dm");
    const ravi = await hrUser("Ravi Dm");
    const meera = await hrUser("Meera Dm");
    const dm = await request(app).post(`${B}/dms`).set(auth(asha.token)).send({ userId: ravi.id });
    expect(dm.status).toBeLessThan(300);
    const dmId = (dm.body.data.id ?? dm.body.data.header?.id) as string;
    const r = await attachTicket(meera.token, dmId, { fileName: "x.pdf", contentType: PDF, size: 1 });
    expect(r.status).toBe(404);
    expect((await attachTicket(asha.token, dmId, { fileName: "x.pdf", contentType: PDF, size: 1 })).body.error.code).toBe("ATTACH_NOT_HERE");
  });

  it("signs the declared size, so storage refuses a bigger (or smaller) upload", async () => {
    const asha = await hrUser("Asha Size");
    const id = await newProject(asha.token);
    const t = await request(app).post(`${P}/${id}/document-uploads`).set(auth(asha.token)).send({ fileName: "d.pdf", contentType: PDF, size: 1234 });
    expect(t.status).toBe(201);
    const u = new URL(t.body.data.url);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    // The client is never told to send Content-Length: the browser sets it from the file.
    expect(Object.keys(t.body.data.headers).map((k) => k.toLowerCase())).toEqual(["content-type"]);

    process.env.PIPELINE_UPLOAD_SIGN_LENGTH = "0"; // the kill switch
    try {
      const off = await request(app).post(`${P}/${id}/document-uploads`).set(auth(asha.token)).send({ fileName: "d.pdf", contentType: PDF, size: 1234 });
      expect(new URL(off.body.data.url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    } finally {
      delete process.env.PIPELINE_UPLOAD_SIGN_LENGTH;
    }
  });

  it("chat files have their own cap: a chat full of photos never blocks a Documents-tab document", async () => {
    const asha = await hrUser("Asha Cap");
    const id = await newProject(asha.token);
    const n = D.PIPELINE_DOC_LIMITS.perProject;
    await prisma.pipelineDocument.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        projectId: id, type: "photo", title: `p${i}`, fileKey: `pipeline/${id}/${String(i).padStart(32, "c")}`,
        fileName: `p${i}.jpg`, fileSize: 1n, fileType: "image/jpeg", source: "chat", conversationId: id,
        statusChangedById: asha.id, createdById: asha.id,
      })),
    });
    const deck = await request(app).post(`${P}/${id}/documents`).set(auth(asha.token)).send({ type: "pitch", title: "Deck", url: "https://example.com/d" });
    expect(deck.status).toBe(201);
    // …and the deck is listed even though it is the 101st document.
    expect((await listDocs(asha.token, id)).documents.some((d) => d.id === deck.body.data.id)).toBe(true);
  });

  it("files a campaign channel's attachment under the campaign; refuses private and team-wide channels and non-members", async () => {
    const asha = await hrUser("Asha Chan");
    const ravi = await hrUser("Ravi Chan");
    const pid = await newProject(asha.token, "Jio Campaign");
    const pub = await newChannel(asha.token, { name: "shoot-day", projectId: pid });
    const priv = await newChannel(asha.token, { name: "client-approvals", projectId: pid, isPrivate: true });
    const team = await newChannel(asha.token, { name: "social-team" });

    const t = await attachTicket(asha.token, pub, { fileName: "brief.pdf", contentType: PDF, size: 100 });
    expect(t.status).toBe(201);
    const key = t.body.data.key as string;
    expect(key.startsWith(`pipeline/${pid}/`)).toBe(true); // the campaign's prefix, not the channel's
    stored.set(key, { size: 100, type: PDF });
    const a = await attach(asha.token, pub, { fileKey: key, fileName: "brief.pdf" });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ type: "other", source: "chat", conversationId: pub });
    expect((await listDocs(asha.token, pid)).documents.map((d) => d.id)).toEqual([a.body.data.id]);

    const p = await attachTicket(asha.token, priv, { fileName: "x.pdf", contentType: PDF, size: 1 });
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe("ATTACH_PRIVATE");
    expect((await attachTicket(ravi.token, priv, { fileName: "x.pdf", contentType: PDF, size: 1 })).status).toBe(404);
    const w = await attachTicket(asha.token, team, { fileName: "x.pdf", contentType: PDF, size: 1 });
    expect(w.status).toBe(409);
    expect(w.body.error.code).toBe("ATTACH_NOT_HERE");
    const nm = await attachTicket(ravi.token, pub, { fileName: "x.pdf", contentType: PDF, size: 1 });
    expect(nm.status).toBe(403);
    expect(nm.body.error.code).toBe("NOT_A_MEMBER");
  });
});

describe("documents: missing table", () => {
  it("recognises a missing pipeline_documents table in any wrapping, and nothing else", () => {
    const prismaErr = { code: "P2021", message: "The table `public.pipeline_documents` does not exist in the current database." };
    expect(isMissingDocsSchema(prismaErr)).toBe(true);
    expect(isMissingDocsSchema({ code: "X", message: "wrapped", original: prismaErr })).toBe(true);
    expect(isMissingDocsSchema({ code: "P2021", message: "The table `public.pipeline_versions` does not exist" })).toBe(false);
    expect(isMissingDocsSchema(new Error("boom"))).toBe(false);
  });
});

describe("scripts/pipeline-docs-ddl.sql (static)", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../../../../scripts/pipeline-docs-ddl.sql"), "utf8");
  const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  it("is one guarded, additive, re-runnable transaction with no FK into users", () => {
    expect(body).toMatch(/^BEGIN;/m);
    expect(body).toMatch(/^COMMIT;/m);
    expect(body).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(body).not.toMatch(/DROP|REFERENCES "users"/);
    // The only change to pipeline_projects: three nullable / constant-default columns.
    const alters = body.match(/ALTER TABLE "pipeline_projects"[^;]*;/g) ?? [];
    expect(alters).toHaveLength(3);
    for (const a of alters) expect(a).toMatch(/ADD COLUMN IF NOT EXISTS "status_note(_at|_by_id)?"/);
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS "pipeline_documents"/);
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_documents_file_key_key"/);
    expect(body).toMatch(/conname = 'pipeline_documents_project_id_fkey'/);
  });
});

describe("document names on screen (pure)", () => {
  const at = "2026-11-24T10:00:00.000Z";
  it("keeps a real title and turns a letterless one into the type and day", () => {
    expect(D.docDisplayTitle({ title: "Diwali pitch v2", type: "pitch", createdAt: at })).toBe("Diwali pitch v2");
    expect(D.docDisplayTitle({ title: "IMG_2041", type: "photo", createdAt: at })).toBe("IMG_2041");
    expect(D.docDisplayTitle({ title: "_ (2)", type: "photo", createdAt: at })).toBe("Photo · 24 Nov");
    expect(D.docDisplayTitle({ title: "_", type: "report", createdAt: at })).toBe("Report · 24 Nov");
  });
  it("splits chat drafts from the project's documents", () => {
    expect(D.isChatDraft({ source: "chat", status: "draft" })).toBe(true);
    expect(D.isChatDraft({ source: "chat", status: "sent" })).toBe(false);
    expect(D.isChatDraft({ source: "tab", status: "draft" })).toBe(false);
  });
});

describe("chat file tokens (pure)", () => {
  const a = "11111111-2222-3333-4444-555555555555";
  const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("round-trips the text and the file ids; a message without files is untouched", () => {
    expect(splitFileTokens("hello")).toEqual({ text: "hello", ids: [] });
    const body = withFileTokens("Pitch attached ", [a, b]);
    expect(body).toBe(`Pitch attached\n#{file:${a}}\n#{file:${b}}`);
    expect(splitFileTokens(body)).toEqual({ text: "Pitch attached", ids: [a, b] });
    expect(splitFileTokens(withFileTokens("", [a]))).toEqual({ text: "", ids: [a] });
  });

  it("keeps a malformed token as text and drops duplicates", () => {
    expect(splitFileTokens("#{file:not-a-uuid}").ids).toEqual([]);
    expect(splitFileTokens(`#{file:${a}}\n#{file:${a}}`).ids).toEqual([a]);
  });

  it("says '📎 1 file' in notification text instead of the raw token", () => {
    const names = new Map<string, string>();
    expect(notificationSnippet(withFileTokens("See this", [a]), names, 100)).toBe("See this 📎 1 file");
    expect(notificationSnippet(withFileTokens("", [a, b]), names, 100)).toBe("📎 2 files");
    expect(notificationSnippet("plain", names, 100)).toBe("plain");
  });

  it("is linear on a long run of near-tokens", () => {
    const evil = "#{file:".repeat(50_000);
    const t0 = Date.now();
    expect(splitFileTokens(evil).ids).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
