# Pipeline email: production runbook (`feat/pipeline-email`)

**What ships.** Pipeline EMAIL notifications (owner request 2026-09-30): an email when the phase of a project you are part of changes, when you are @mentioned, when a deadline is approaching (the existing due-soon rule), and when a deadline is set, changed or removed. Plus the in-portal bell row for a due-date change (`metadata.kind = "due_changed"`).

- **Enqueue**: one `INSERT … SELECT` into `pipeline_email_outbox` inside the action's own transaction (`services/pipeline/email-outbox.ts`). Pending rows coalesce per (recipient, project, kind).
- **Send**: `cron/pipeline-email.cron.ts`, a tick every 60 s from 4 min after boot. One digest per recipient, ≤ 30 emails per tick, `PIPELINE_EMAIL_DAILY_CAP` (default 300) per IST day. It sends outside any DB transaction and holds no bulkhead slot while it does.

**It ships dark.** Nothing is queued and nothing is sent until **all four** hold:
1. `pipeline.mode` is `pilot` or `on`;
2. `pipeline.email = on` (this runbook, Step 5);
3. `SMTP_USER` and `SMTP_PASS` are set in `apps/api/.env`;
4. the boot self-check finds `pipeline_email_outbox` **and** its partial unique index (Step 2).

If the DDL is missing, email stays off and the log says so once (`EMAIL SCHEMA CHECK FAILED`). The board, the bell and every pipeline action keep working. A missing outbox can never fail an action's transaction.

**The DDL is additive.** `scripts/pipeline-email-ddl.sql` creates one new empty table, 3 indexes and 2 FKs, in one transaction with `lock_timeout 3s`.
- The only locks on existing tables are brief `SHARE ROW EXCLUSIVE` locks taken by the two FKs, on `pipeline_projects` and then `users`, held until `COMMIT` (milliseconds). They block writes to those tables, not reads such as login.
- `prisma migrate diff` shows no drift afterwards. Prisma cannot express the partial index and ignores it on introspection, so it is not drift.
- Rehearsed locally on 2026-09-30 (PG 16.14 in `dashmani-db`), and on every CI run: see "Rehearsal record" below.

**Who approves.** The owner says yes before Step 3 (apply), before Step 4 (merge) and before Step 5 (enable). Nobody does any of them on an agent's word.

---

## 0. Preconditions

- [ ] A **working weekday** (Mon–Sat), inside **11:00–12:30 IST** or **14:30–16:00 IST**. Never 09:00–10:00 (the login rush) or 17:30–00:30 (the HR submit rush).
- [ ] The PR is reviewed and CI is green on its head commit, including **"Rehearse the pipeline DDL scripts"**. That step applies both DDL scripts twice on a scratch database, checks the partial index and requires no Prisma drift.
- [ ] A recent full backup exists (read-only check, no dump):

  ```bash
  ssh dashmani-prod
  LAST_OK=$(grep -oE '\[[0-9]{8}_[0-9]{6}\] BACKUP OK' /var/log/dashmani-backup.log | tail -1 | tr -dc '0-9_')
  echo "last BACKUP OK: ${LAST_OK:-none}"
  find /opt/backups/dashmani -maxdepth 1 -name "db_${LAST_OK}.sql.gz" -mtime -7 -size +1M | grep -q . \
    && echo FULL-BACKUP-RECENT-OK || echo "STOP: no successful full backup in the last 7 days"
  ```

  On `STOP`, do not start a full dump in a business window. Follow "Full backup, only if Step 0 says STOP" in `2026-09-26-pipeline-ddl-runbook.md`. The rollback of this DDL never needs a restore (§7), but the rule stands.
- [ ] SMTP and the link base are configured on the box. This prints counts, never the secret:

  ```bash
  cd /opt/dashmani-platform
  grep -c '^SMTP_USER=.\+' apps/api/.env; grep -c '^SMTP_PASS=.\+' apps/api/.env   # both must print 1
  grep -cE '^HR_APP_URL="?https://hr\.digitalsukoon\.com/?"?$' apps/api/.env    # must print 1
  ```

  - If an SMTP line prints `0`, stop and ask the owner for the SMTP details.
  - If `HR_APP_URL` prints `0`, add `HR_APP_URL=https://hr.digitalsukoon.com`. Every link in a pipeline email is built from it, and its fallback is `http://localhost:3002`. In production the worker refuses to send without it (the log says `HR_APP_URL is not set`), so this is a hard precondition, not a nicety.
  - Put any of them only in `apps/api/.env`, which `deploy.sh` does not touch, then run `pm2 restart api` on its own.

## 1. Stage the reviewed script on the box

```bash
ssh dashmani-prod
cd /opt/dashmani-platform
git fetch origin feat/pipeline-email
git show origin/feat/pipeline-email:scripts/pipeline-email-ddl.sql > /root/pipeline-email-ddl.sql
sha256sum /root/pipeline-email-ddl.sql   # must match the reviewed file's hash
```

## 2. Pre-flight (read-only)

**2a. Get the DB URL** the same way as `2026-09-26-pipeline-ddl-runbook.md` step 2a (and `scripts/backup.sh`): grep the line rather than `source` the file, then strip the quotes and the Prisma-only query string, which libpq rejects.

```bash
set -o pipefail
DBURL=$(grep -hE '^DATABASE_URL=' /opt/dashmani-platform/apps/api/.env /opt/dashmani-platform/.env 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || { echo "no DATABASE_URL"; exit 1; }
```

⚠️ **Every statement in this runbook connects as this role** (the `dashmani` app role), except the one ownership repair in step 4. **Never apply the DDL with `sudo -u postgres psql`.**
- A table created by `postgres` is owned by `postgres`. The app role then cannot read it, so the boot self-check fails, email stays off, and the log shows `EMAIL SCHEMA CHECK FAILED`.
- Every later Prisma DDL on that table fails with `must be owner` (the documented table-ownership incident).
- CI cannot catch this: its rehearsal applies the script as the container's own role.

**2b. Read-only checks.** Each line states the expected result.

```bash
psql "$DBURL" -At <<'SQL'
SELECT current_user;                                                            -- the app role, e.g. dashmani
SELECT current_schema();                                                        -- public (the script also pins it)
SELECT tableowner = current_user FROM pg_tables
 WHERE schemaname = 'public' AND tablename IN ('users', 'pipeline_projects') ORDER BY tablename;  -- t, t
SELECT has_schema_privilege('public', 'CREATE');                                -- t
SELECT has_table_privilege('public.users', 'REFERENCES');                       -- t
SELECT has_table_privilege('public.pipeline_projects', 'REFERENCES');           -- t
-- Nothing named like the new objects exists yet (both 0 on a first apply):
SELECT count(*) FROM pg_class WHERE relname LIKE 'pipeline_email_outbox%';      -- 0
SELECT count(*) FROM pg_constraint WHERE conname LIKE 'pipeline_email_outbox%'; -- 0
-- No long transaction is open (a writer on users would make the apply time out):
SELECT pid, state, now() - xact_start AS age, left(query, 80)
  FROM pg_stat_activity
 WHERE datname = current_database() AND xact_start < now() - interval '5 seconds'
   AND pid <> pg_backend_pid();                                                 -- ideally no rows
SQL
# Schema-only dump of the two referenced tables (seconds; gives up instead of queueing):
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s -t pipeline_projects -t users \
  > /root/pipeline-email-preflight-schema.sql && test -s /root/pipeline-email-preflight-schema.sql && echo SCHEMA-DUMP-OK
curl -s https://api.digitalsukoon.com/v1/health   # {"success":true,...}
```

**Stop, apply nothing, and investigate** if an ownership or privilege check prints `f`, `current_schema()` is not `public`, an outbox object already exists (diff it first: `IF NOT EXISTS` would silently skip a table of a different shape), the dump did not print `SCHEMA-DUMP-OK`, or a transaction older than a few seconds is open.

## 3. Apply (owner approval #1)

```bash
PGAPPNAME=pipeline-email-ddl psql "$DBURL" -v ON_ERROR_STOP=1 -f /root/pipeline-email-ddl.sql 2>&1 | tee /root/pipeline-email-apply.log
echo "exit=${PIPESTATUS[0]}"    # must be 0
```

- Success ends with `COMMIT`.
- On `canceling statement due to lock timeout` the whole script has rolled back. Nothing changed, so retry a few minutes later.
- On `must be owner` / `permission denied`: wrong role or a mis-owned object. Stop. **Never retry as `postgres`.**
- Run it only as written: it is idempotent, so a second run is a no-op.

## 4. Verify (read-only), then merge and deploy (owner approval #2)

```bash
psql "$DBURL" -Atc "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'pipeline_email_outbox'"
# must print the app role (the same value as `SELECT current_user` in 2b), NEVER postgres
psql "$DBURL" -Atc "SELECT indexdef FROM pg_indexes WHERE tablename = 'pipeline_email_outbox' ORDER BY indexname"
# Expect 4 indexes. pipeline_email_outbox_pending_key must end with
#   WHERE ((status)::text = 'pending'::text)
psql "$DBURL" -Atc "SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'pipeline_email_outbox'::regclass AND contype = 'f' ORDER BY 1"
# pipeline_email_outbox_project_id_fkey|c  and  pipeline_email_outbox_user_id_fkey|c
cd /opt/dashmani-platform
git show origin/feat/pipeline-email:packages/db/prisma/schema.prisma > /root/pipeline-email-schema.prisma
npx prisma migrate diff --from-url "$DBURL" \
  --to-schema-datamodel /root/pipeline-email-schema.prisma --exit-code | head -20; echo "exit=${PIPESTATUS[0]}"
# exit=0, or only the long-known non-pipeline drift. NO line may mention pipeline_email_outbox.
```

**If the owner check prints `postgres`** (the table was created by the wrong role), fix the ownership — this is the one statement that runs as `postgres`, because only a superuser or the current owner can change it — then restart the API so the self-check re-probes at once:

```bash
sudo -u postgres psql -d dashmani_prod -c 'ALTER TABLE pipeline_email_outbox OWNER TO dashmani'   # indexes and FKs follow the table
psql "$DBURL" -Atc "SELECT tableowner FROM pg_tables WHERE tablename = 'pipeline_email_outbox'"    # now the app role
pm2 restart api
```

Then merge the PR. CI deploys it, and there is **no `db:push`**: the DDL above is the whole schema change. After the deploy, the boot log must show the pipeline self-check passing and **no** `EMAIL SCHEMA CHECK FAILED` line:

```bash
pm2 logs api --lines 200 --nostream | grep -E 'schema self-check|EMAIL SCHEMA'
```

## 5. Enable (owner approval #3)

The flag script is a dry run by default. Writing needs `--apply --confirm-prod`.

```bash
cd /opt/dashmani-platform/packages/db
npx tsx ../../scripts/pipeline-flag.ts                                   # current state
npx tsx ../../scripts/pipeline-flag.ts --email=on                        # dry run: BEFORE / AFTER
npx tsx ../../scripts/pipeline-flag.ts --email=on --apply --confirm-prod # live within 15 s
```

In pilot mode only pilot users receive email, exactly like the bell. To test end to end, a pilot user @mentions another pilot user. The email should arrive about 2 minutes later, after the mention's settle delay.

**Watch the first hour:**

```bash
pm2 logs api --lines 500 --nostream | grep -E '\[pipeline-email\]|\[pipeline\] stats'
# [pipeline-email] emails=… failed=… rows=… skipped=…  (logged only when a tick did something)
# hourly stats: … email_queued=… emails_sent=… emails_failed=… email_skipped=…
psql "$DBURL" -Atc "SELECT status, count(*) FROM pipeline_email_outbox GROUP BY 1 ORDER BY 1"
psql "$DBURL" -Atc "SELECT last_error, count(*) FROM pipeline_email_outbox WHERE status IN ('failed','skipped') GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
```

(`DBURL` from step 2a.)

- `failed` rows carry the SMTP error in `last_error`, never a password. A recipient the mail server refuses for good (a 5xx at `RCPT TO`, e.g. `5.1.1`) is failed at once, without retries.
- Skipped rows are normal: a net-zero move, a deleted mention, an unfollow.
- `SMTP unavailable (account: …)` or `(limit: …)` means the shared Gmail account itself is being refused (a `421`, a refused `MAIL FROM`, a `4.7.x`/`5.7.x` status, or the `5.4.5` daily limit). The worker then pauses all sending for 15 min (60 min for the daily limit) instead of trying every recipient. If it repeats, password resets from the same account are affected too: check the account before re-enabling.
- A recipient who was just emailed waits at least 10 minutes for the next one; anything that arrives meanwhile folds into that next digest.

## 6. Kill switch

```bash
cd /opt/dashmani-platform/packages/db
npx tsx ../../scripts/pipeline-flag.ts --email=off --apply --confirm-prod
```

- Within 15 s (the settings memo) nothing more is queued and the worker stops sending — including a tick that is already running, which checks the setting before every message. It finishes the one message already mid-send; the rest of that tick goes back to pending untouched.
- The bell is unaffected.
- Pending rows stay pending. If email is turned back on more than a day later, they are skipped as stale, never sent late.
- The bigger switch, `--mode=off`, pauses the whole pipeline, email included.

## 7. Rollback

Normally the kill switch (Step 6) is the rollback, and the table stays. It is small and self-trimming: sent, skipped and failed rows older than 30 days go in the 04:00 IST maintenance run.

⚠️ **Never remove the table while `pipeline.email = on`.** The running API caches its schema verdict. An enqueue into a missing table would fail that action's transaction.

To remove the table anyway:
1. Run Step 6.
2. Wait 30 s.
3. `psql "$DBURL" -c 'DROP TABLE pipeline_email_outbox'` as the app role, which owns it (this table only; nothing references it).
4. Run `pm2 restart api`, so the self-check re-evaluates and turns email off.

---

## Rehearsal record (local, 2026-09-30, PG 16.14 in `dashmani-db`)

- **CI shape** (scratch DB):
  1. Build the full new schema with `db push`.
  2. Drop the six pipeline tables.
  3. Apply `pipeline-ddl.sql` twice, then `pipeline-email-ddl.sql` twice.
  - Result: 7 phases, 1 board row, the partial index's `indexdef` is exact, `prisma migrate diff --exit-code` = 0.
- **Prod shape** (scratch DB):
  1. `db push` of `origin/main`'s schema, which has the pipeline tables and no outbox, then `pipeline-ddl.sql`.
  2. Apply `pipeline-email-ddl.sql`: run #1 had 0 errors; run #2 had 0 errors and 4 "already exists, skipping" notices (a no-op).
  - Result: `prisma migrate diff` against the new `schema.prisma`: "No difference detected.", exit 0.
- **Verified the same day** on Prisma 5.22: `migrate diff` ignores a partial unique index both ways, and `db push` leaves it in place. That is why the index lives only in the DDL.
- **Test databases**: `db push` alone lacks the partial index. The email tests create it from this script's own statement (`ensurePipelineEmailSchema` in `tests/pipeline/pipeline-helpers.ts`).
