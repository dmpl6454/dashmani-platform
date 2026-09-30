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
- [ ] SMTP is configured on the box. This prints counts, never the secret:

  ```bash
  cd /opt/dashmani-platform
  grep -c '^SMTP_USER=.\+' apps/api/.env; grep -c '^SMTP_PASS=.\+' apps/api/.env   # both must print 1
  ```

  If either prints `0`, stop and ask the owner for the SMTP details. Put them only in `apps/api/.env`, which `deploy.sh` does not touch, then run `pm2 restart api` on its own.

## 1. Stage the reviewed script on the box

```bash
ssh dashmani-prod
cd /opt/dashmani-platform
git fetch origin feat/pipeline-email
git show origin/feat/pipeline-email:scripts/pipeline-email-ddl.sql > /root/pipeline-email-ddl.sql
sha256sum /root/pipeline-email-ddl.sql   # must match the reviewed file's hash
```

## 2. Pre-flight (read-only)

```bash
# Nothing named like the new objects exists yet (both print 0 on a first apply):
sudo -u postgres psql -d dashmani_prod -Atc "SELECT count(*) FROM pg_class WHERE relname LIKE 'pipeline_email_outbox%'"
sudo -u postgres psql -d dashmani_prod -Atc "SELECT count(*) FROM pg_constraint WHERE conname LIKE 'pipeline_email_outbox%'"
# The tables it references exist:
sudo -u postgres psql -d dashmani_prod -Atc "SELECT to_regclass('public.pipeline_projects') IS NOT NULL, to_regclass('public.users') IS NOT NULL"
# Schema-only dump of the two referenced tables (seconds; gives up instead of queueing):
sudo -u postgres pg_dump --schema-only --lock-wait-timeout=5000 -t pipeline_projects -t users dashmani_prod \
  > /root/pipeline-email-preflight-schema.sql && echo SCHEMA-DUMP-OK
curl -s https://api.digitalsukoon.com/v1/health   # {"success":true,...}
```

## 3. Apply (owner approval #1)

```bash
sudo -u postgres psql -d dashmani_prod -v ON_ERROR_STOP=1 -f /root/pipeline-email-ddl.sql
```

- Success ends with `COMMIT`.
- On `canceling statement due to lock timeout` the whole script has rolled back. Nothing changed, so retry a few minutes later.
- Run it only as written: it is idempotent, so a second run is a no-op.

## 4. Verify (read-only), then merge and deploy (owner approval #2)

```bash
sudo -u postgres psql -d dashmani_prod -Atc "SELECT indexdef FROM pg_indexes WHERE tablename = 'pipeline_email_outbox' ORDER BY indexname"
# Expect 4 indexes. pipeline_email_outbox_pending_key must end with
#   WHERE ((status)::text = 'pending'::text)
sudo -u postgres psql -d dashmani_prod -Atc "SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'pipeline_email_outbox'::regclass AND contype = 'f' ORDER BY 1"
# pipeline_email_outbox_project_id_fkey|c  and  pipeline_email_outbox_user_id_fkey|c
cd /opt/dashmani-platform
git show origin/feat/pipeline-email:packages/db/prisma/schema.prisma > /root/pipeline-email-schema.prisma
npx prisma migrate diff --from-url "$(grep '^DATABASE_URL=' apps/api/.env | cut -d= -f2-)" \
  --to-schema-datamodel /root/pipeline-email-schema.prisma --exit-code | head -20; echo "exit=${PIPESTATUS[0]}"
# exit=0, or only the long-known non-pipeline drift. NO line may mention pipeline_email_outbox.
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
sudo -u postgres psql -d dashmani_prod -Atc "SELECT status, count(*) FROM pipeline_email_outbox GROUP BY 1 ORDER BY 1"
sudo -u postgres psql -d dashmani_prod -Atc "SELECT last_error, count(*) FROM pipeline_email_outbox WHERE status IN ('failed','skipped') GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
```

- `failed` rows carry the SMTP error in `last_error`, never a password.
- Skipped rows are normal: a net-zero move, a deleted mention, an unfollow.

## 6. Kill switch

```bash
cd /opt/dashmani-platform/packages/db
npx tsx ../../scripts/pipeline-flag.ts --email=off --apply --confirm-prod
```

- Within 15 s nothing more is queued and the worker stops sending. It finishes any message already mid-send.
- The bell is unaffected.
- Pending rows stay pending. If email is turned back on more than a day later, they are skipped as stale, never sent late.
- The bigger switch, `--mode=off`, pauses the whole pipeline, email included.

## 7. Rollback

Normally the kill switch (Step 6) is the rollback, and the table stays. It is small and self-trimming: sent, skipped and failed rows older than 30 days go in the 04:00 IST maintenance run.

⚠️ **Never remove the table while `pipeline.email = on`.** The running API caches its schema verdict. An enqueue into a missing table would fail that action's transaction.

To remove the table anyway:
1. Run Step 6.
2. Wait 30 s.
3. `sudo -u postgres psql -d dashmani_prod -c 'DROP TABLE pipeline_email_outbox'` (this table only; nothing references it).
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
