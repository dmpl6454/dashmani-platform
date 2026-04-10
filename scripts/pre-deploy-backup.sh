#!/bin/bash
# =============================================================
# Pre-deployment backup - run before major updates
# Usage: ./scripts/pre-deploy-backup.sh
# =============================================================

set -e

BACKUP_DIR="/opt/backups/dashmani/pre-deploy"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
APP_DIR="/opt/dashmani-platform"

mkdir -p "$BACKUP_DIR"

echo "Creating pre-deploy backup at $TIMESTAMP..."

# Database snapshot
source "$APP_DIR/apps/api/.env" 2>/dev/null || source "$APP_DIR/.env" 2>/dev/null || true
if [ -n "$DATABASE_URL" ]; then
  pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip > "$BACKUP_DIR/pre_deploy_db_$TIMESTAMP.sql.gz"
  echo "Database: $BACKUP_DIR/pre_deploy_db_$TIMESTAMP.sql.gz"
fi

# Uploads snapshot
if [ -d "$APP_DIR/uploads" ]; then
  tar -czf "$BACKUP_DIR/pre_deploy_uploads_$TIMESTAMP.tar.gz" -C "$APP_DIR" uploads/
  echo "Uploads: $BACKUP_DIR/pre_deploy_uploads_$TIMESTAMP.tar.gz"
fi

# Keep only last 5 pre-deploy backups
cd "$BACKUP_DIR"
ls -1t pre_deploy_db_*.sql.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
ls -1t pre_deploy_uploads_*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f

echo "Pre-deploy backup complete!"
ls -lh "$BACKUP_DIR"/pre_deploy_*$TIMESTAMP* 2>/dev/null
