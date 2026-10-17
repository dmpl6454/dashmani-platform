/**
 * Static contract of scripts/creator-payouts-ddl.sql and its production helper
 * scripts/apply-creator-payouts-ddl.sh (Razorpay Route creator payouts, plan Appendix B).
 *
 * The script is applied BY HAND to production before the feature merges (the deploy runs
 * db:generate, never db:push), so a bad edit cannot be caught any other way. It must:
 *   1. run as ONE transaction with a 3 s lock_timeout, a 60 s statement_timeout and search_path
 *      pinned to public;
 *   2. be idempotent (every CREATE is IF NOT EXISTS, the one foreign key is guarded) and purely
 *      additive: seven new tables, no DROP, no data, no ALTER of any existing table;
 *   3. carry exactly ONE foreign key (creator_rate_terms -> campaign_rate_cards, CASCADE): money
 *      records must outlive bookings, items, creators and pages, so no other table references them;
 *   4. create exactly the columns the Prisma models declare (a drift would leave production with a
 *      different table than the client expects), the unique keys the plan's idempotency rules rely
 *      on, and the CHECK constraints Prisma cannot express (the share cap, the payout amounts);
 *   5. stay in step with the helper, which re-states the table / column / index / foreign-key /
 *      CHECK lists and counts, with the CI rehearsal lists and with the test TRUNCATE list.
 * The live proof — the script applied twice on a scratch database, then an empty
 * `prisma migrate diff` — runs in CI: the "Rehearse the pipeline DDL scripts" step in
 * .github/workflows/ci.yml also applies this script (it drops the seven tables from the pushed
 * schema first).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { Prisma, prisma } from "@dashmani/db";

const ROOT = path.resolve(__dirname, "../../..");
const SQL_PATH = path.join(ROOT, "scripts/creator-payouts-ddl.sql");
const SH_PATH = path.join(ROOT, "scripts/apply-creator-payouts-ddl.sh");
const sql = fs.readFileSync(SQL_PATH, "utf8");
const sh = fs.readFileSync(SH_PATH, "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

const MODELS: Record<string, string> = {
  CreatorPayoutAccount: "creator_payout_accounts",
  CreatorRateTerm: "creator_rate_terms",
  CreatorOffer: "creator_offers",
  CreatorPayout: "creator_payouts",
  CreatorPayoutEvent: "creator_payout_events",
  CampaignRefund: "campaign_refunds",
  CampaignDispute: "campaign_disputes",
};
const TABLES = Object.values(MODELS);

// The unique keys the plan names (Appendix B and "Phase 1 > Other pieces: DDL"). Everything that
// relies on a duplicate being refused (one payout per item, one transfer id, one refund per
// idempotency key...) depends on these existing in the database, not just in Prisma.
const REQUIRED_UNIQUE: Record<string, string[]> = {
  creator_payout_accounts: ["creator_id", "razorpay_account_id"],
  creator_rate_terms: ["rate_card_id"],
  creator_offers: ["booking_item_id"],
  creator_payouts: ["booking_item_id", "razorpay_transfer_id"],
  campaign_refunds: ["razorpay_refund_id", "idempotency_key"],
  campaign_disputes: ["razorpay_dispute_id"],
};

// The one unique index Prisma cannot express (a PARTIAL one), so schema.prisma has no @@unique for it and only this script builds
// it: at most one VERIFIED creator offer per post key ("one post, one booking", the database's own backstop behind the service's
// advisory lock + count in verifyCreatorItem).
const PARTIAL_UNIQUE = {
  name: "creator_offers_verified_link_key_idx",
  statement:
    'CREATE UNIQUE INDEX IF NOT EXISTS "creator_offers_verified_link_key_idx" ON "creator_offers"("link_canonical_key") WHERE "link_verified_at" IS NOT NULL AND "link_canonical_key" IS NOT NULL;',
};

type Col = { name: string; type: string; notNull: boolean };

/** The CREATE TABLE bodies of the script: table -> its columns (constraints excluded). */
function parseDdlTables(): Record<string, Col[]> {
  const out: Record<string, Col[]> = {};
  for (const m of code.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)" \(([\s\S]*?)\n\);/g)) {
    const cols: Col[] = [];
    for (const line of m[2].split("\n")) {
      const c = /^\s+"([a-z0-9_]+)" ([A-Z]+(?:\(\d+\))?)( NOT NULL)?(?: DEFAULT .+?)?,?$/.exec(line);
      if (c) cols.push({ name: c[1], type: c[2], notNull: Boolean(c[3]) });
    }
    out[m[1]] = cols;
  }
  return out;
}
const ddlTables = parseDdlTables();

/** Index names the script creates (primary keys included), and which of them are UNIQUE. */
function parseDdlIndexes() {
  const all: string[] = [];
  const unique: string[] = [];
  const onTable: Record<string, string> = {};
  // (An optional WHERE clause: the partial unique index above.)
  for (const m of code.matchAll(/CREATE (UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)"\(([^)]*)\)(?: WHERE [^;]+)?;/g)) {
    all.push(m[2]);
    if (m[1]) unique.push(m[2]);
    onTable[m[2]] = `${m[3]}(${m[4].replace(/"/g, "").replace(/, /g, ",")})`;
  }
  for (const m of code.matchAll(/CONSTRAINT "([^"]+_pkey)" PRIMARY KEY/g)) all.push(m[1]);
  return { all, unique, onTable };
}
const ddlIndexes = parseDdlIndexes();

/** The ddl's named CHECK constraints: name -> expression. */
function parseDdlChecks(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of code.matchAll(/CONSTRAINT "([^"]+)" CHECK \((.+)\)(?:,|$)/gm)) out[m[1]] = m[2];
  return out;
}
const ddlChecks = parseDdlChecks();

/** The helper's own lists, read back out of the shell source. */
function shString(name: string): string[] {
  const m = new RegExp(`^${name}="([^"]*)"`, "m").exec(sh);
  expect(m, `${name} not found in the helper`).not.toBeNull();
  return m![1].split(/\s+/).filter(Boolean);
}
function shExpectedCols(): Record<string, string[]> {
  const block = /declare -A EXPECTED_COLS=\(([\s\S]*?)\n\)/.exec(sh)?.[1] ?? "";
  const out: Record<string, string[]> = {};
  for (const m of block.matchAll(/\[([a-z_]+)\]="([^"]*)"/g)) out[m[1]] = m[2].split(",");
  return out;
}

describe("scripts/creator-payouts-ddl.sql", () => {
  it("is one transaction with lock/statement timeouts and a pinned search_path", () => {
    const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe("\\set ON_ERROR_STOP on");
    expect(lines[1]).toBe("BEGIN;");
    expect(lines).toContain("SET LOCAL lock_timeout = '3s';");
    expect(lines).toContain("SET LOCAL statement_timeout = '60s';");
    expect(lines).toContain("SET LOCAL search_path = public;");
    expect(lines[lines.length - 1]).toBe("COMMIT;");
    expect(lines.filter((l) => l === "BEGIN;" || l === "COMMIT;")).toHaveLength(2);
  });

  it("is idempotent and additive: seven new tables, no DROP, no data, no ALTER outside the guarded FK", () => {
    expect(code).not.toMatch(/\bDROP\b/i);
    // (ON DELETE / ON UPDATE CASCADE belong to the foreign key, not to a data statement.)
    expect(code.replace(/ON DELETE CASCADE ON UPDATE CASCADE/g, "")).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bCOPY\b/i);
    expect(code).not.toMatch(/\bALTER TYPE\b|\bCREATE TYPE\b/i); // no enum change
    const creates = code.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(30);
    for (const c of creates) expect(c).toMatch(/IF NOT EXISTS/i);
    expect(Object.keys(ddlTables).sort()).toEqual([...TABLES].sort());
    // Every table and index the script touches is one of the seven.
    for (const t of code.matchAll(/(?:CREATE TABLE IF NOT EXISTS|\bON)\s+"([^"]+)"/g)) {
      if (t[1] === "campaign_rate_cards") continue; // only as the foreign key's parent, below
      expect(TABLES).toContain(t[1]);
    }
    // The only ALTER TABLE is the foreign key, and it sits inside a guarded DO block.
    const alters = code.match(/ALTER TABLE[^;]*;/g) ?? [];
    expect(alters).toHaveLength(1);
    expect(alters[0]).toContain('ALTER TABLE "creator_rate_terms" ADD CONSTRAINT "creator_rate_terms_rate_card_id_fkey"');
    expect(code).toMatch(
      /DO \$\$ BEGIN\s+IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'creator_rate_terms_rate_card_id_fkey' AND conrelid = '"public"\."creator_rate_terms"'::regclass\) THEN\s+ALTER TABLE/,
    );
  });

  it("has exactly one foreign key: creator_rate_terms -> campaign_rate_cards ON DELETE CASCADE", () => {
    const refs = code.match(/REFERENCES\s+"[^"]+"\("[^"]+"\)[^;]*/g) ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe('REFERENCES "campaign_rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE');
    expect(code.match(/FOREIGN KEY/g) ?? []).toHaveLength(1);
    expect(code).toContain('FOREIGN KEY ("rate_card_id") REFERENCES "campaign_rate_cards"("id")');
    // The header explains why nothing else references bookings, items, creators or pages.
    expect(sql).toMatch(/NO foreign key to bookings, items, creators or\s*--\s*creator_assets/);
  });

  it("creates exactly the columns, base types and nullability of the Prisma models", () => {
    // The runtime DMMF has no native types (VarChar lengths): those are compared against the
    // database prisma db push builds, in the next test.
    const baseType = (t: string): RegExp => {
      if (t === "String") return /^(TEXT|VARCHAR\(\d+\)|CHAR\(\d+\))$/;
      if (t === "Int") return /^INTEGER$/;
      if (t === "Boolean") return /^BOOLEAN$/;
      if (t === "Json") return /^JSONB$/;
      if (t === "DateTime") return /^(TIMESTAMP\(3\)|DATE)$/;
      throw new Error(`unmapped Prisma type ${t}`);
    };
    for (const [modelName, table] of Object.entries(MODELS)) {
      const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
      expect(model, modelName).toBeDefined();
      expect(model!.dbName).toBe(table);
      const expected = model!.fields
        .filter((f) => f.kind === "scalar")
        .map((f) => ({ name: f.dbName ?? f.name, type: f.type, notNull: f.isRequired }));
      const actual = ddlTables[table];
      expect(actual.map((c) => c.name).sort(), `${table} columns`).toEqual(expected.map((c) => c.name).sort());
      for (const e of expected) {
        const a = actual.find((c) => c.name === e.name)!;
        expect(a.type, `${table}.${e.name} type`).toMatch(baseType(e.type));
        expect(a.notNull, `${table}.${e.name} NOT NULL`).toBe(e.notNull);
      }
    }
  });

  it("matches what prisma db push builds in the test database (columns, types, lengths, nullability)", async () => {
    const dbType = (t: string): { data_type: string; len: number | null; precision: number | null } => {
      const v = /^VARCHAR\((\d+)\)$/.exec(t);
      if (v) return { data_type: "character varying", len: Number(v[1]), precision: null };
      if (t === "TEXT") return { data_type: "text", len: null, precision: null };
      if (t === "INTEGER") return { data_type: "integer", len: null, precision: null };
      if (t === "BOOLEAN") return { data_type: "boolean", len: null, precision: null };
      if (t === "JSONB") return { data_type: "jsonb", len: null, precision: null };
      if (t === "DATE") return { data_type: "date", len: null, precision: null };
      if (t === "TIMESTAMP(3)") return { data_type: "timestamp without time zone", len: null, precision: 3 };
      throw new Error(`unmapped DDL type ${t}`);
    };
    for (const table of TABLES) {
      const rows = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; character_maximum_length: number | null; datetime_precision: number | null; is_nullable: string }>
      >`SELECT column_name, data_type, character_maximum_length, datetime_precision, is_nullable
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
      expect(rows.map((r) => r.column_name).sort(), table).toEqual(ddlTables[table].map((c) => c.name).sort());
      for (const col of ddlTables[table]) {
        const r = rows.find((x) => x.column_name === col.name)!;
        const want = dbType(col.type);
        expect(r.data_type, `${table}.${col.name} data type`).toBe(want.data_type);
        expect(r.character_maximum_length, `${table}.${col.name} length`).toBe(want.len);
        if (want.precision !== null) expect(r.datetime_precision, `${table}.${col.name} precision`).toBe(want.precision);
        expect(r.is_nullable === "NO", `${table}.${col.name} NOT NULL`).toBe(col.notNull);
      }
    }
  });

  it("stores money as integer paise and no secret-bearing columns", () => {
    for (const table of TABLES) {
      for (const col of ddlTables[table]) {
        if (/paise$/.test(col.name)) expect(col.type, `${table}.${col.name}`).toBe("INTEGER");
        // PAN, bank account number, IFSC, address or beneficiary name must never get a column.
        expect(col.name, `${table}.${col.name}`).not.toMatch(/^(pan|account_number|ifsc|ifsc_code|beneficiary_name|address|legal_info|kyc)/);
        expect(col.name, `${table}.${col.name}`).not.toMatch(/(^|_)(pan|ifsc)($|_)/);
      }
    }
  });

  it("creates the unique keys the plan's idempotency rules rely on, and no others", () => {
    const expected = Object.entries(REQUIRED_UNIQUE)
      .flatMap(([table, cols]) => cols.map((c) => `${table}_${c}_key`))
      .sort();
    expect(expected).toHaveLength(9);
    // The nine plain ones, plus the one partial index.
    expect([...ddlIndexes.unique].sort()).toEqual([...expected, PARTIAL_UNIQUE.name].sort());
    for (const [table, cols] of Object.entries(REQUIRED_UNIQUE)) {
      for (const c of cols) {
        expect(code).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${table}_${c}_key" ON "${table}"("${c}");`);
      }
    }
  });

  it("⚠️ makes a verified creator post unique per post key IN THE DATABASE: a PARTIAL unique index (verified rows with a key only), written exactly so", () => {
    // Partial, not plain: two creators may paste one post before staff decide, and an offer with no link has no key. Only a
    // VERIFIED offer reserves the post. A plain unique index here would refuse the unverified duplicates the service allows.
    expect(code).toContain(PARTIAL_UNIQUE.statement);
    expect(ddlIndexes.onTable[PARTIAL_UNIQUE.name]).toBe("creator_offers(link_canonical_key)");
    expect(ddlIndexes.unique).toContain(PARTIAL_UNIQUE.name);
    // Prisma cannot express it, so it must not appear in schema.prisma as a @@unique that `db push` would then try to own.
    const schema = fs.readFileSync(path.join(ROOT, "packages/db/prisma/schema.prisma"), "utf8");
    const model = /model CreatorOffer \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    expect(model).not.toMatch(/@@unique\(\[linkCanonicalKey/);
    expect(model).toMatch(/@@index\(\[linkCanonicalKey\]\)/);
  });

  it("creates the lookup indexes the reconciliation cron and the lists need", () => {
    const on = ddlIndexes.onTable;
    expect(on["creator_payouts_status_next_attempt_at_idx"]).toBe("creator_payouts(status,next_attempt_at)");
    expect(on["creator_payouts_creator_id_idx"]).toBe("creator_payouts(creator_id)");
    expect(on["creator_payouts_booking_id_idx"]).toBe("creator_payouts(booking_id)");
    expect(on["creator_payouts_razorpay_payment_id_idx"]).toBe("creator_payouts(razorpay_payment_id)");
    expect(on["campaign_refunds_razorpay_payment_id_idx"]).toBe("campaign_refunds(razorpay_payment_id)");
    expect(on["campaign_disputes_razorpay_payment_id_idx"]).toBe("campaign_disputes(razorpay_payment_id)");
    expect(on["creator_offers_creator_id_status_idx"]).toBe("creator_offers(creator_id,status)");
    expect(on["creator_payout_events_payout_id_created_at_idx"]).toBe("creator_payout_events(payout_id,created_at)");
  });

  it("carries the CHECK constraints Prisma cannot express", () => {
    expect(Object.keys(ddlChecks).sort()).toEqual([
      "creator_payout_accounts_tds_bps_check",
      "creator_payouts_amounts_check",
      "creator_rate_terms_share_bps_check",
    ]);
    // The creator's share never exceeds 90%.
    expect(ddlChecks["creator_rate_terms_share_bps_check"]).toBe('"share_bps" >= 0 AND "share_bps" <= 9000');
    expect(ddlChecks["creator_payout_accounts_tds_bps_check"]).toBe('"tds_bps" >= 0 AND "tds_bps" <= 10000');
    // A payout can never exceed what the brand paid for that item.
    const amounts = ddlChecks["creator_payouts_amounts_check"];
    for (const part of ['"gross_paise" >= 0', '"tds_paise" >= 0', '"amount_paise" >= 0', '"amount_paise" <= "gross_paise"', '"gross_paise" <= "item_price_paise"']) {
      expect(amounts).toContain(part);
    }
  });

  it("stores every canonical key as TEXT: canonicalKey() falls back to the whole lowercased URL", () => {
    // A fixed width below the URL column's own would make a long Facebook permalink fail with 22001
    // (value too long) at the offer update. link_url's VARCHAR(500) is what bounds the key and so the
    // btree entry of its index; the key itself must not be narrower.
    const offers = ddlTables["creator_offers"];
    expect(offers.find((c) => c.name === "link_canonical_key")?.type).toBe("TEXT");
    expect(offers.find((c) => c.name === "link_url")?.type).toBe("VARCHAR(500)");
    for (const table of TABLES) {
      for (const col of ddlTables[table]) {
        if (/canonical_key$/.test(col.name)) expect(col.type, `${table}.${col.name}`).toBe("TEXT");
      }
    }
    // A URL is never stored in a column narrower than link_url's 500.
    for (const table of TABLES) {
      for (const col of ddlTables[table]) {
        if (/(^|_)url($|_)/.test(col.name)) expect(col.type, `${table}.${col.name}`).toMatch(/^(TEXT|VARCHAR\((\d{3,})\))$/);
      }
    }
  });

  it("is wired into the CI rehearsal and the test TRUNCATE list", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const drop = /DROP TABLE ([^"]+)"/.exec(ci)?.[1] ?? "";
    const dropped = drop.split(",").map((t) => t.trim());
    for (const t of TABLES) expect(dropped, `ci.yml DROP list misses ${t}`).toContain(t);
    const loop = /for script in ([^;]+); do/.exec(ci)?.[1] ?? "";
    const scripts = loop.split(/\s+/).filter(Boolean);
    expect(scripts).toContain("scripts/creator-payouts-ddl.sql");
    // The foreign key points at campaign_rate_cards, which the campaign scripts rebuild first.
    expect(scripts.indexOf("scripts/creator-payouts-ddl.sql")).toBeGreaterThan(scripts.indexOf("scripts/campaign-booking-ddl.sql"));
    const setup = fs.readFileSync(path.join(ROOT, "apps/api/tests/setup.ts"), "utf8");
    const truncate = /TRUNCATE TABLE([\s\S]*?)CASCADE/.exec(setup)?.[1] ?? "";
    for (const t of TABLES) expect(truncate, `tests/setup.ts TRUNCATE list misses ${t}`).toMatch(new RegExp(`\\b${t}\\b`));
  });
});

describe("scripts/apply-creator-payouts-ddl.sh", () => {
  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", SH_PATH], { stdio: "pipe" })).not.toThrow();
  });

  it("states the same seven tables, columns, indexes, foreign key and CHECKs as the DDL", () => {
    expect([...shString("TABLES")].sort()).toEqual([...TABLES].sort());
    const cols = shExpectedCols();
    expect(Object.keys(cols).sort()).toEqual([...TABLES].sort());
    for (const table of TABLES) {
      const fromDdl = ddlTables[table].map((c) => c.name).sort();
      expect(cols[table], `${table} columns in the helper`).toEqual(fromDdl);
      // It compares against `ORDER BY column_name COLLATE "C"`: byte-wise order.
      expect(cols[table], `${table} columns sorted byte-wise`).toEqual([...cols[table]].sort());
    }
    expect([...shString("EXPECTED_INDEXES")].sort()).toEqual([...ddlIndexes.all].sort());
    expect([...shString("EXPECTED_UNIQUE")].sort()).toEqual([...ddlIndexes.unique].sort());
    expect(shString("EXPECTED_FKS")).toEqual(["creator_rate_terms_rate_card_id_fkey"]);
    const checks = shString("EXPECTED_CHECKS").map((p) => p.split(":"));
    expect(checks.map((p) => p[1]).sort()).toEqual(Object.keys(ddlChecks).sort());
    for (const [table, name] of checks) expect(name.startsWith(table), `${name} belongs to ${table}`).toBe(true);
  });

  it("verifies the counts it prints against the lists it holds", () => {
    expect(sh).toContain(`[ "$IDX" = "${ddlIndexes.all.length}" ]`);
    expect(sh).toContain(`[ "$UNIQ" = "${ddlIndexes.unique.length}" ]`);
    expect(sh).toContain('[ "$FK" = "1" ]');
    expect(sh).toContain('[ "$ALLFK" = "1" ]');
    expect(sh).toContain(`(expected ${ddlIndexes.all.length} incl. the 7 primary keys)`);
    expect(sh).toContain(`(expected ${ddlIndexes.unique.length})`);
    expect(sh).toContain(`CHECK constraints: $NCHECK (expected ${Object.keys(ddlChecks).length})`);
    expect(ddlIndexes.all).toHaveLength(34);
    expect(ddlIndexes.unique).toHaveLength(10);
    // The helper checks the partial index's definition itself, not just that an index of that name exists.
    expect(sh).toContain("creator_offers_verified_link_key_idx");
    expect(sh).toContain("link_verified_at IS NOT NULL");
  });

  it("keeps the creators helper's safety model", () => {
    expect(sh).toContain('EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"');
    expect(sh).toMatch(/\[ "\$ROLE" = "\$EXPECT_ROLE" \] \|\| fail/);
    expect(sh).toContain('BRANCH="${BRANCH:-claude/awesome-bohr-qu8x1k}"');
    expect(sh).toContain('APP_DIR="${APP_DIR:-/opt/dashmani-platform}"');
    expect(sh).toContain("git show \"origin/$BRANCH:scripts/creator-payouts-ddl.sql\"");
    expect(sh).toContain("pgenv pg_dump \"$DBURL\" --schema-only");
    expect(sh).toContain("PGAPPNAME=creator-payouts-ddl pgenv psql");
    // Read-only pre-flight on the existing tables, and an inspect-only drift check (never applied).
    expect(sh).toContain("migrate diff");
    const shCommands = sh
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && !/^\s*(echo|fail)\b/.test(l))
      .join("\n");
    expect(shCommands).not.toMatch(/prisma\s+(db\s+push|migrate\s+(deploy|dev|reset))|db:push/);
    // Exit codes: 1 = a step failed, 2 = applied and verified but the drift check could not run.
    expect(sh).toContain("exit 2");
    expect(sh).toContain("exit 1");
    // The helper's pre-flight covers the one existing table the DDL touches.
    expect(sh).toContain("campaign_rate_cards");
  });

  it("never puts the database password on a command line (ps and /proc/*/cmdline show it to every local user)", () => {
    const shCommands = sh
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && !/^\s*(echo|fail)\b/.test(l))
      .join("\n");
    // Every psql / pg_dump goes through pgenv, which hands the password over as PGPASSWORD for that one command.
    const calls = [...shCommands.matchAll(/\b(psql|pg_dump)\s+"\$DBURL"/g)];
    expect(calls.length).toBeGreaterThanOrEqual(3); // q(), the schema backup, the DDL apply
    for (const c of calls) expect(shCommands.slice(c.index! - 6, c.index!), `${c[0]} must be run through pgenv`).toBe("pgenv ");
    expect(shCommands).not.toMatch(/\b(psql|pg_dump)\s+"\$FULLURL"/);
    expect(shCommands).not.toMatch(/export\s+PGPASSWORD/);
    // The full URL (password included) reaches Prisma only through that one process's environment.
    expect(shCommands).not.toMatch(/--from-url/);
    expect(shCommands).toContain('DATABASE_URL="$FULLURL" timeout 300 npx --no-install prisma migrate diff');
    expect(shCommands).toContain('--from-schema-datasource "$WORK/schema.prisma"');
    const uses = shCommands.split("\n").filter((l) => l.includes('"$FULLURL"') || l.includes("$FULLURL"));
    for (const l of uses) expect(l, "FULLURL may only be assigned, split, or exported to prisma").toMatch(/FULLURL=|=~|DATABASE_URL="\$FULLURL"|\[ -n "\$FULLURL" \]|DBURL="\$FULLURL"/);
  });

  it("splits the password off the URL and percent-decodes it exactly (even a literal backslash)", () => {
    const start = sh.indexOf('DBURL="$FULLURL"; PGPW=""');
    const end = sh.indexOf("pgenv() {");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const snippet = sh.slice(start, end);
    const run = (url: string) => {
      const out = execFileSync("bash", ["-c", `${snippet}\nprintf '%s\\n%s' "$PGPW" "$DBURL"`], {
        env: { FULLURL: url, PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
      const nl = out.indexOf("\n");
      return { pw: out.slice(0, nl), url: out.slice(nl + 1) };
    };
    const plain = run("postgresql://dashmani:plain123@127.0.0.1:5432/dashmani");
    expect(plain).toEqual({ pw: "plain123", url: "postgresql://dashmani@127.0.0.1:5432/dashmani" });
    const odd = run("postgresql://dashmani:p%40ss%3Aw%25rd%5Cx41%2F%23+z@localhost:5432/dashmani");
    expect(odd.pw).toBe("p@ss:w%rd\\x41/#+z");
    expect(odd.url).toBe("postgresql://dashmani@localhost:5432/dashmani");
    const backslash = run("postgres://dashmani:back\\slash\\x41n@localhost/db");
    expect(backslash.pw).toBe("back\\slash\\x41n");
    const none = run("postgresql://dashmani@localhost/db");
    expect(none).toEqual({ pw: "", url: "postgresql://dashmani@localhost/db" });
    for (const r of [plain, odd, backslash, none]) expect(r.url).not.toContain(r.pw || "\u0000");
  });

  it("checks that creator_offers.link_canonical_key is TEXT before and after applying (a name list alone would miss an older VARCHAR build)", () => {
    expect(sh).toContain("coltype_of creator_offers link_canonical_key");
    expect(sh.match(/\[ "\$KEYTYPE" = "text" \]/g) ?? []).toHaveLength(2);
  });
});
