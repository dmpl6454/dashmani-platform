/**
 * Shared helpers for the pipeline concurrency suite (not a test file).
 *
 * Requests go to ONE listening server over real sockets (native fetch), so parallel
 * requests genuinely overlap in the event loop and in the pipeline pool (3 connections).
 */
import type { Server } from "http";
import type { AddressInfo } from "net";
import { randomUUID } from "crypto";
import app from "../../src/app";
import { prisma } from "@dashmani/db";
import { hrToken, createPipelineUser, seedPipelinePhases, setPipelineSetting, clearPipelineSettings } from "../../tests/pipeline/pipeline-helpers";
import { resetPipelineStateForTests } from "../../src/services/pipeline";

export { randomUUID, prisma, createPipelineUser };

let server: Server | null = null;
let base = "";

export async function startServer(): Promise<void> {
  if (server) return;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

export interface Res<T = any> {
  status: number;
  body: { success: boolean; data?: T; error?: { code?: string; message?: string } };
}

export async function call<T = any>(method: string, path: string, userId: string, body?: unknown): Promise<Res<T>> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${hrToken(userId)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { success: false, error: { message: text.slice(0, 200) } };
  }
  return { status: r.status, body: parsed };
}

/** Fresh phases + mode on. Call from a nested beforeEach (setup.ts TRUNCATEs at root). */
export async function freshPipeline(): Promise<void> {
  resetPipelineStateForTests();
  await clearPipelineSettings();
  await seedPipelinePhases();
  await setPipelineSetting("pipeline.mode", "on");
}

export async function users(n: number, tag: string) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await createPipelineUser({ name: `${tag} ${i}`, tag: `${tag}${i}` }));
  return out;
}

export async function createProject(ownerId: string, title: string, memberIds: string[] = [], phaseId?: string) {
  const r = await call("POST", "/pipeline/projects", ownerId, { clientId: randomUUID(), title, memberIds, phaseId });
  if (r.status !== 201 && r.status !== 200) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.card as { id: string; phaseId: string; rank: string };
}

export async function phases() {
  return prisma.pipelinePhase.findMany({ orderBy: { position: "asc" } });
}

export function statusCounts(rs: Array<{ status: number }>): Record<number, number> {
  const c: Record<number, number> = {};
  for (const r of rs) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
