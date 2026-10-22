#!/usr/bin/env bash
# php2shell-check.sh — READ-ONLY exposure and compromise check for "PHP2Shell":
#   CVE-2026-109618 (OOM corruption / upload-progress unserializer) and
#   CVE-2026-109619 (stale request state use-after-free), both CVSS 9.2, unauthenticated RCE.
#   Upstream fixes shipped 2026-10-21 in PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35.
#   Exploitation was reported from 2026-10-21 07:43 UTC (Cloudflare), before the release.
#
# Run it on the PRODUCTION box, as root (it reads logs and other users' files):
#   bash /opt/dashmani-platform/scripts/php2shell-check.sh
# or from a laptop, without merging or copying anything:
#   git show origin/<branch>:scripts/php2shell-check.sh | ssh dashmani-prod 'bash -s'
#
# It changes NOTHING: no package, service, config or file is written, and no PHP code or
# binary it finds on disk is ever executed (an attacker may have planted one). Heavy
# searches run under nice/ionice with a timeout, so it is safe on the 2 GB box.
#
#   SINCE=2026-10-18 bash scripts/php2shell-check.sh   # look-back date for changed files and logs
#   bash scripts/php2shell-check.sh --self-test        # logic tests only; touches nothing on the host
#
# Exit status: 0 = no FAIL line, 1 = at least one FAIL (exposed, or something suspicious), 2 = bad usage.
# WARN lines are things to read and decide on; a clean run is still not proof of no compromise.
#
# Fix knowledge (USN-8948-1 and php.net, 2026-10-21):
#   Ubuntu 24.04 php8.3 >= 8.3.6-0ubuntu0.24.04.13   Ubuntu 22.04 php8.1 >= 8.1.2-1ubuntu2.28
#   Ubuntu 26.04 php8.5 >= 8.5.4-0ubuntu1.5          Ubuntu 26.10 php8.5 >= 8.5.9-0ubuntu2.1
#   Debian / Sury PPA / source builds (upstream numbering): 8.5 >= .12, 8.4 >= .27, 8.3 >= .36, 8.2 >= .35
#   PHP 8.1 and older have NO upstream fix: only a vendor backport counts, so they read "unknown".
# A package also counts as fixed when its changelog names both CVEs (how Debian and Ubuntu record backports).

set -u

SINCE="${SINCE:-2026-10-18}"
OK=0; WARN=0; FAIL=0

ok()    { printf '[ OK ] %s\n' "$*"; OK=$((OK + 1)); }
warn()  { printf '[WARN] %s\n' "$*"; WARN=$((WARN + 1)); }
fail()  { printf '[FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); }
info()  { printf '       %s\n' "$*"; }
title() { printf '\n== %s ==\n' "$*"; }
have()  { command -v "$1" >/dev/null 2>&1; }

# Run a heavy read-only command at the lowest priority, stopping it after $1 seconds.
low() {
  local secs="$1"; shift
  if have ionice; then timeout "$secs" nice -n 19 ionice -c 3 "$@" 2>/dev/null
  else timeout "$secs" nice -n 19 "$@" 2>/dev/null; fi
}

# ---------------------------------------------------------------------------------------------
# Pure logic (unit-tested by --self-test; none of it reads the host)
# ---------------------------------------------------------------------------------------------

# patched | unpatched | unknown, from a package version string alone.
version_verdict() {
  local v="$1" bare="$1" floor="" series patch
  [[ "$bare" =~ ^[0-9]+: ]] && bare="${bare#*:}"
  case "$bare" in
    8.3.6-0ubuntu0.24.04.*) floor="8.3.6-0ubuntu0.24.04.13" ;;
    8.1.2-1ubuntu2.*)       floor="8.1.2-1ubuntu2.28" ;;
    8.5.4-0ubuntu1.*)       floor="8.5.4-0ubuntu1.5" ;;
    8.5.9-0ubuntu2.*)       floor="8.5.9-0ubuntu2.1" ;;
  esac
  if [ -n "$floor" ]; then
    if dpkg --compare-versions "$v" ge "$floor" 2>/dev/null; then echo patched; else echo unpatched; fi
    return
  fi
  if [[ "$bare" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    series="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
    case "$series" in
      8.5) floor=12 ;;
      8.4) floor=27 ;;
      8.3) floor=36 ;;
      8.2) floor=35 ;;
      *)   echo unknown; return ;;
    esac
    if [ "$patch" -ge "$floor" ]; then echo patched; else echo unpatched; fi
    return
  fi
  echo unknown
}

# Reads `nginx -T` on stdin; prints one "<server_name><TAB><how>" line per server block that hands requests to PHP.
nginx_php_servers() {
  awk '
    function flush() { if (insrv && php) printf "%s\t%s\n", (name == "" ? "(no server_name)" : name), how }
    {
      line = $0
      sub(/#.*/, "", line)
      if (!insrv && line ~ /(^|[[:space:];}])server[[:space:]]*\{/) { insrv = 1; depth = 0; name = ""; php = 0; how = "" }
      if (insrv) {
        if (line ~ /server_name[[:space:]]/) { n = line; sub(/.*server_name[[:space:]]+/, "", n); sub(/;.*/, "", n); name = (name == "" ? n : name " " n) }
        if (line ~ /fastcgi_pass[[:space:]]/) { php = 1; how = "fastcgi_pass" }
        else if (line ~ /snippets\/fastcgi-php\.conf|fastcgi_params|fastcgi\.conf/) { php = 1; if (how == "") how = "fastcgi include" }
        o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line)
        depth += o - c
        if (depth <= 0 && (o > 0 || c > 0)) { flush(); insrv = 0 }
      }
    }
    END { if (insrv) flush() }'
}

# Alternation of every day from $1 (YYYY-MM-DD) to today, formatted with date(1) format $2, for use inside a regex.
day_alternation() {
  # Walks calendar days, so a DST-shortened day cannot drop today, and a future date yields today only.
  local from="$1" fmt="$2" today i=0 out="" d key
  today=$(date +%F)
  date -d "$from" +%F >/dev/null 2>&1 || return 1
  [ "$(date -d "$from" +%s)" -gt "$(date -d "$today" +%s)" ] && from="$today"
  while :; do
    key=$(date -d "$from +$i day" +%F)
    d=$(date -d "$from +$i day" +"$fmt")
    out="${out:+$out|}$d"
    [ "$key" = "$today" ] && break
    i=$((i + 1))
    [ "$i" -gt 45 ] && break
  done
  printf '%s' "$out"
}

# True when the package changelog names both CVEs (a backported fix).
changelog_has_fix() {
  local f
  for f in "/usr/share/doc/$1/changelog.Debian.gz" "/usr/share/doc/$1/changelog.gz"; do
    [ -r "$f" ] || continue
    if zgrep -q 'CVE-2026-109618' "$f" 2>/dev/null && zgrep -q 'CVE-2026-109619' "$f" 2>/dev/null; then return 0; fi
  done
  return 1
}

self_test() {
  local bad=0 t exp got
  check() { # name expected actual
    if [ "$2" = "$3" ]; then printf 'pass  %s\n' "$1"; else printf 'FAIL  %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; bad=$((bad + 1)); fi
  }
  # version table: version -> verdict
  while IFS='|' read -r v want; do
    [ -z "$v" ] && continue
    check "version $v" "$want" "$(version_verdict "$v")"
  done <<'EOF'
8.3.6-0ubuntu0.24.04.13|patched
8.3.6-0ubuntu0.24.04.14|patched
8.3.6-0ubuntu0.24.04.12|unpatched
8.3.6-0ubuntu0.24.04.11|unpatched
8.1.2-1ubuntu2.28|patched
8.1.2-1ubuntu2.27|unpatched
8.5.4-0ubuntu1.5|patched
8.5.4-0ubuntu1.4|unpatched
8.5.9-0ubuntu2.1|patched
8.5.9-0ubuntu2|unpatched
8.3.36-1+ubuntu24.04.1+deb.sury.org+1|patched
8.3.35-1+ubuntu24.04.1+deb.sury.org+1|unpatched
8.4.27-1~deb13u1|patched
8.4.26-1~deb13u1|unpatched
8.2.35-1~deb12u1|patched
8.2.34-1~deb12u1|unpatched
8.5.12-1+ubuntu24.04.1+deb.sury.org+1|patched
8.5.11-1|unpatched
8.3.100-1|patched
1:8.3.36-1|patched
7.4.33-1+deb11u7|unknown
8.0.30-1|unknown
8.1.31-1|unknown
8.6.0-1|unknown
garbage|unknown
EOF

  # nginx routing parser
  local wp static mixed
  wp='server {
    listen 443 ssl;
    server_name blog.example.com www.blog.example.com;
    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
    }
}'
  static='# a comment with server { and fastcgi_pass in it
server { listen 80; server_name static.example.com; root /srv/out; location / { try_files $uri =404; } }
server { listen 443; server_name api.example.com; location / { proxy_pass http://127.0.0.1:4000; } }'
  mixed="$static"$'\n'"$wp"$'\n''server { server_name last.example.com; location ~ \.php$ { fastcgi_pass 127.0.0.1:9000; } }'
  check "nginx: PHP server found"            $'blog.example.com www.blog.example.com\tfastcgi_pass' "$(printf '%s\n' "$wp" | nginx_php_servers)"
  check "nginx: static and proxy are clean"  "" "$(printf '%s\n' "$static" | nginx_php_servers)"
  check "nginx: only PHP servers listed"     $'blog.example.com www.blog.example.com\tfastcgi_pass\nlast.example.com\tfastcgi_pass' "$(printf '%s\n' "$mixed" | nginx_php_servers)"
  check "nginx: fastcgi_params include"      $'inc.example.com\tfastcgi include' "$(printf '%s\n' 'server { server_name inc.example.com; include fastcgi_params; }' | nginx_php_servers)"

  # date alternation: SINCE = today gives exactly one day
  got=$(day_alternation "$(date +%F)" '%d-%b-%Y')
  check "days: today only" "$(date +'%d-%b-%Y')" "$got"
  got=$(day_alternation "$(date -d '2 day ago' +%F)" '%d/%b/%Y')
  check "days: three days" "3" "$(printf '%s\n' "$got" | tr '|' '\n' | wc -l | tr -d ' ')"
  check "days: three days ends today" "$(date +'%d/%b/%Y')" "${got##*|}"
  check "days: future date gives today only" "$(date +%F)" "$(day_alternation "$(date -d '+3 day' +%F)" '%F')"
  check "days: bad date is refused" "1" "$(day_alternation 'not-a-date' '%F' >/dev/null; echo $?)"

  if [ "$bad" -eq 0 ]; then echo "self-test: all passed"; return 0; fi
  echo "self-test: $bad failed"; return 1
}

# ---------------------------------------------------------------------------------------------
# The checks (read the host)
# ---------------------------------------------------------------------------------------------

UNPATCHED_WEB=0; UNPATCHED_CLI=0; UNKNOWN_PKG=0; PHP_ROUTED=0; PHP_RUNNING=0

section_identity() {
  title "Where this is running"
  info "host: $(hostname 2>/dev/null)   user: $(id -un 2>/dev/null)   now: $(date -u +'%F %T') UTC   look-back from: $SINCE"
  [ "$(id -u)" -eq 0 ] || warn "not root: some logs and directories cannot be read, so results may be incomplete"
  if [ -d /opt/dashmani-platform ]; then ok "/opt/dashmani-platform exists (this looks like the platform box)"
  else warn "/opt/dashmani-platform not found: make sure this is the box you meant (the old 'linode' alias is the OTHER box)"; fi
}

section_packages() {
  title "Installed PHP engines and whether they carry the fix"
  if ! have dpkg-query; then warn "no dpkg here: check PHP by hand with 'php -v' and compare with the fixed versions in the header"; return; fi
  local rows pkg ver kind verdict how
  rows=$(dpkg-query -W -f='${Package}\t${Version}\t${db:Status-Abbrev}\n' 2>/dev/null \
    | awk -F'\t' '$3 ~ /^ii/ && $1 ~ /^(php[0-9]+\.[0-9]+-(fpm|cgi|cli)|libapache2-mod-php[0-9]+\.[0-9]+)$/ { print $1 "\t" $2 }')
  if [ -z "$rows" ]; then ok "no PHP engine package (fpm, cgi, cli, apache module) is installed through dpkg"; return; fi
  while IFS=$'\t' read -r pkg ver; do
    case "$pkg" in php*-cli) kind=cli ;; *) kind=web ;; esac
    verdict=$(version_verdict "$ver"); how="version"
    if changelog_has_fix "$pkg"; then verdict=patched; how="changelog names both CVEs"; fi
    case "$verdict" in
      patched)   ok "$pkg $ver: patched ($how)" ;;
      unpatched)
        if [ "$kind" = web ]; then UNPATCHED_WEB=$((UNPATCHED_WEB + 1)); warn "$pkg $ver: NOT patched (web engine)"
        else UNPATCHED_CLI=$((UNPATCHED_CLI + 1)); warn "$pkg $ver: NOT patched (command line only: not reachable from the web, patch anyway)"; fi ;;
      *)
        UNKNOWN_PKG=$((UNKNOWN_PKG + 1))
        [ "$kind" = web ] && UNPATCHED_WEB=$((UNPATCHED_WEB + 1))
        warn "$pkg $ver: cannot confirm a fix (PHP 8.1 and older need a vendor backport; no CVE in its changelog). Treat as unpatched." ;;
    esac
  done <<<"$rows"
  if have apt-cache; then
    local cand
    for pkg in $(awk -F'\t' '{print $1}' <<<"$rows"); do
      cand=$(apt-cache policy "$pkg" 2>/dev/null | awk '/Candidate:/ {print $2}')
      [ -n "$cand" ] && info "$pkg: apt would install $cand (run 'apt-get update' first, the mirror may lag the release)"
    done
  fi
}

section_other_php() {
  title "PHP that is not a Debian package"
  local found
  found=$(low 60 find /usr/local /opt /snap /srv /var/www -xdev \( -name node_modules -o -name .git -o -name .next \) -prune -o \
            -type f -perm -u+x \( -name php -o -name 'php[0-9]*' -o -name php-fpm -o -name php-cgi -o -name 'php-fpm[0-9]*' -o -name frankenphp -o -name lsphp \) -print | head -20)
  if [ -n "$found" ]; then
    warn "PHP-looking executables outside dpkg (not executed by this script; check each version yourself):"
    while IFS= read -r f; do info "$f"; done <<<"$found"
  else ok "none found under /usr/local /opt /snap /srv /var/www"; fi
  if have docker && docker info >/dev/null 2>&1; then
    local c
    c=$(docker ps --format '{{.Names}} ({{.Image}})' 2>/dev/null | grep -iE 'php|wordpress|apache|httpd|drupal|joomla|laravel|nextcloud|magento|lamp|nginx-php' || true)
    if [ -n "$c" ]; then warn "running containers that may bundle PHP (run 'docker exec <name> php -v' and rebuild from a patched image):"; while IFS= read -r l; do info "$l"; done <<<"$c"
    else ok "no running container looks PHP-based (judged by name and image only)"; fi
  fi
}

section_running_and_reachable() {
  title "Is PHP running, and can the internet reach it"
  local procs
  procs=$(ps -eo pid=,user=,etimes=,comm= 2>/dev/null | awk '$4 ~ /^(php-fpm|php-cgi|lsphp|frankenphp|apache2|httpd)/ { n[$4]++ } END { for (k in n) printf "%s x%d\n", k, n[k] }')
  if [ -n "$procs" ]; then PHP_RUNNING=1; warn "running now: $(tr '\n' ' ' <<<"$procs")"; else ok "no php-fpm, php-cgi, apache or frankenphp process is running"; fi

  # nginx: which server blocks hand requests to PHP
  if have nginx; then
    local routed
    routed=$(nginx -T 2>/dev/null | nginx_php_servers)
    if [ -n "$routed" ]; then
      PHP_ROUTED=1
      fail "nginx hands requests to PHP for: "
      while IFS=$'\t' read -r name how; do info "$name   ($how)"; done <<<"$routed"
    else ok "no nginx server block uses fastcgi_pass or a fastcgi include (nginx cannot reach PHP)"; fi
  else info "nginx is not installed here"; fi

  # apache
  if have apache2ctl || have httpd; then
    if systemctl is-active --quiet apache2 2>/dev/null || systemctl is-active --quiet httpd 2>/dev/null; then
      if { apache2ctl -M 2>/dev/null || httpd -M 2>/dev/null; } | grep -qi 'php'; then PHP_ROUTED=1; fail "apache is running with a PHP module loaded (mod_php is the highest-risk setup: no application code runs before the bug)"
      else warn "apache is running (check it for php-fpm proxying: grep -ri 'proxy:fcgi\|SetHandler' /etc/apache2)"; fi
    else ok "apache is installed but not running"; fi
  fi

  # php-fpm bound to a non-loopback TCP port is reachable by anyone who can reach the port
  local pools lis
  pools=$(grep -rhE '^[[:space:]]*listen[[:space:]]*=' /etc/php/*/fpm/pool.d/ 2>/dev/null | tr -s ' ' | tr '\n' ';')
  [ -n "$pools" ] && info "php-fpm pool listen settings: $pools"
  lis=$(ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -E ':9000$|:9001$' | grep -vE '^(127\.|\[::1\]|::1)' || true)
  lis="$lis$(ss -H -ltnp 2>/dev/null | awk '/php-fpm|php-cgi|lsphp/ {print $4}' | grep -vE '^(127\.|\[::1\]|::1)' || true)"
  if [ -n "$lis" ]; then PHP_ROUTED=1; fail "PHP FastCGI listens on a public address: $(tr '\n' ' ' <<<"$lis") (anyone who reaches it runs PHP, no web server involved)"
  else ok "no PHP listener on a non-loopback TCP address"; fi
  have ufw && info "ufw: $(ufw status 2>/dev/null | head -1)"
}

section_verdict_exposure() {
  title "Exposure verdict"
  if [ "$UNPATCHED_WEB" -gt 0 ] && [ "$PHP_ROUTED" -eq 1 ]; then
    fail "EXPOSED: an engine without the fix is routed to the internet. Patch NOW (see docs/superpowers/plans/2026-10-22-php2shell-runbook.md), then treat the box as possibly compromised."
  elif [ "$UNPATCHED_WEB" -gt 0 ] && [ "$PHP_RUNNING" -eq 1 ]; then
    warn "an unpatched PHP engine is running but nothing routes the web to it. Patch it or stop it (the runbook says how); do not leave it as is."
  elif [ "$UNPATCHED_WEB" -gt 0 ]; then
    warn "an unpatched PHP web engine is installed but not running. Patch or remove the package."
  elif [ "$PHP_ROUTED" -eq 1 ]; then
    ok "PHP is routed to the web but every engine found carries the fix. Restart php-fpm if it was running before the upgrade (the old binary stays in memory): systemctl restart php*-fpm"
  else
    ok "no unpatched PHP web engine is reachable from the web"
  fi
  [ "$UNPATCHED_CLI" -gt 0 ] && info "unpatched PHP command line remains: it only matters if a cron job or worker feeds it untrusted input"
}

section_mitigations_in_place() {
  title "Interim mitigation settings found (informational; PHP says patching is the only complete fix)"
  local lines
  lines=$(grep -rhE '^[[:space:]]*(session\.upload_progress\.enabled|memory_limit|post_max_size|fatal_error_backtraces)[[:space:]]*=' /etc/php/*/fpm/php.ini /etc/php/*/fpm/conf.d/ 2>/dev/null | sort | uniq -c)
  lines="$lines$(grep -rhE 'php_(admin_)?(value|flag)\[(session\.upload_progress\.enabled|memory_limit|post_max_size|fatal_error_backtraces)\]' /etc/php/*/fpm/pool.d/ 2>/dev/null)"
  if [ -n "$lines" ]; then while IFS= read -r l; do info "$l"; done <<<"$lines"; else info "none found"; fi
}

# A PHP RCE runs as the php-fpm user (www-data). If that user can read the platform's .env files, the
# attacker gets JWT_SECRET, the database URL, Razorpay and Meta keys in one read: worse than the WordPress site.
section_platform_secrets() {
  title "Could PHP's user read the platform's secrets"
  local u f mode checked=0
  # The user php-fpm pools actually run as (first pool wins); www-data when no pool says.
  u=$(grep -rhE '^[[:space:]]*user[[:space:]]*=' /etc/php/*/fpm/pool.d/ 2>/dev/null | head -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:];].*//')
  u="${u:-www-data}"
  id "$u" >/dev/null 2>&1 || { ok "no '$u' account on this box, so no php-fpm pool runs as it"; return; }
  for f in /opt/dashmani-platform/.env /opt/dashmani-platform/apps/api/.env /opt/dashmani-platform/packages/db/.env; do
    [ -e "$f" ] || continue
    checked=$((checked + 1))
    mode=$(stat -c '%a %U:%G' "$f" 2>/dev/null)
    if have runuser && runuser -u "$u" -- test -r "$f" 2>/dev/null; then
      fail "$f is READABLE by $u (mode $mode): every secret in it is one PHP exploit away. Fix: chmod 600 $f (the API runs as root under pm2, so nothing else needs it)"
    elif ! have runuser && [ "$(stat -c '%a' "$f" 2>/dev/null | cut -c3)" != "0" ]; then
      warn "$f has 'other' read bits (mode $mode): if $u can traverse /opt/dashmani-platform it can read it. chmod 600 $f"
    else
      ok "$f is not readable by $u (mode $mode)"
    fi
  done
  [ "$checked" -eq 0 ] && info "no platform .env file under /opt/dashmani-platform to test (not the platform box?)"
}

WP_ROOTS=""
section_find_web_roots() {
  title "WordPress and other PHP sites on disk"
  WP_ROOTS=$(low 90 find /var/www /srv /home /root /opt -xdev \( -name node_modules -o -name .git -o -name .next \) -prune -o -type f -name wp-config.php -print | xargs -r -n1 dirname | sort -u)
  if [ -n "$WP_ROOTS" ]; then
    warn "WordPress installs found (a PHP site exists on this box):"
    while IFS= read -r r; do info "$r"; done <<<"$WP_ROOTS"
    info "If nobody uses the site any more, the safest fix is to retire it (runbook, option B)."
  else ok "no wp-config.php found under /var/www /srv /home /root /opt"; fi
  [ -d /var/www ] && [ -n "$(ls -A /var/www 2>/dev/null)" ] && info "/var/www contains: $(ls -A /var/www | head -8 | tr '\n' ' ')"
}

section_compromise_hunt() {
  title "Signs of compromise since $SINCE (a clean result is not proof)"
  local roots="" r
  for r in $WP_ROOTS /var/www /srv; do [ -d "$r" ] && roots="$roots $r"; done
  roots=$(printf '%s\n' $roots | sort -u | tr '\n' ' ')

  if [ -n "$roots" ]; then
    local up newphp sig mu
    up=$(low 120 find $roots -xdev -type f \( -iname '*.php' -o -iname '*.phtml' -o -iname '*.phar' -o -iname '*.php[0-9]' \) \( -path '*/uploads/*' -o -path '*/cache/*' -o -path '*/tmp/*' \) | head -30)
    if [ -n "$up" ]; then fail "PHP files inside upload, cache or tmp folders (these should hold no code):"; while IFS= read -r f; do info "$f"; done <<<"$up"
    else ok "no PHP files inside uploads, cache or tmp folders"; fi

    sig=$(low 180 grep -rIlsE --include='*.php' --include='*.phtml' \
      -e 'eval[[:space:]]*\([[:space:]]*(base64_decode|gzinflate|gzuncompress|str_rot13)' \
      -e '(assert|system|passthru|shell_exec|exec|popen|proc_open)[[:space:]]*\([[:space:]]*\$_(POST|GET|REQUEST|COOKIE)' \
      -e 'FilesMan|c99shell|r57shell|b374k|WSO[[:space:]]shell' \
      -e 'pearcmd' $roots | head -30)
    if [ -n "$sig" ]; then fail "files matching web-shell signatures (open each one; a few plugins use eval legitimately):"; while IFS= read -r f; do info "$f"; done <<<"$sig"
    else ok "no web-shell signatures in the PHP files of those sites"; fi

    newphp=$(low 120 find $roots -xdev -type f -iname '*.php' -newermt "$SINCE" -printf '%TY-%Tm-%Td %TH:%TM  %p\n' | sort -r | head -25)
    if [ -n "$newphp" ]; then warn "PHP files changed since $SINCE (normal after a plugin or core update; unexpected otherwise), newest first:"; while IFS= read -r l; do info "$l"; done <<<"$newphp"
    else ok "no PHP file changed since $SINCE under those sites"; fi

    mu=$(find $roots -type d -name mu-plugins 2>/dev/null | head -5)
    for r in $mu; do [ -n "$(ls -A "$r" 2>/dev/null)" ] && warn "must-use plugins (they load without being listed in the admin; backdoors hide here): $r: $(ls -A "$r" | head -10 | tr '\n' ' ')"; done

    local ud
    ud=$(find $roots -type d \( -iname 'updraftplus' -o -iname 'updraftcentral*' \) 2>/dev/null | head -5)
    [ -n "$ud" ] && warn "UpdraftPlus/UpdraftCentral is installed ($(tr '\n' ' ' <<<"$ud")): Patchstack reports attackers using valid UpdraftCentral keys to install backdoors. Delete the keys in the dashboard and re-create them."
  else
    info "no PHP site directories to search"
  fi

  # PHP crash and out-of-memory traces: the trigger for both bugs is a fatal error during a multipart request
  local pd nd crashes oom
  pd=$(day_alternation "$SINCE" '%d-%b-%Y'); nd=$(day_alternation "$SINCE" '%d/%b/%Y')
  if [ -n "$pd" ]; then
    local fpmlogs
    fpmlogs=$(ls /var/log/php*-fpm.log* 2>/dev/null)
    if [ -n "$fpmlogs" ]; then
      crashes=$(zgrep -hE "^\[($pd)" $fpmlogs 2>/dev/null | grep -cE 'exited on signal (4|6|7|8|11)|SIGSEGV|SIGABRT|Out of memory' )
      oom=$(zgrep -hE "^\[($pd)" $fpmlogs 2>/dev/null | grep -c 'Allowed memory size')
      if [ "${crashes:-0}" -gt 0 ]; then warn "php-fpm workers crashed ${crashes} time(s) since $SINCE (Tenable lists unexplained worker restarts as a sign): grep -E 'exited on signal' /var/log/php*-fpm.log"
      else ok "no php-fpm worker crash in the logs since $SINCE"; fi
      [ "${oom:-0}" -ge 5 ] && warn "'Allowed memory size exhausted' appears ${oom} times since $SINCE: that fatal error is the trigger, so a burst is worth a look"
    else info "no /var/log/php*-fpm.log to read"; fi
    local acc
    acc=$(ls /var/log/nginx/access.log* 2>/dev/null)
    if [ -n "$acc" ]; then
      local posts5xx
      posts5xx=$(zgrep -hE "\[($nd):" $acc 2>/dev/null | grep -E '"(POST|PUT) [^" ]*\.php[^" ]* HTTP/[0-9.]+" (500|502|504) ')
      if [ -n "$posts5xx" ]; then
        local n; n=$(printf '%s\n' "$posts5xx" | wc -l | tr -d ' ')
        warn "$n POST request(s) to .php that ended in a server error since $SINCE (the logs cannot show multipart bodies, so this is a hint only). Top paths:"
        printf '%s\n' "$posts5xx" | awk '{print $7}' | sort | uniq -c | sort -rn | head -5 | while IFS= read -r l; do info "$l"; done
      else ok "no POST to a .php path ended in a 5xx since $SINCE (nginx access logs)"; fi
    fi
  fi

  # persistence and odd processes
  local ch
  ch=$(find /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /var/spool/cron /etc/systemd/system /etc/ld.so.preload /etc/rc.local /root/.ssh /home/*/.ssh /etc/sudoers /etc/sudoers.d /etc/passwd /etc/shadow -xdev -type f -newermt "$SINCE" -printf '%TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort -r | head -20)
  if [ -n "$ch" ]; then warn "persistence-related files changed since $SINCE (unattended-upgrades and your own work explain some; anything else does not):"; while IFS= read -r l; do info "$l"; done <<<"$ch"
  else ok "no cron, systemd, ssh key, sudoers or account file changed since $SINCE"; fi
  [ -e /etc/ld.so.preload ] && fail "/etc/ld.so.preload exists (rootkit persistence): $(cat /etc/ld.so.preload 2>/dev/null | head -3 | tr '\n' ' ')"

  if id www-data >/dev/null 2>&1; then
    local odd
    odd=$(ps -u www-data -o pid=,etimes=,args= 2>/dev/null | grep -vE 'php-fpm|nginx|apache2|ps -u|grep' | head -10)
    if [ -n "$odd" ]; then fail "processes owned by www-data that are not a web server or php-fpm worker:"; while IFS= read -r l; do info "$l"; done <<<"$odd"
    else ok "www-data runs nothing except web server and php-fpm workers"; fi
  fi
  local out
  out=$(ss -H -tnp 2>/dev/null | awk '$1=="ESTAB" && /php-fpm|php-cgi|lsphp|apache2|httpd/ && $5 !~ /^(127\.|\[::1\])/ {print $4 " -> " $5 "  " $6}' | head -10)
  if [ -n "$out" ]; then warn "PHP workers hold outbound connections right now (WordPress update checks are normal; reverse shells are not):"; while IFS= read -r l; do info "$l"; done <<<"$out"
  else ok "no outbound connection from PHP workers at this moment"; fi
}

section_next_steps() {
  title "Summary"
  printf 'OK %d   WARN %d   FAIL %d\n' "$OK" "$WARN" "$FAIL"
  if [ "$FAIL" -gt 0 ]; then
    cat <<'EOF'
Next: patch or stop PHP first (runbook options A or B), restart php-fpm, re-run this script.
If any "compromise" FAIL line above is real: take the box off the internet path first (stop php-fpm and the PHP
vhost), keep a copy of the files named, and rotate every secret PHP could read (wp-config.php database
password and salts, WordPress admin passwords, UpdraftCentral keys, the .env of anything PHP could open).
EOF
  elif [ "$WARN" -gt 0 ]; then
    echo "No FAIL, but read each WARN line. Patching (or retiring PHP) is still the action: the runbook has the commands."
  else
    echo "Nothing found. Still run 'apt-get update' and install pending PHP security updates when they appear."
  fi
}

main() {
  case "${1:-}" in
    --self-test) self_test; exit $? ;;
    -h|--help)   sed -n '2,24p' "$0"; exit 0 ;;
    "")          ;;
    *)           echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  echo "PHP2Shell (CVE-2026-109618 / CVE-2026-109619) read-only check"
  section_identity
  section_packages
  section_other_php
  section_running_and_reachable
  section_verdict_exposure
  section_mitigations_in_place
  section_platform_secrets
  section_find_web_roots
  section_compromise_hunt
  section_next_steps
  [ "$FAIL" -eq 0 ]
}

# Tests source this file with PHP2SHELL_SOURCE_ONLY=1 to reach the pure functions without running the checks.
if [ -z "${PHP2SHELL_SOURCE_ONLY:-}" ]; then
  main "$@"
fi
