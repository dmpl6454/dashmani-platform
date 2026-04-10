#!/bin/bash
# =============================================================
# Digital Sukoon - Automated Backup Script
# Weekly database backup + file backup
# Setup: Add to crontab: 0 2 * * 0 /opt/dashmani-platform/scripts/backup.sh
# =============================================================

set -e

BACKUP_DIR="/opt/backups/dashmani"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
APP_DIR="/opt/dashmani-platform"
MAX_BACKUPS=8  # Keep last 8 backups (2 months of weekly)

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "[$TIMESTAMP] Starting backup..."

# 1. Database backup
echo "Backing up database..."
source "$APP_DIR/apps/api/.env" 2>/dev/null || source "$APP_DIR/.env" 2>/dev/null || true

if [ -n "$DATABASE_URL" ]; then
  pg_dump "$DATABASE_URL" --no-owner --no-privileges > "$BACKUP_DIR/db_$TIMESTAMP.sql"
  gzip "$BACKUP_DIR/db_$TIMESTAMP.sql"
  echo "Database backup: $BACKUP_DIR/db_$TIMESTAMP.sql.gz"
else
  echo "WARNING: DATABASE_URL not found, skipping database backup"
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

echo "[$TIMESTAMP] Backup complete!"
echo "Backup location: $BACKUP_DIR"
ls -lh "$BACKUP_DIR"/*_$TIMESTAMP* 2>/dev/null
