/**
 * pipeline/uploads.test.ts — file uploads to Cloudflare R2 for Pipeline versions (2026-11-02).
 *
 * The rules locked here:
 *   - the signer matches AWS's own worked example (Signature V4, query-string form);
 *   - with R2 not configured, uploads are off (the work view says so, the routes answer 503);
 *   - an upload ticket is a signed PUT under pipeline/<projectId>/, with the content type signed;
 *   - a version takes an uploaded file only after the API has checked what R2 actually holds:
 *     it must exist, belong to this project, have an allowed type and fit the size limit;
 *   - one file backs one version; a download link names the file.
 * R2 is faked behind a stubbed fetch (only requests to the fake endpoint are intercepted).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { pipelineWork as W } from "@dashmani/shared";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { presignQuery, presignR2 } from "../../src/services/storage/r2";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const P = "/v1/pipeline/projects";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function hrUser(name: string) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-") });
  return { ...u, token: hrToken(u.id) };
}

async function newProject(token: string, title = "Reel: premiere") {
  const r = await request(app).post(P).set(auth(token)).send({ clientId: crypto.randomUUID(), title });
  expect(r.status).toBe(201);
  return r.body.data.card.id as string;
}

describe("Signature V4 (pure)", () => {
  it("matches AWS's worked example for a pre-signed GET", () => {
    const q = presignQuery({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      date: new Date("2013-05-24T00:00:00Z"),
      expiresSec: 86400,
    });
    expect(q).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("signs the content type of a PUT, so the client must send exactly that type", () => {
    const url = presignR2(
      { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "k", secretAccessKey: "s" },
      "PUT",
      "pipeline/x/y",
      3600,
      { headers: { "content-type": "video/mp4" } },
    );
    expect(url.startsWith("https://acct.r2.cloudflarestorage.com/b/pipeline/x/y?")).toBe(true);
    expect(url).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
  });
});

describe("pipeline file uploads (API)", () => {
  const stored = new Map<string, { size: number; type: string }>();
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
      expect(init?.method).toBe("HEAD");
      expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      const key = decodeURIComponent(u.pathname.replace(/^\/media\//, ""));
      const obj = stored.get(key);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { "content-length": String(obj.size), "content-type": obj.type } });
    });
  }

  beforeEach(async () => {
    stored.clear();
    resetPipelineStateForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  async function ticket(token: string, id: string, body: Record<string, unknown>) {
    return request(app).post(`${P}/${id}/uploads`).set(auth(token)).send(body);
  }

  it("is off without R2: the work view says so and the routes answer 503", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "");
    vi.stubEnv("R2_ENDPOINT", "");
    const a = await hrUser("Ravi Editor");
    const id = await newProject(a.token);
    const work = await request(app).get(`${P}/${id}/work`).set(auth(a.token));
    expect(work.body.data.uploads).toBe(false);
    const t = await ticket(a.token, id, { kind: "video", fileName: "cut.mp4", contentType: "video/mp4", size: 1000 });
    expect(t.status).toBe(503);
    expect(t.body.error.code).toBe("UPLOADS_OFF");
  });

  it("issues a signed PUT under the project's own prefix, and refuses wrong types and sizes", async () => {
    useR2();
    const a = await hrUser("Ravi Editor");
    const id = await newProject(a.token);
    expect((await request(app).get(`${P}/${id}/work`).set(auth(a.token))).body.data.uploads).toBe(true);

    const t = await ticket(a.token, id, { kind: "video", fileName: "cut.mp4", contentType: "video/mp4", size: 1000 });
    expect(t.status).toBe(201);
    const tk = t.body.data as W.PipelineUploadTicket;
    expect(tk.key).toMatch(W.PIPELINE_FILE_KEY_RE);
    expect(tk.key.startsWith(`pipeline/${id}/`)).toBe(true);
    expect(tk.method).toBe("PUT");
    expect(tk.headers["Content-Type"]).toBe("video/mp4");
    expect(tk.url).toContain(`http://r2.test/media/${tk.key}?`);

    const wrongType = await ticket(a.token, id, { kind: "video", fileName: "x.pdf", contentType: "application/pdf", size: 10 });
    expect(wrongType.status).toBe(400);
    const tooBig = await ticket(a.token, id, { kind: "thumbnail", fileName: "x.png", contentType: "image/png", size: 51 * 1024 * 1024 });
    expect(tooBig.status).toBe(400);
    const caption = await ticket(a.token, id, { kind: "caption", fileName: "c.txt", contentType: "text/plain", size: 10 });
    expect(caption.status).toBe(400);
  });

  it("adds a version only for a file R2 really holds, of an allowed type and size", async () => {
    useR2();
    const a = await hrUser("Ravi Editor");
    const id = await newProject(a.token);
    const key = (await ticket(a.token, id, { kind: "video", fileName: "cut.mp4", contentType: "video/mp4", size: 1000 })).body.data.key;
    const add = (body: Record<string, unknown>) => request(app).post(`${P}/${id}/versions`).set(auth(a.token)).send(body);

    // Not uploaded yet.
    let r = await add({ kind: "video", fileKey: key, fileName: "cut.mp4" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("UPLOAD_NOT_FOUND");

    // Stored, but as a type a video may not be.
    stored.set(key, { size: 1000, type: "application/pdf" });
    r = await add({ kind: "video", fileKey: key, fileName: "cut.mp4" });
    expect(r.body.error.code).toBe("UPLOAD_WRONG_TYPE");

    // Bigger than a thumbnail may be.
    stored.set(key, { size: 60 * 1024 * 1024, type: "image/png" });
    r = await add({ kind: "thumbnail", fileKey: key, fileName: "t.png" });
    expect(r.body.error.code).toBe("UPLOAD_TOO_LARGE");

    // A link and a file at once is refused by validation.
    r = await add({ kind: "video", fileKey: key, url: "https://drive.example/cut" });
    expect(r.status).toBe(400);

    stored.set(key, { size: 123_456_789, type: "video/mp4" });
    r = await add({ kind: "video", fileKey: key, fileName: "Final cut.mp4" });
    expect(r.status).toBe(201);
    const v = r.body.data as W.PipelineVersionDto;
    expect(v.url).toBeNull();
    expect(v.file).toEqual({ name: "Final cut.mp4", size: 123_456_789, type: "video/mp4" });

    // One file backs one version.
    r = await add({ kind: "video", fileKey: key, fileName: "again.mp4" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("FILE_ALREADY_USED");

    // A key from another project is refused before R2 is asked.
    const other = await newProject(a.token, "Another");
    r = await request(app).post(`${P}/${other}/versions`).set(auth(a.token)).send({ kind: "video", fileKey: key });
    expect(r.body.error.code).toBe("UPLOAD_NOT_FOUND");

    // The download link names the file; a link version has no file.
    const f = await request(app).get(`/v1/pipeline/versions/${v.id}/file?download=1`).set(auth(a.token));
    expect(f.status).toBe(200);
    const url = new URL(f.body.data.url);
    expect(url.pathname).toBe(`/media/${key}`);
    expect(url.searchParams.get("response-content-disposition")).toContain('attachment; filename="Final cut.mp4"');
    expect(url.searchParams.get("response-content-type")).toBe("video/mp4");

    const linkVersion = await add({ kind: "thumbnail", url: "https://drive.example/thumb" });
    const nf = await request(app).get(`/v1/pipeline/versions/${linkVersion.body.data.id}/file`).set(auth(a.token));
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("NO_FILE");
  });
});
