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
- The apply window runs **no full database dump**. The only dump inside it is schema-only, which takes seconds. The full backup is the recent scheduled weekly one, checked read-only in Step 0.

---

## 0. Preconditions (all must hold)

- [ ] It is a **working weekday** (Mon–Sat), inside **11:00–12:30 IST** or **14:30–16:00 IST**.
  - Never 09:00–10:00 (login rush). Never 17:30–00:30 (HR submit rush).
- [ ] PR 5 is reviewed, and CI is green on its head commit. Record that head SHA as `$PR5_SHA`.
  - CI includes the "Rehearse the pipeline DDL script" step. It executes the script twice on a scratch database and requires no Prisma drift, so a green run means every statement in it has actually run.
- [ ] The P10 sandbox result is recorded in `.planning/PIPELINE-P9-BASELINE.md`. It is the rollback evidence for the permanent enum value (spec §12, sequence step 2).
- [ ] **A recent full backup exists.** The scheduled weekly `scripts/backup.sh` run (crontab, Sunday 02:00 UTC = 07:30 IST, a quiet hour) succeeded within the last 7 days. The check is read-only and runs no dump:

  ```bash
  ssh dashmani-prod
  LAST_OK=$(grep -oE '\[[0-9]{8}_[0-9]{6}\] BACKUP OK' /var/log/dashmani-backup.log | tail -1 | tr -dc '0-9_')
  echo "last BACKUP OK: ${LAST_OK:-none}"
  find /opt/backups/dashmani -maxdepth 1 -name "db_${LAST_OK}.sql.gz" -mtime -7 -size +1M | grep -q . \
    && echo FULL-BACKUP-RECENT-OK || echo "STOP: no successful full backup in the last 7 days"
  ```

  If it prints `STOP`, do not start a dump in the business window. Either wait for the next Sunday run, or ask the owner to approve a fresh full backup **the night before** (see "Full backup, only if Step 0 says STOP" below).
- [ ] The owner has given approval #1 (apply).

### Full backup: why it never runs in a business window

`scripts/backup.sh` runs `nice -n 19 ionice -c3 pg_dump … | nice -n 19 gzip`. That lowers the priority of the **pg_dump client and gzip only**:
- The Postgres backend that executes the dump's `COPY` is a separate server process. It runs at normal CPU and I/O priority.
- It reads every table, including about 10–11 GB of `link_metrics` (as of 2026-09-19), through the page cache of a 2 GB, 1-vCPU box. That evicts the indexes the portals depend on.
- The dump holds **one snapshot for its whole duration**. Until it ends, vacuum cannot clean up after the tables the insights sweep writes continuously (`link_metrics`, `link_metrics_latest`).
- The same script then tars `uploads/` with no `nice` or `ionice` at all.

This DDL is additive and single-transaction. Its rollback is `DROP TABLE` (§7), never a data restore, so a full dump adds no rollback capability for this change. The schema-only dump in Step 2c plus the recent weekly full backup are enough.

### Full backup, only if Step 0 says STOP (owner-approved, the night before)

Start it inside **01:00–05:00 IST**, early enough that it finishes by 06:00 IST. Never run it in 17:30–00:30 (the submit rush) or 09:00–10:00 (the login rush). To estimate how long it takes, subtract the timestamp in the newest `manifest_*.txt` name from that file's modification time: that is how long the Sunday run took. If it would not finish by 06:00 IST, wait for the next Sunday run instead.

```bash
ssh dashmani-prod
mkdir -p /root/pipeline-m1
# 1. Disk. The dump lands on the same disk as Postgres, and backup.sh deletes the oldest of
#    its 8 sets only AFTER it has written the new one. Size it from the LARGEST retained dump:
#    a failed run can leave a small partial file as the newest. No previous dump: stop and ask.
df -h /opt/backups/dashmani
LARGEST=$(ls -1S /opt/backups/dashmani/db_*.sql.gz | head -1)
NEED_KB=$(( $(stat -c%s "$LARGEST") * 2 / 1024 ))
AVAIL_KB=$(df --output=avail -k /opt/backups/dashmani | tail -1 | tr -d ' ')
echo "need more than ${NEED_KB} KB free, have ${AVAIL_KB} KB"
[ "$AVAIL_KB" -gt "$NEED_KB" ] && echo DISK-OK || echo "STOP: not enough free disk for a full dump"

# 2. Only after DISK-OK. nohup, so a dropped SSH session cannot kill the dump half-way.
nohup bash /opt/dashmani-platform/scripts/backup.sh > /root/pipeline-m1/backup.log 2>&1 &

# 3. Before the apply window opens:
grep -q "BACKUP OK" /root/pipeline-m1/backup.log && echo FULL-BACKUP-OK
```

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

**2c. Backup** (spec §12: the `scripts/backup.sh` URL extraction and `pipefail` from 2a, not `pre-deploy-backup.sh`). Inside the window this is a **schema-only** dump. The full backup is the Step 0 check; see "Full backup: why it never runs in a business window".

```bash
# Schema-only dump: seconds, negligible load. --lock-wait-timeout makes pg_dump give up
# instead of queueing if a table lock is not granted within 5 s.
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > /root/pipeline-m1/pre-ddl-schema.sql
test -s /root/pipeline-m1/pre-ddl-schema.sql && echo SCHEMA-DUMP-OK
```

**Never** run the full `scripts/backup.sh` here. The DDL adds objects only, so any failure is a rollback, never a data rewrite.

**2d. Read-only DB checks.** Each line states the expected result.

```bash
psql "$DBURL" -At <<'SQL'
SHOW server_version;                                                          -- >= 13 (gen_random_uuid is built in)
SELECT current_user;                                                          -- the app role, e.g. dashmani
SELECT current_schema();                                                      -- public (the script also pins it)
SELECT typowner::regrole = current_user::regrole FROM pg_type WHERE typname = 'NotificationType';  -- t
SELECT tableowner = current_user FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';  -- t
SELECT has_schema_privilege('public', 'CREATE');                              -- t
SELECT has_table_privilege('public.users', 'REFERENCES');                     -- t
SELECT count(*) FROM pg_tables WHERE tablename LIKE 'pipeline\_%';           -- 0 (first apply; any schema)
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
- 2c did not print `SCHEMA-DUMP-OK`, or Step 0 did not print `FULL-BACKUP-RECENT-OK` (or, after an owner-approved night-before run, `FULL-BACKUP-OK`);
- `current_schema()` is not `public`. The script pins `public` itself, but the other checks here would then be reading another schema;
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

**Expected output:** `BEGIN`, 3× `SET` (lock_timeout, statement_timeout, search_path), `ALTER TYPE`, 5× `CREATE TABLE`, 14× `CREATE INDEX`, 4× `DO`, `INSERT 0 1`, `INSERT 0 7`, 4× `DO`, `COMMIT`. The whole run takes well under a second.

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
SELECT schemaname, tablename, tableowner FROM pg_tables WHERE tablename LIKE 'pipeline\_%' ORDER BY 2;  -- 5 rows, schema public, owner = app role
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
- **After any DB restore:** re-run the Step 4 verification first. Re-run the DDL **only if an object is actually missing**.
  - It is idempotent for data, but a re-run is **not lock-free**. Each of its 14 `CREATE INDEX IF NOT EXISTS` statements takes a `SHARE` lock on its table *before* it discovers the index exists, and holds it until `COMMIT` (measured in the rehearsal below). `CREATE TABLE IF NOT EXISTS` and the FK guards take no lock on an existing table.
  - On a live pipeline, that blocks every write to `pipeline_phases`, `pipeline_projects`, `pipeline_participants` and `pipeline_messages` for the rest of the transaction, including the per-sync read-state update. Each statement can also wait up to the 3 s `lock_timeout` behind in-flight pipeline writers, while new writers queue behind it. Pipeline writers run with a 1 s `lock_timeout` (spec §8.3), so they would answer 503.
  - So if the feature is live, first set `pipeline.mode=off` (the kill switch takes effect within 15 s). Re-run outside 09:00–10:00 and 17:30–00:30 IST, then restore the mode. Until PR 6 ships, nothing touches these tables, so there is nothing to switch off.

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

## Re-rehearsal after the review fixes (local, 2026-09-28, PG 16.14 in `dashmani-db`)

The script now pins `search_path` to `public`, and each FK guard checks `conname` **and** `conrelid`. Column and index text is unchanged.

1. **The search_path trap, reproduced.** Scratch DB built from the `origin/main` (`20564db`) schema, with one `users` row, plus `CREATE SCHEMA "user"` (a schema named after the local app role, so psql's default `"$user", public` path picks it first).
   - Pre-fix script: exit 0, and **all 5 tables landed in schema `user`**, not `public`.
   - Fixed script: exit 0, all 5 tables in `public`, schema `user` empty.
2. **Apply #1** (fixed script): `ALTER TYPE`, 5 `CREATE TABLE`, 14 `CREATE INDEX`, 8 `DO`, `INSERT 0 1`, `INSERT 0 7`, `COMMIT`. 7 phases (only `done` terminal), board row `(1, 0, utc now)`, 8 FKs.
3. **Apply #2:** exit 0, no `ERROR` or `WARNING`. 20 `already exists, skipping` notices and both inserts `INSERT 0 0`. The `pg_dump --schema-only` output was identical to the one after apply #1, apart from the per-dump `\restrict` token. The phase rows were identical, timestamps included.
4. **Drift:** `prisma migrate diff --from-url <scratch> --to-schema-datamodel packages/db/prisma/schema.prisma` printed `-- This is an empty migration.`; with `--exit-code` it exited 0.
5. **Re-run locks** (the §7 rule), probed on the applied DB inside a transaction:
   - `CREATE INDEX IF NOT EXISTS` on an existing index printed "already exists, skipping", yet `pg_locks` showed `ShareLock` on the table.
   - `CREATE TABLE IF NOT EXISTS` plus an FK guard: no lock on the table.
6. **The CI step's exact `run:` body**, run locally against the `dashmani-db` container with only the scratch database names changed:
   - It exited 0. Apply #1 printed 1 notice: the enum value exists because `db push` built it, so every CREATE, index, FK and seed path ran. Apply #2 printed 20.
   - With one column type typo'd (`TIMESTAMPP(3)`), it stopped at apply #1 with `ERROR: type "timestampp" does not exist`.
   - With one index dropped after the apply, `migrate diff --exit-code` returned 2.
7. The scratch DBs were dropped afterwards.
