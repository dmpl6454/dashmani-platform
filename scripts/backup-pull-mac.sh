#!/bin/bash
# =============================================================
# Off-server copy of the production backups, run on the office Mac.
#
# The weekly backup (scripts/backup.sh) writes to /opt/backups/dashmani on the SAME
# server it protects, and keeps only 4 weeks. This copies every complete set to the
# external "Sud" drive and keeps ~6 months there, so losing the server (or its disk,
# or the Linode account) does not lose the backups.
#
# Run daily by launchd (installed by scripts/install-backup-pull-mac.sh). Steps:
#   1. the Sud drive must be mounted (else: macOS alert, exit 1);
#   2. rsync the server's backup folder into $DEST/mirror (an exact mirror of what the
#      server holds). The SSH key is limited on the server to `rrsync -ro` of that one
#      folder, so it can read backups and nothing else;
#   3. each set in the mirror whose SHA256SUMS_<ts>.txt exists (written LAST by the
#      server, so the set is complete) is checked file by file with `shasum -a 256 -c`.
#      Sets from before checksums existed are checked with `gzip -t` instead;
#   4. a verified set is hard-linked into $DEST/sets/<ts>/ (no extra space while the
#      mirror still holds it; it survives when the server prunes it), with a VERIFIED
#      marker. Sets are never overwritten once verified;
#   5. sets beyond KEEP_SETS (newest first) are deleted from $DEST/sets;
#   6. alert when the newest verified set is older than STALE_DAYS — the server's
#      weekly run failed (the 2026-10-25 run died in the disk-full outage, and the
#      May–July 2026 runs failed silently for 15 weeks).
# The status of the last run is in $DEST/STATUS.txt and ~/Library/Logs/dashmani-backup-pull.log.
#
# ⚠️ The sets hold the full database (client data, password hashes) and the config
# tarball holds the server's .env files (every secret, incl. META_TOKEN_ENC_KEY, which
# is needed to read stored Meta tokens after a restore). Folders are created 0700 and
# files 0600; keep the Sud drive physically secure.
# =============================================================
set -uo pipefail

HOST="${BACKUP_HOST:-root@172.105.53.101}"
KEY="${BACKUP_KEY:-$HOME/.ssh/dashmani_backup_pull}"
DEST="${BACKUP_DEST:-/Volumes/Sud/dashmani-backups}"
KEEP_SETS="${KEEP_SETS:-26}"     # weekly sets ≈ 6 months, ~45 GB at today's 1.7 GB/set
STALE_DAYS="${STALE_DAYS:-8}"
# rsync 3.x (Homebrew). macOS's built-in openrsync sends options the server's `rrsync`
# refuses ("invalid rsync-command syntax or options"), so it cannot be used here.
RSYNC="${RSYNC:-$( [ -x /opt/homebrew/bin/rsync ] && echo /opt/homebrew/bin/rsync || echo /usr/local/bin/rsync )}"

ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*"; }
alert() {
  log "ALERT: $1"
  /usr/bin/osascript -e "display notification \"$1\" with title \"Dashmani backups\" sound name \"Basso\"" >/dev/null 2>&1 || true
}
status() { printf '%s\n%s\n' "$(ts)" "$1" > "$DEST/STATUS.txt" 2>/dev/null || true; }

if [ ! -d "$(dirname "$DEST")" ] || ! mount | grep -q " on $(dirname "$DEST") "; then
  alert "Sud drive not connected — today's backup copy was skipped."
  exit 1
fi
umask 077
mkdir -p "$DEST/mirror" "$DEST/sets" || { alert "Can't write to $DEST."; exit 1; }
chmod 700 "$DEST" "$DEST/mirror" "$DEST/sets"

log "pulling from $HOST"
# -t keeps the server's mtimes (so unchanged files are skipped), --partial resumes a cut
# transfer, --delete keeps the mirror equal to the server (history lives in sets/).
if [ ! -x "$RSYNC" ]; then
  alert "rsync 3 is missing — run: brew install rsync"
  exit 1
fi
if ! /usr/bin/caffeinate -i "$RSYNC" -rt --partial --delete --exclude '*.tmp' \
    -e "ssh -i $KEY -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30" \
    "$HOST:" "$DEST/mirror/"; then
  alert "Copying the backups from the server failed — see ~/Library/Logs/dashmani-backup-pull.log."
  status "FAILED: rsync"
  exit 1
fi
chmod 600 "$DEST"/mirror/* 2>/dev/null || true

verified_new=0
failed=0
cd "$DEST/mirror" || exit 1
for stamp in $(ls -1 | sed -nE 's/^(db|uploads|config|manifest|SHA256SUMS)_([0-9]{8}_[0-9]{6}).*/\2/p' | sort -u); do
  set_dir="$DEST/sets/$stamp"
  [ -f "$set_dir/VERIFIED" ] && continue
  files=( $(ls -1 | grep -E "^(db|uploads|config|manifest)_${stamp}\.") )
  [ "${#files[@]}" -gt 0 ] || continue
  if [ -f "SHA256SUMS_${stamp}.txt" ]; then
    if ! /usr/bin/shasum -a 256 -c "SHA256SUMS_${stamp}.txt" > "/tmp/dashmani-sha-$stamp.log" 2>&1; then
      alert "Backup set $stamp failed its checksum — it will be re-copied next run."
      rm -f "db_${stamp}".* # force a fresh copy of the large file next time
      failed=1
      continue
    fi
    method="sha256 (server checksums)"
  else
    # Sets written before the server recorded checksums: an integrity test instead.
    [ -f "db_${stamp}.sql.gz" ] || continue
    ok=1
    for f in "${files[@]}"; do
      case "$f" in *.gz) /usr/bin/gzip -t "$f" 2>/dev/null || ok=0 ;; esac
    done
    if [ "$ok" != 1 ]; then
      alert "Backup set $stamp is damaged (gzip test failed)."
      failed=1
      continue
    fi
    method="gzip -t (set predates server checksums)"
  fi
  mkdir -p "$set_dir"
  for f in "${files[@]}" "SHA256SUMS_${stamp}.txt"; do
    [ -f "$f" ] && ln -f "$f" "$set_dir/$f"
  done
  printf 'verified %s by %s\n' "$(ts)" "$method" > "$set_dir/VERIFIED"
  chmod 700 "$set_dir"
  log "verified $stamp ($method)"
  verified_new=$((verified_new + 1))
done

# Retention: keep the newest KEEP_SETS verified sets.
cd "$DEST/sets" || exit 1
ls -1d [0-9]*_[0-9]* 2>/dev/null | sort -r | tail -n +$((KEEP_SETS + 1)) | while read -r old; do
  log "removing old set $old"
  rm -rf "$DEST/sets/$old"
done

newest=$(ls -1d [0-9]*_[0-9]* 2>/dev/null | sort -r | head -1)
count=$(ls -1d [0-9]*_[0-9]* 2>/dev/null | wc -l | tr -d ' ')
if [ -z "$newest" ]; then
  alert "No verified backup on the Sud drive yet."
  status "NO VERIFIED SET"
  exit 1
fi
newest_epoch=$(date -j -f "%Y%m%d_%H%M%S" "$newest" +%s 2>/dev/null || echo 0)
age_days=$(( ( $(date +%s) - newest_epoch ) / 86400 ))
if [ "$age_days" -gt "$STALE_DAYS" ]; then
  alert "Newest backup is ${age_days} days old — the server's weekly backup has not run. Check /var/log/dashmani-backup.log on the server."
fi
summary="OK: $count verified set(s), newest $newest (${age_days}d old), $verified_new new this run$( [ "$failed" = 1 ] && echo ', SOME SETS FAILED')"
status "$summary"
log "$summary"
[ "$failed" = 1 ] && exit 1
exit 0
