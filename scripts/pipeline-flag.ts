/**
 * pipeline-flag.ts — turn the Pipeline feature off / pilot / on, manage the pilot list, and
 * switch pipeline EMAIL on / off (plan M6, spec §12 steps 8–10; email 2026-09-30). It upserts
 * the `system_settings` keys the API reads (`pipeline.mode`, `pipeline.pilotUserIds`,
 * `pipeline.email`); the API picks a change up within 15 s.
 *
 * DRY RUN BY DEFAULT: it prints the before and after states and writes nothing. Writing
 * needs BOTH `--apply` and `--confirm-prod`.
 *
 *   cd packages/db && npx tsx ../../scripts/pipeline-flag.ts                                  # show the current state
 *   cd packages/db && npx tsx ../../scripts/pipeline-flag.ts --mode=pilot --add=a@x.com,b@x.com
 *   cd packages/db && npx tsx ../../scripts/pipeline-flag.ts --mode=pilot --add=a@x.com --apply --confirm-prod
 *   cd packages/db && npx tsx ../../scripts/pipeline-flag.ts --mode=off --apply --confirm-prod   # the kill switch
 *   cd packages/db && npx tsx ../../scripts/pipeline-flag.ts --email=on                          # dry run: emails on
 *   cd packages/db && npx tsx ../../scripts/pipeline-flag.ts --email=off --apply --confirm-prod  # the email kill switch
 *
 * Email also needs SMTP_USER/SMTP_PASS in apps/api/.env and scripts/pipeline-email-ddl.sql
 * applied; with either missing the API keeps email off whatever this flag says.
 *
 * Emails are matched case-insensitively (the platform's email rule). An email that
 * matches no user, or more than one, is an error: nothing is written. The pilot list is
 * stored as a sorted JSON array of user ids; ids already on the list whose user no longer
 * exists are kept (and reported) — removing them is an explicit `--remove`.
 *
 * ⚠️ ROLL BACK WITH --mode=off, NEVER --mode=pilot. Going on → pilot strands everyone off the
 * pilot list: every pipeline route 403s them — the projects they OWN included (and nobody can
 * transfer ownership to them: only pilot users are pickable) — and every due alert the cron
 * sends meanwhile stamps the whole project as notified for that date while writing rows only
 * for pilot users, so the others never get it — not even after a later switch back to on.
 * The script prints a warning for on → pilot (WARNINGS below) BEFORE it writes, and with
 * --apply waits WARNING_PAUSE_MS so the operator can still press Ctrl-C — but it does not
 * refuse: an operator may mean it.
 */
import { prisma } from "@dashmani/db";

export type PipelineFlagMode = "off" | "pilot" | "on";
export type PipelineFlagEmail = "on" | "off";

export interface PipelineFlagOptions {
  mode?: PipelineFlagMode;
  email?: PipelineFlagEmail;
  add?: string[];
  remove?: string[];
  apply?: boolean;
}

export interface PipelineFlagState {
  mode: string;
  /** "on" or "off" as stored; "off (absent)" when there is no row. */
  email: string;
  pilotUserIds: string[];
  pilot: Array<{ id: string; email: string | null; name: string | null; status: string | null }>;
}

export interface PipelineFlagResult {
  before: PipelineFlagState;
  after: PipelineFlagState;
  changed: boolean;
  applied: boolean;
  errors: string[];
  /** Cautions about a VALID change — printed prominently, never a reason not to write. */
  warnings: string[];
}

/** The on → pilot caution (see the header). */
export const ON_TO_PILOT_WARNING =
  "on → pilot is NOT a safe rollback. Everyone off the pilot list loses access to Pipeline entirely " +
  "(403 on every route, including the projects they own — and ownership can't be transferred to them), and " +
  "due alerts sent meanwhile are marked as sent for every participant, so they never get them — not even " +
  "after you switch back to on. " +
  "To roll back, use --mode=off (the kill switch): it pauses Pipeline for everyone and resumes cleanly.";

/** How long `--apply` waits after printing a WARNING, so the operator can still press Ctrl-C. */
export const WARNING_PAUSE_MS = 10_000;

type Db = typeof prisma;

const MODES: readonly PipelineFlagMode[] = ["off", "pilot", "on"];
const EMAIL_VALUES: readonly PipelineFlagEmail[] = ["on", "off"];

function parseIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const t = raw.trim();
  let list: unknown = null;
  if (t.startsWith("[")) {
    try {
      list = JSON.parse(t);
    } catch {
      list = null;
    }
  }
  const items = Array.isArray(list) ? list : t.split(/[\s,]+/);
  return [...new Set(items.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

async function describe(db: Db, mode: string, email: string, ids: string[]): Promise<PipelineFlagState> {
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true, status: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id.toLowerCase(), u]));
  return {
    mode,
    email,
    pilotUserIds: ids,
    pilot: ids.map((id) => {
      const u = byId.get(id);
      return { id, email: u?.email ?? null, name: u?.name ?? null, status: u?.status ?? null };
    }),
  };
}

/** Resolve emails → user ids (case-insensitive). Unknown / ambiguous emails are errors. */
async function resolveEmails(db: Db, emails: string[], errors: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    const matches = await db.user.findMany({
      where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
      select: { id: true, status: true },
    });
    if (matches.length === 0) errors.push(`no user with email ${email}`);
    else if (matches.length > 1) errors.push(`email ${email} matches ${matches.length} users`);
    else out.push(matches[0].id.toLowerCase());
  }
  return out;
}

export async function runPipelineFlag(db: Db, opts: PipelineFlagOptions): Promise<PipelineFlagResult> {
  const errors: string[] = [];
  if (opts.mode !== undefined && !MODES.includes(opts.mode)) errors.push(`--mode must be one of ${MODES.join("|")}`);
  if (opts.email !== undefined && !EMAIL_VALUES.includes(opts.email)) errors.push(`--email must be one of ${EMAIL_VALUES.join("|")}`);

  const rows = await db.systemSetting.findMany({
    where: { key: { in: ["pipeline.mode", "pipeline.pilotUserIds", "pipeline.email"] } },
    select: { key: true, value: true },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const beforeMode = (get("pipeline.mode") ?? "").trim().toLowerCase() || "off (absent)";
  const beforeEmail = (get("pipeline.email") ?? "").trim().toLowerCase() || "off (absent)";
  const beforeIds = parseIds(get("pipeline.pilotUserIds"));

  const addIds = await resolveEmails(db, opts.add ?? [], errors);
  const removeIds = await resolveEmails(db, opts.remove ?? [], errors);

  const nextIds = [...new Set([...beforeIds, ...addIds])].filter((id) => !removeIds.includes(id)).sort();
  const nextMode = opts.mode ?? beforeMode;
  const nextEmail = opts.email ?? beforeEmail;

  const before = await describe(db, beforeMode, beforeEmail, beforeIds);
  const after = await describe(db, nextMode, nextEmail, nextIds);
  const modeChanged = opts.mode !== undefined && opts.mode !== beforeMode;
  const warnings: string[] = [];
  if (modeChanged && beforeMode === "on" && opts.mode === "pilot") warnings.push(ON_TO_PILOT_WARNING);
  const emailChanged = opts.email !== undefined && opts.email !== beforeEmail;
  const idsChanged = JSON.stringify([...beforeIds].sort()) !== JSON.stringify(nextIds);
  const changed = modeChanged || idsChanged || emailChanged;

  let applied = false;
  if (opts.apply && errors.length === 0 && changed) {
    await db.$transaction(async (tx) => {
      if (modeChanged) {
        await tx.systemSetting.upsert({
          where: { key: "pipeline.mode" },
          create: { key: "pipeline.mode", value: opts.mode! },
          update: { value: opts.mode! },
        });
      }
      if (emailChanged) {
        await tx.systemSetting.upsert({
          where: { key: "pipeline.email" },
          create: { key: "pipeline.email", value: opts.email! },
          update: { value: opts.email! },
        });
      }
      if (idsChanged) {
        const value = JSON.stringify(nextIds);
        await tx.systemSetting.upsert({
          where: { key: "pipeline.pilotUserIds" },
          create: { key: "pipeline.pilotUserIds", value },
          update: { value },
        });
      }
    });
    applied = true;
  }
  return { before, after, changed, applied, errors, warnings };
}

/** Where the CLI writes — the console in main(); a recorder in tests. */
export interface PipelineFlagIo {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  /** Wait `ms` before writing (main() sleeps; a test observes the state at that moment). */
  pause(ms: number): Promise<void>;
}

function print(io: PipelineFlagIo, label: string, s: PipelineFlagState): void {
  io.log(`${label}: mode=${s.mode} email=${s.email} pilot=${s.pilotUserIds.length}`);
  for (const p of s.pilot) {
    io.log(`    ${p.id}  ${p.email ?? "(no such user)"}  ${p.name ?? ""}${p.status && p.status !== "ACTIVE" ? `  [${p.status}]` : ""}`);
  }
}

/**
 * The CLI flow. A DRY pass runs first, so a WARNING (on → pilot) is printed BEFORE anything
 * is written — with --apply the write then waits WARNING_PAUSE_MS, so an operator who typed
 * the documented pilot-start command during an incident can still press Ctrl-C. A change
 * with no warning (the kill switch --mode=off included) is applied at once.
 */
export async function runPipelineFlagCli(db: Db, opts: PipelineFlagOptions, io: PipelineFlagIo): Promise<PipelineFlagResult> {
  const plan = await runPipelineFlag(db, { ...opts, apply: false });
  print(io, "BEFORE", plan.before);
  print(io, "AFTER ", plan.after);
  for (const w of plan.warnings) {
    const bar = "!".repeat(78);
    io.warn(`\n${bar}\nWARNING: ${w}\n${bar}\n`);
  }
  for (const e of plan.errors) io.error(`ERROR: ${e}`);
  if (plan.errors.length) {
    io.error("Nothing written.");
    return plan;
  }
  if (!plan.changed) {
    io.log("No change.");
    return plan;
  }
  if (!opts.apply) {
    io.log("DRY-RUN — re-run with --apply --confirm-prod to write.");
    return plan;
  }
  if (plan.warnings.length) {
    io.warn(`Writing in ${WARNING_PAUSE_MS / 1000} s — press Ctrl-C now to abort. Nothing has been written yet.`);
    await io.pause(WARNING_PAUSE_MS);
  }
  const res = await runPipelineFlag(db, opts);
  for (const e of res.errors) io.error(`ERROR: ${e}`);
  if (res.errors.length) io.error("Nothing written.");
  else if (res.applied) io.log("APPLIED — the API picks this up within 15 s.");
  else io.log("No change.");
  return res;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const confirm = process.argv.includes("--confirm-prod");
  const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const mode = arg("mode") as PipelineFlagMode | undefined;
  const email = arg("email") as PipelineFlagEmail | undefined;
  if (apply && !confirm) {
    console.error("Refusing to write without --confirm-prod (writing needs --apply --confirm-prod).");
    process.exit(2);
  }
  const res = await runPipelineFlagCli(
    prisma,
    { mode, email, add: list(arg("add")), remove: list(arg("remove")), apply: apply && confirm },
    {
      log: (s) => console.log(s),
      warn: (s) => console.warn(s),
      error: (s) => console.error(s),
      pause: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  );
  if (res.errors.length) process.exitCode = 1;
}

if (process.argv[1] && /pipeline-flag\.ts$/.test(process.argv[1])) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
