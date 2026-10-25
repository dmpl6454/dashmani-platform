#!/bin/bash
# =============================================================
# Digital Sukoon - Automated Backup Script
# Weekly database backup + file backup
# Setup: Add to crontab: 0 2 * * 0 bash /opt/dashmani-platform/scripts/backup.sh
#   (invoke via `bash` — deploys run `git reset --hard`, which resets file modes
#    to what git records; if the exec bit ever regresses, direct invocation
#    silently fails with "Permission denied" forever, which is exactly what
#    happened May 24 – Jul 19 2026. The bit IS committed now, but `bash` makes
#    the crontab immune either way.)
#
# 2026-10-25 incident: the Sunday dump consumed the last byte of the 49 GB disk
# (8 retained dumps × 1.7 GB, pruned only AFTER the new one was written), Postgres
# hit ENOSPC mid-write, PANICked, and could not finish crash recovery until space
# was freed by hand — every portal was down for 6.5 h. Hence the preflight below:
# the dump must never be the thing that fills the disk, and a failed run must
# never leave a partial dump behind pretending to be a backup.
# =============================================================

set -eo pipefail

# Every path/knob is env-overridable so the script can be exercised against a
# scratch directory and a local database (see the PR that added the preflight).
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/dashmani}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
MAX_BACKUPS="${MAX_BACKUPS:-4}"  # Keep last 4 weekly sets (one month). Was 8 — at 1.7 GB a dump that was 14 GB of a 49 GB disk.
# Space Postgres must keep for itself while the dump runs (WAL, temp files,
# checkpoints). A dump that leaves less than this is refused.
MIN_HEADROOM_BYTES="${MIN_HEADROOM_BYTES:-$((1024 * 1024 * 1024))}"  # 1 GiB
# A dump below this is treated as a failure (the pre-2026 silent-failure mode
# produced tiny files). Overridable only so a small local database can be dumped
# in a test run.
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-1000000}"

# ---- helpers ---------------------------------------------------------------

# Free bytes on the filesystem holding $BACKUP_DIR (POSIX df, works on GNU and BSD).
avail_bytes() {
  df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4 * 1024}'
}

fmt_gb() {
  awk -v b="$1" 'BEGIN { printf "%.2f GB", b / 1073741824 }'
}

# Keep the newest $1 sets of each component, delete the rest. nullglob matters:
# with `set -eo pipefail`, a prefix that matches nothing hands `ls` a literal
# pattern, `ls` exits 1, and the whole run aborts AFTER the dump was taken.
prune_to() {
  local keep=$1 prefix files
  (
    cd "$BACKUP_DIR"
    shopt -s nullglob
    for prefix in db uploads config manifest; do
      files=( "${prefix}"_*.* )
      [ "${#files[@]}" -gt "$keep" ] || continue
      # shellcheck disable=SC2012
      ls -1t "${files[@]}" | tail -n +$((keep + 1)) | xargs -r rm -f
    done
  )
}

# Bytes that prune_to "$1" would delete (newest $1 sets kept per component).
prunable_bytes() {
  local keep=$1 total=0 f prefix files
  for prefix in db uploads config manifest; do
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      total=$(( total + $(wc -c < "$BACKUP_DIR/$f" | tr -d ' ') ))
    done < <(
      cd "$BACKUP_DIR" && shopt -s nullglob && files=( "${prefix}"_*.* ) \
        && [ "${#files[@]}" -gt "$keep" ] && ls -1t "${files[@]}" | tail -n +$((keep + 1))
    )
  done
  echo "$total"
}

# How much space this run needs: the larger of (last dump × 1.25) and
# (live database size ÷ 5 — dumps compress to ~12% of the DB on this estate,
# 20% is a safe ceiling), plus the Postgres headroom. Either estimate may be
# unavailable (first run; psql hiccup) — whichever is known wins.
estimate_needed_bytes() {
  local last_dump last_bytes=0 db_bytes=0 est
  # shellcheck disable=SC2012
  last_dump=$(ls -1t "$BACKUP_DIR"/db_*.sql.gz 2>/dev/null | head -1 || true)
  if [ -n "$last_dump" ]; then
    last_bytes=$(wc -c < "$last_dump" | tr -d ' ')
  fi
  if [ -n "$DATABASE_URL" ]; then
    db_bytes=$(psql "$DATABASE_URL" -Atc "select pg_database_size(current_database())" 2>/dev/null || echo 0)
    db_bytes=${db_bytes:-0}
  fi
  est=$(( last_bytes * 5 / 4 ))
  if [ $(( db_bytes / 5 )) -gt "$est" ]; then est=$(( db_bytes / 5 )); fi
  echo $(( est + MIN_HEADROOM_BYTES ))
}

# A run that dies before the success marker must not leave a half-written dump
# behind: a truncated .sql.gz looks like a backup, sits in the retention window,
# and is unrestorable. (2026-10-25 left exactly such a 1.7 GB file.)
BACKUP_DONE=""
CREATED=()   # only files THIS run wrote — never a glob, so a sibling run's files are safe
cleanup_partial() {
  local rc=$? f
  if [ -z "$BACKUP_DONE" ]; then
    echo "[$TIMESTAMP] BACKUP FAILED (exit $rc) — removing partial files for this run"
    for f in "${CREATED[@]}"; do rm -f "$f"; done
  fi
}
trap cleanup_partial EXIT

# ---- run -------------------------------------------------------------------

mkdir -p "$BACKUP_DIR"

echo "[$TIMESTAMP] Starting backup..."

# Extract DATABASE_URL by grep, NOT `source`: the prod URL carries unquoted
# Prisma pool params (…?connection_limit=10&pool_timeout=20…) — sourcing that
# line backgrounds the assignment at the '&' and loses the variable. libpq also
# rejects those Prisma-only URI params outright, so strip the query string.
# BACKUP_DATABASE_URL is a test-only override; production never sets it.
DATABASE_URL="${BACKUP_DATABASE_URL:-$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)}"
DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
DATABASE_URL="${DATABASE_URL%%\?*}"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL not found — database backup FAILED"
  exit 1
fi

# 0. Disk preflight — refuse to be the thing that fills the disk.
NEEDED=$(estimate_needed_bytes)
AVAIL=$(avail_bytes)
echo "Disk preflight: $(fmt_gb "$AVAIL") free, need ~$(fmt_gb "$NEEDED") (dump estimate + $(fmt_gb "$MIN_HEADROOM_BYTES") Postgres headroom)"
if [ "$AVAIL" -lt "$NEEDED" ]; then
  # Degrade gracefully: drop the oldest set(s) so that AFTER this run we still
  # hold exactly MAX_BACKUPS sets — but only when that actually makes enough
  # room. Pruning and then failing anyway would delete a backup to make space
  # for a backup that never materialised: the worst of both.
  RECLAIMABLE=$(prunable_bytes $((MAX_BACKUPS - 1)))
  if [ $((AVAIL + RECLAIMABLE)) -ge "$NEEDED" ]; then
    echo "Low disk: pruning to $((MAX_BACKUPS - 1)) sets (oldest first) reclaims ~$(fmt_gb "$RECLAIMABLE") — pruning before dumping..."
    prune_to $((MAX_BACKUPS - 1))
    AVAIL=$(avail_bytes)
    echo "After pruning: $(fmt_gb "$AVAIL") free"
  else
    echo "Low disk: pruning the oldest set(s) would reclaim only ~$(fmt_gb "$RECLAIMABLE") — not enough, leaving them in place."
  fi
fi
if [ "$AVAIL" -lt "$NEEDED" ]; then
  echo "ERROR: only $(fmt_gb "$AVAIL") free, need ~$(fmt_gb "$NEEDED") — refusing to dump."
  echo "       A dump that fills the disk takes Postgres down with it (2026-10-25). Free space or enlarge the disk, then re-run."
  exit 1
fi

# 1. Database backup
echo "Backing up database..."
# Lowest CPU/IO priority — the weekly run is off-hours, but a manual run may
# happen while users are on the site; the dump must never compete with them.
CREATED+=("$BACKUP_DIR/db_$TIMESTAMP.sql.gz")
nice -n 19 ionice -c3 pg_dump "$DATABASE_URL" --no-owner --no-privileges | nice -n 19 gzip > "$BACKUP_DIR/db_$TIMESTAMP.sql.gz"
DB_SIZE=$(wc -c < "$BACKUP_DIR/db_$TIMESTAMP.sql.gz" | tr -d ' ')
if [ "$DB_SIZE" -lt "$MIN_DUMP_BYTES" ]; then
  echo "ERROR: database dump suspiciously small ($DB_SIZE bytes) — FAILED"
  exit 1
fi
echo "Database backup: $BACKUP_DIR/db_$TIMESTAMP.sql.gz ($DB_SIZE bytes)"

# 2. Uploads backup (profile pictures, documents, imports)
echo "Backing up uploads..."
if [ -d "$APP_DIR/uploads" ]; then
  CREATED+=("$BACKUP_DIR/uploads_$TIMESTAMP.tar.gz")
  tar -czf "$BACKUP_DIR/uploads_$TIMESTAMP.tar.gz" -C "$APP_DIR" uploads/
  echo "Uploads backup: $BACKUP_DIR/uploads_$TIMESTAMP.tar.gz"
fi

# 3. Environment files backup
echo "Backing up config files..."
CREATED+=("$BACKUP_DIR/config_$TIMESTAMP.tar.gz")
tar -czf "$BACKUP_DIR/config_$TIMESTAMP.tar.gz" \
  --ignore-failed-read \
  -C "$APP_DIR" \
  .env \
  apps/api/.env \
  packages/db/.env \
  packages/db/prisma/schema.prisma \
  2>/dev/null || true
echo "Config backup: $BACKUP_DIR/config_$TIMESTAMP.tar.gz"

# 4. Create combined manifest
echo "Creating backup manifest..."
CREATED+=("$BACKUP_DIR/manifest_$TIMESTAMP.txt")
cat > "$BACKUP_DIR/manifest_$TIMESTAMP.txt" << MANIFEST
Backup Timestamp: $TIMESTAMP
Date: $(date)
Components:
  - Database: db_$TIMESTAMP.sql.gz
  - Uploads: uploads_$TIMESTAMP.tar.gz
  - Config: config_$TIMESTAMP.tar.gz
Sizes:
$(ls -lh "$BACKUP_DIR"/*_$TIMESTAMP* 2>/dev/null | awk '{print "  " $5 " " $9}')
MANIFEST

# 5. Cleanup old backups (keep last MAX_BACKUPS sets)
echo "Cleaning up old backups..."
prune_to "$MAX_BACKUPS"

# Greppable success marker — its ABSENCE in /var/log/dashmani-backup.log after a
# Sunday 02:00 UTC run means the backup failed; check the log. (The 2026 failure
# ran silent for 15 weeks because nothing asserted success.)
BACKUP_DONE=1
echo "[$TIMESTAMP] BACKUP OK"
echo "Disk after backup: $(fmt_gb "$(avail_bytes)") free"
echo "Backup location: $BACKUP_DIR"
ls -lh "$BACKUP_DIR"/*_$TIMESTAMP* 2>/dev/null
