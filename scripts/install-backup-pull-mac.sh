#!/bin/bash
# Installs the daily off-server backup copy on this Mac (see scripts/backup-pull-mac.sh).
#
#   bash scripts/install-backup-pull-mac.sh            # install / update
#   bash scripts/install-backup-pull-mac.sh --uninstall
#
# Needs rsync 3.x (`brew install rsync`): macOS's openrsync is refused by the server's rrsync.
#
# 1. Creates ~/.ssh/dashmani_backup_pull (ed25519) if missing and prints the line to add to
#    the server's /root/.ssh/authorized_keys. That line restricts the key to read-only
#    rsync of /opt/backups/dashmani (`rrsync -ro`) — no shell, no port forwarding.
# 2. Copies the pull script to ~/Library/Application Support/dashmani-backup/ (launchd must
#    not run it from a git checkout: switching branches would change or remove it).
# 3. Installs a LaunchAgent that runs it every day at 09:30 local time. launchd runs a
#    missed run when the Mac wakes. Output: ~/Library/Logs/dashmani-backup-pull.log.
set -euo pipefail

LABEL="com.digitalsukoon.backup-pull"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APPDIR="$HOME/Library/Application Support/dashmani-backup"
KEY="$HOME/.ssh/dashmani_backup_pull"
LOG="$HOME/Library/Logs/dashmani-backup-pull.log"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Uninstalled (the key, the copied script and the backups on the drive are left in place)."
  exit 0
fi

[ -x /opt/homebrew/bin/rsync ] || [ -x /usr/local/bin/rsync ] || { echo "Install rsync 3 first: brew install rsync"; exit 1; }

if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "dashmani-backup-pull@$(hostname -s)" -f "$KEY" >/dev/null
  echo "Created $KEY"
fi
echo "Server authorized_keys line for this key:"
echo "  command=\"/usr/bin/rrsync -ro /opt/backups/dashmani\",restrict $(cat "$KEY.pub")"

mkdir -p "$APPDIR" "$(dirname "$PLIST")" "$(dirname "$LOG")"
install -m 700 "$HERE/backup-pull-mac.sh" "$APPDIR/backup-pull-mac.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$APPDIR/backup-pull-mac.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL (daily 09:30). Run now with: launchctl kickstart gui/$(id -u)/$LABEL"
