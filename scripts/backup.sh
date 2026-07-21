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
# =============================================================

set -eo pipefail

BACKUP_DIR="/opt/backups/dashmani"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
APP_DIR="/opt/dashmani-platform"
MAX_BACKUPS=8  # Keep last 8 backups (2 months of weekly)

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "[$TIMESTAMP] Starting backup..."

# 1. Database backup
echo "Backing up database..."
# Extract DATABASE_URL by grep, NOT `source`: the prod URL carries unquoted
# Prisma pool params (…?connection_limit=10&pool_timeout=20…) — sourcing that
# line backgrounds the assignment at the '&' and loses the variable. libpq also
# rejects those Prisma-only URI params outright, so strip the query string.
DATABASE_URL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
DATABASE_URL="${DATABASE_URL%%\?*}"

if [ -n "$DATABASE_URL" ]; then
  # Lowest CPU/IO priority — the weekly run is off-hours, but a manual run may
  # happen while users are on the site; the dump must never compete with them.
  nice -n 19 ionice -c3 pg_dump "$DATABASE_URL" --no-owner --no-privileges | nice -n 19 gzip > "$BACKUP_DIR/db_$TIMESTAMP.sql.gz"
  DB_SIZE=$(stat -c%s "$BACKUP_DIR/db_$TIMESTAMP.sql.gz")
  if [ "$DB_SIZE" -lt 1000000 ]; then
    echo "ERROR: database dump suspiciously small ($DB_SIZE bytes) — FAILED"
    exit 1
  fi
  echo "Database backup: $BACKUP_DIR/db_$TIMESTAMP.sql.gz ($DB_SIZE bytes)"
else
  echo "ERROR: DATABASE_URL not found — database backup FAILED"
  exit 1
fi

# 2. Uploads backup (profile pictures, documents, imports)
echo "Backing up uploads..."
if [ -d "$APP_DIR/uploads" ]; then
  tar -czf "$BACKUP_DIR/uploads_$TIMESTAMP.tar.gz" -C "$APP_DIR" uploads/
  echo "Uploads backup: $BACKUP_DIR/uploads_$TIMESTAMP.tar.gz"
fi

# 3. Environment files backup
echo "Backing up config files..."
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
cat > "$BACKUP_DIR/manifest_$TIMESTAMP.txt" << EOF
Backup Timestamp: $TIMESTAMP
Date: $(date)
Components:
  - Database: db_$TIMESTAMP.sql.gz
  - Uploads: uploads_$TIMESTAMP.tar.gz
  - Config: config_$TIMESTAMP.tar.gz
Sizes:
$(ls -lh "$BACKUP_DIR"/*_$TIMESTAMP* 2>/dev/null | awk '{print "  " $5 " " $9}')
EOF

# 5. Cleanup old backups (keep last MAX_BACKUPS sets)
echo "Cleaning up old backups..."
cd "$BACKUP_DIR"
for prefix in db uploads config manifest; do
  ls -1t ${prefix}_*.* 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm -f
done

# Greppable success marker — its ABSENCE in /var/log/dashmani-backup.log after a
# Sunday 02:00 UTC run means the backup failed; check the log. (The 2026 failure
# ran silent for 15 weeks because nothing asserted success.)
echo "[$TIMESTAMP] BACKUP OK"
echo "Backup location: $BACKUP_DIR"
ls -lh "$BACKUP_DIR"/*_$TIMESTAMP* 2>/dev/null
