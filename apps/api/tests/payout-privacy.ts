/**
 * Shared instruments for the creator-payout PRIVACY tests (not a test file: nothing here runs on its own).
 *
 * The payout rule is that a creator's PAN, bank account number, IFSC, name and address are never stored,
 * logged, emailed or returned. Two instruments prove it, and both are only worth anything if they can SEE
 * a leak, so each has a positive control in payout-privacy.test.ts that plants a value and proves it is found:
 *
 *   scanDatabase(needles)  which tables hold any needle in any column (the row's text, case-insensitive).
 *   captureConsole()       everything written to console.*, rendered the way node prints it PLUS every
 *                          Error's message, stack and own properties.
 *
 * ⚠️ WHY captureConsole RENDERS ERRORS ITSELF. A plain JSON.stringify(error) drops `message` and `stack`
 * (they are non-enumerable), so a spy built on it never sees the text of an Error passed to console.error(e):
 * exactly the shape of a lazy debugging edit that would put a provider's description into the pm2 log. The
 * "never logs a body" assertions then pass vacuously. This one cannot be blind to that.
 *
 * Before this module the scan and the spy were copied into three test files, so a fix to one never reached
 * the others.
 */
import { format } from "util";
import { vi } from "vitest";
import { prisma } from "@dashmani/db";

/**
 * Every table, every column (as the row's text): which tables hold any needle. Throws when it finds almost no
 * tables, because a scan that looks at the wrong schema would match nothing and pass every test.
 */
export async function scanDatabase(needles: string[]): Promise<string[]> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  if (tables.length < 20) throw new Error(`scanDatabase found only ${tables.length} tables: it is looking at the wrong schema, so every scan would pass`);
  const patterns = needles.map((x) => `%${x}%`);
  const hits: string[] = [];
  for (const { table_name } of tables) {
    const marks = patterns.map((_, i) => `$${i + 1}`).join(",");
    const rows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(`SELECT count(*)::int AS c FROM "${table_name}" t WHERE t::text ILIKE ANY (ARRAY[${marks}])`, ...patterns);
    if (rows[0].c > 0) hits.push(table_name);
  }
  return hits.sort();
}

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/**
 * One console call as text: what node itself would print (util.format: an Error becomes its stack and own
 * properties), plus, for every Error found in the arguments (nested in an object, or as a `cause`), its name,
 * message, stack and own properties spelled out, so a leak cannot hide in a non-enumerable field.
 */
export function renderLogArgs(args: unknown[]): string {
  const parts: string[] = [format(...args)];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (v instanceof Error) {
      const own: Record<string, unknown> = {};
      for (const k of Object.getOwnPropertyNames(v)) own[k] = (v as unknown as Record<string, unknown>)[k];
      parts.push(v.name, v.message, v.stack ?? "", safeJson(own));
      walk((v as { cause?: unknown }).cause, depth + 1);
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const a of args) walk(a, 0);
  return parts.join("\n");
}

export interface ConsoleCapture {
  /** One entry per console call, rendered by renderLogArgs. */
  lines: string[];
  restore: () => void;
}

/** Spy on console.log/info/warn/error/debug and keep what is written. Call restore() (or mockRestore) afterwards. */
export function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(renderLogArgs(args));
    }),
  );
  return {
    lines,
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}
