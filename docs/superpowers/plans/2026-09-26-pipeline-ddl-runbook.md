# Pipeline M1: production DDL runbook (PR 5, `feat/pipeline-schema`)

**What this does.** It applies `scripts/pipeline-ddl.sql` to `dashmani_prod` **before** PR 5 merges, then merges PR 5 in the same window (spec §12 "The DDL cycle", plan Task 5.2 steps 5–6).
- The script creates five empty `pipeline_*` tables, 14 indexes and 8 foreign keys, and adds one enum value: `NotificationType.PIPELINE`.
- It seeds the board row and the 7 phases.
- It changes **no existing table**. The only change to an existing object is the enum value.

**Who approves.** The owner must say yes **twice**: once before Step 3 (apply the DDL), and once before Step 6 (merge). Nobody applies or merges on an agent's word.

**Why it is low-risk.**
- Nothing reads or writes these objects until later PRs ship behind `pipeline.mode`. The running API's Prisma client ignores tables it does not know.
- The script is a single transaction, so it applies fully or not at all.
- The only lock on an existing table is a brief `SHARE ROW EXCLUSIVE` on `users`, taken by the four FKs that reference it. They run last, right before `COMMIT`, so the lock is held for milliseconds.
  - That lock blocks **writes** to `users`. It does not block reads (login's user lookup) or login's refresh-token insert, whose FK check only needs `ROW SHARE`.
  - `lock_timeout = '3s'` caps any wait. If the lock is not granted within 3 s, the script aborts and rolls back. Writes to `users` can queue behind the waiting request for at most those 3 s.
- The column and index definitions are byte-identical to `prisma migrate diff` output, so after the apply Prisma sees **no pipeline drift**.

---

## 0. Preconditions (all must hold)

- [ ] It is a **working weekday** (Mon–Sat), inside **11:00–12:30 IST** or **14:30–16:00 IST**.
  - Never 09:00–10:00 (login rush). Never 17:30–00:30 (HR submit rush).
- [ ] PR 5 is reviewed, and CI is green on its head commit. Record that head SHA as `$PR5_SHA`.
- [ ] The P10 sandbox result is recorded in `.planning/PIPELINE-P9-BASELINE.md`. It is the rollback evidence for the permanent enum value (spec §12, sequence step 2).
- [ ] The owner has given approval #1 (apply).

## 1. Stage the reviewed files on the box

From a local checkout of PR 5 at `$PR5_SHA`:

```bash
git -C <local checkout> rev-parse HEAD    # must print $PR5_SHA
shasum -a 256 scripts/pipeline-ddl.sql packages/db/prisma/schema.prisma
ssh dashmani-prod 'mkdir -p /root/pipeline-m1'
scp scripts/pipeline-ddl.sql packages/db/prisma/schema.prisma dashmani-prod:/root/pipeline-m1/
```

On the box:

```bash
ssh dashmani-prod
ls /opt/dashmani-platform                      # must succeed: confirms this is prod, not the `linode` box
cd /root/pipeline-m1 && sha256sum pipeline-ddl.sql schema.prisma   # must equal the local hashes
```

## 2. Pre-flight: health, backup, and read-only checks

**2a. Get the DB URL** using the same method as `scripts/backup.sh`. Grep the line rather than `source` the file. Then strip the Prisma-only query string, which libpq rejects.

```bash
set -o pipefail
DBURL=$(grep -hE '^DATABASE_URL=' /opt/dashmani-platform/apps/api/.env /opt/dashmani-platform/.env 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || { echo "no DATABASE_URL"; exit 1; }
```

⚠️ Always connect as **this** role (the `dashmani` app role). Never use `sudo -u postgres psql` for the apply.
- Tables created by `postgres` would be owned by `postgres`.
- Every later Prisma DDL would then fail with `permission denied` (the documented table-ownership incident).

**2b. Health baseline.** Record every number. They are the "healthy before" yardstick.

```bash
curl -s -o /dev/null -w "health %{http_code}\n" https://api.digitalsukoon.com/v1/health    # 200
pm2 status                                                                                  # api internal client hr jobs online
free -m
pm2 logs api --lines 3000 --nostream 2>&1 | grep -cE "PrismaClientValidationError|does not exist|P2024"   # record as BASE_ERR
psql "$DBURL" -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
```

**2c. Backup** (spec §12: the `scripts/backup.sh` method, not `pre-deploy-backup.sh`).

```bash
# Always: schema-only dump. Seconds, negligible load.
pg_dump "$DBURL" --schema-only --no-owner --no-privileges > /root/pipeline-m1/pre-ddl-schema.sql
test -s /root/pipeline-m1/pre-ddl-schema.sql && echo SCHEMA-DUMP-OK

# Full backup: the script runs pg_dump at nice 19 / ionice idle and prints "BACKUP OK" on success.
bash /opt/dashmani-platform/scripts/backup.sh 2>&1 | tee /root/pipeline-m1/backup.log
grep -q "BACKUP OK" /root/pipeline-m1/backup.log && echo FULL-BACKUP-OK
```

The full dump of a database this size can take a long time, even at idle priority. If it would push the apply outside the window, start it earlier the same morning, before 09:00 IST, and confirm `BACKUP OK` before Step 3. The DDL adds objects only, so any failure is a rollback, never a data rewrite.

**2d. Read-only DB checks.** Each line states the expected result.

```bash
psql "$DBURL" -At <<'SQL'
SHOW server_version;                                                          -- >= 13 (gen_random_uuid is built in)
SELECT current_user;                                                          -- the app role, e.g. dashmani
SELECT typowner::regrole = current_user::regrole FROM pg_type WHERE typname = 'NotificationType';  -- t
SELECT tableowner = current_user FROM pg_tables WHERE tablename = 'users';    -- t
SELECT has_schema_privilege('public', 'CREATE');                              -- t
SELECT has_table_privilege('users', 'REFERENCES');                            -- t
SELECT count(*) FROM pg_tables WHERE tablename LIKE 'pipeline\_%';           -- 0 (first apply)
SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'NotificationType' AND e.enumlabel = 'PIPELINE';           -- 0 (first apply)
SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'NotificationType';                                        -- 18
SELECT pid, state, now() - xact_start AS age, left(query, 80)
  FROM pg_stat_activity
  WHERE datname = current_database() AND xact_start < now() - interval '5 seconds'
    AND pid <> pg_backend_pid();                                               -- ideally no rows
SQL
```

**Stop here, apply nothing, and investigate if any of these hold:**
- health is not 200, or an app is not online;
- `BASE_ERR` shows P2024 or `does not exist` lines from the last hour;
- either backup did not print its OK marker;
- the server is older than PG 13;
- an ownership or privilege check is `f`;
- any `pipeline_*` table already exists. `IF NOT EXISTS` would **silently skip** a table of a different shape, so an existing one must be diffed first. It must not be papered over.
- `PIPELINE` already exists;
- a transaction older than a few seconds is open. Wait until it finishes, or ask what it is. A write transaction on `users` is exactly what would make the apply time out.

## 3. Apply (owner approval #1 already given)

```bash
PGAPPNAME=pipeline-ddl psql "$DBURL" -v ON_ERROR_STOP=1 -f /root/pipeline-m1/pipeline-ddl.sql 2>&1 | tee /root/pipeline-m1/apply.log
echo "exit=${PIPESTATUS[0]}"    # must be 0
```

**Expected output:** `BEGIN`, `SET`, `SET`, `ALTER TYPE`, 5× `CREATE TABLE`, 14× `CREATE INDEX`, 4× `DO`, `INSERT 0 1`, `INSERT 0 7`, 4× `DO`, `COMMIT`. The whole run takes well under a second.

**Abort criteria** (the script has already rolled itself back in every case):

| Symptom | Meaning | Action |
|---|---|---|
| exit 3, `canceling statement due to lock timeout` | A writer held `users` for more than 3 s | Confirm nothing applied: `pipeline_*` count = 0 and `PIPELINE` absent. Wait at least 10 min, re-run the 2d checks, and retry **once** inside the window. After a second timeout, stop for the day. |
| `must be owner of type` / `permission denied` | Wrong role, or a mis-owned object | Stop. Fix ownership in a separate reviewed change. Never retry as `postgres`. |
| any other `ERROR` | An unexpected state | Stop. Keep `apply.log`. Confirm the rollback (0 tables, no `PIPELINE`) and investigate. |

## 4. Verify (read-only)

```bash
psql "$DBURL" <<'SQL'
\d pipeline_*
SELECT key, name, position, color, is_terminal FROM pipeline_phases ORDER BY position;   -- 7 rows, Brief..Done, only done terminal
SELECT * FROM pipeline_board_state;                                                   -- (1, 0, <utc now>)
SELECT unnest(enum_range(NULL::"NotificationType"));                                  -- 19 values, last = PIPELINE
SELECT tablename, tableowner FROM pg_tables WHERE tablename LIKE 'pipeline\_%' ORDER BY 1;  -- 5 rows, owner = app role
SELECT count(*) FROM notifications WHERE type = 'PIPELINE';                           -- 0
SQL
curl -s -o /dev/null -w "health %{http_code}\n" https://api.digitalsukoon.com/v1/health    # still 200
```

**Drift inspection. Inspect only, NEVER apply** (spec §12 step 3.4):

```bash
cd /opt/dashmani-platform/packages/db
npx prisma migrate diff --from-url "$DBURL" --to-schema-datamodel /root/pipeline-m1/schema.prisma --script \
  | tee /root/pipeline-m1/drift.sql
```

The only statement allowed in `drift.sql` is the known hand-built index:
- `DROP INDEX "link_metrics_emp_url_fetched_ok_v2_idx";`
- plus, **if P14 was built**, the same line for `notifications_user_id_created_at_idx`.

**No `pipeline_*` statement may appear.** If anything else appears, do **not** merge; investigate first.

⚠️ **From this moment until PR 5 merges, nobody may run `prisma db push` against prod** from `main` or any other branch whose schema lacks these models. The rehearsal showed what such a push would do:
- drop all five pipeline tables;
- rebuild `NotificationType` via `ALTER TABLE "notifications" ALTER COLUMN "type" TYPE …`. That is a full rewrite of `notifications` under an `ACCESS EXCLUSIVE` lock, which stalls every bell and every notification write while it runs.

The standing rule "never a blanket `db:push` on prod" covers this. It is repeated here because this window is when it is most tempting.

## 5. Healthy after the apply

Repeat the 2b commands. Health must be 200, all apps online, and the error count not above `BASE_ERR`.
- The running API still uses a client generated without the new models. That is expected and harmless: it never queries them, and no `PIPELINE` row exists.

**Read-only canaries.** Use a designated test account, such as `tabish@dashmani.com`. Do **not** submit a report on prod just to test.
- Login (internal + HR) succeeds.
- HR `GET /v1/hr/reports/today` returns 200.
- Link History (`GET /v1/hr/reports`) returns 200.
- Internal accounts (`GET /v1/accounts`) returns 200.

## 6. Merge and deploy (owner approval #2)

- [ ] Ask the owner for approval #2. Merge only in the same window, and only after Steps 3–5 are green.
- [ ] Merge PR 5. This is a non-docs change, so the deploy runs `db:generate` (the new client includes the models) and restarts the five apps one by one. `deploy.sh` does **not** run `db:push`, and must not.
- [ ] Watch the deploy in GitHub Actions (about 3 min). Then check:

```bash
curl -s https://api.digitalsukoon.com/v1/health     # {"success":true,...}
ssh dashmani-prod 'cd /opt/dashmani-platform && git rev-parse --short HEAD'       # the merge commit
ssh dashmani-prod 'pm2 status'
ssh dashmani-prod 'pm2 logs api --lines 3000 --nostream 2>&1 | grep -E "PrismaClientValidationError|does not exist|P2024"'
```

The last grep must show **zero hits** stamped after the restart. pm2 lines carry timestamps, so compare them with the deploy time.
- Re-run the Step 5 canaries.
- Record the API RSS from `pm2 status`, for comparison with the baseline.

## 7. Rollback and abandon

- **Before merge, tables applied:** leave them. They are empty and unused, and the app ignores them.
  - To remove them anyway, run `DROP TABLE pipeline_messages, pipeline_participants, pipeline_projects, pipeline_phases, pipeline_board_state;` in one transaction. They hold no data.
  - `PIPELINE` **stays in the enum forever**. Postgres cannot remove an enum value, and nothing writes it.
- **After merge:** never revert PR 5 (spec §12 rollback). A client generated without `PIPELINE` may fail on such rows (see the P10 result). Later PRs ship dark behind `pipeline.mode`; the kill switch is how the feature is turned off.
- **After any DB restore:** re-check the Step 4 verification. The DDL can be re-run safely; it is idempotent.

---

## Rehearsal record (local, 2026-09-28, PG 16.14 in `dashmani-db`)

Scratch DB `dashmani_t_ddl`, built by `prisma db push` from `origin/main` (`20564db`) `schema.prisma`: 67 tables, 18 enum values. One `users` row and one `notifications` row stood in for existing data.

1. **Lock-timeout abort.** A second session held `ROW EXCLUSIVE` on `users` (`BEGIN; UPDATE users SET name = name WHERE false; SELECT pg_sleep(8)`) while the script ran.
   - Result: `ERROR: canceling statement due to lock timeout` on the first `users` FK, after 3 s. psql exit 3.
   - Afterwards: 0 `pipeline_*` tables and no `PIPELINE` value. The rollback was complete.
2. **Apply #1.** Exit 0. Output: `ALTER TYPE`, 5 `CREATE TABLE`, 14 `CREATE INDEX`, 8 `DO`, `INSERT 0 1`, `INSERT 0 7`, `COMMIT`.
   - 7 phases seeded (only `done` terminal), and the board row `(1, 0, utc now)`.
   - Existing `users` and `notifications` rows unchanged.
3. **Apply #2.** Exit 0, with no `ERROR` or `WARNING`.
   - 20 `already exists, skipping` notices: 1 enum value, 5 tables and 14 indexes.
   - Both inserts `INSERT 0 0`.
   - `pg_dump --schema-only` identical to the dump after apply #1, apart from pg_dump's per-dump random `\restrict` token. Phase and board rows identical, timestamps included.
4. **Drift.** `prisma migrate diff --from-url <scratch> --to-schema-datamodel packages/db/prisma/schema.prisma` printed `-- This is an empty migration.`
5. **Reverse diff** (scratch DB against the `origin/main` schema). It showed the table drops and the `notifications.type` enum rebuild described in Step 4. That is the evidence for the no-`db push` warning.
6. The §12 safety grep printed nothing on both the generated and the hand-edited script. `apps/api/tests/pipeline/ddl-script.test.ts` locks these rules for any later edit.
7. The scratch DB was dropped afterwards.
