#!/usr/bin/env bash
# php2shell-check.sh — READ-ONLY exposure and compromise check for "PHP2Shell":
#   CVE-2026-109618 (OOM corruption / upload-progress unserializer) and
#   CVE-2026-109619 (stale request state use-after-free), both CVSS 9.2, unauthenticated RCE.
#   Upstream fixes shipped 2026-10-21 in PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35.
#   Exploitation was reported from 2026-10-21 07:43 UTC (Cloudflare), before the release.
#
# Run it on the PRODUCTION box, as root (it reads logs, other users' files and /proc):
#   git show origin/<branch>:scripts/php2shell-check.sh | ssh dashmani-prod 'bash -s'
# or, once the script is on the box:  bash /path/to/php2shell-check.sh
#
# It changes NOTHING: no package, service, config or file is written (not even a temp file),
# and no PHP code or binary it finds on disk is ever executed (an attacker may have planted
# one). Heavy searches run at the lowest best-effort I/O priority with a timeout; a search
# that times out says INCOMPLETE, never "none found".
#
#   SINCE=2026-10-18 bash php2shell-check.sh   # look-back date (YYYY-MM-DD) for changed files and logs
#   bash php2shell-check.sh --self-test        # logic tests only; reads nothing from the host
#
# Exit status: 0 = no FAIL line, 1 = at least one FAIL (exposed, or something suspicious), 2 = bad usage.
# WARN lines are things to read and decide on; a clean run is still not proof of no compromise.
#
# Fix knowledge (USN-8948-1 and php.net, 2026-10-21):
#   Ubuntu 24.04 php8.3 >= 8.3.6-0ubuntu0.24.04.13   Ubuntu 22.04 php8.1 >= 8.1.2-1ubuntu2.28
#   Ubuntu 26.04 php8.5 >= 8.5.4-0ubuntu1.5          Ubuntu 26.10 php8.5 >= 8.5.9-0ubuntu2.1
#   Debian / Sury PPA / LiteSpeed lsphp / Docker php images / source builds (upstream numbering):
#     8.5 >= .12, 8.4 >= .27, 8.3 >= .36, 8.2 >= .35
#   PHP 8.1 and older have NO upstream fix: only a vendor backport counts, so they read "unknown".
# A package also counts as fixed when its changelog names both CVEs (how Debian and Ubuntu record backports).
# PHP that is not a Debian package and has no readable version is treated as UNPATCHED.

set -u

SINCE="${SINCE:-2026-10-18}"
LOOKBACK_CAP=45          # log checks read at most this many days back (the newest days are always kept)
OK=0; WARN=0; FAIL=0
IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1

ok()    { printf '[ OK ] %s\n' "$*"; OK=$((OK + 1)); }
warn()  { printf '[WARN] %s\n' "$*"; WARN=$((WARN + 1)); }
fail()  { printf '[FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); }
info()  { printf '       %s\n' "$*"; }
title() { printf '\n== %s ==\n' "$*"; }
have()  { command -v "$1" >/dev/null 2>&1; }
lines() { while IFS= read -r l; do [ -n "$l" ] && info "$l"; done <<<"$1"; }

# Run a heavy read-only command at the lowest best-effort priority, stopping it after $1 seconds.
# Prints its stdout and returns its status: 124 means it was cut short and the result is INCOMPLETE.
# (Best-effort class 7, not the idle class: idle I/O can be starved outright on a busy box.)
low() {
  local secs="$1"; shift
  if have ionice; then timeout "$secs" nice -n 19 ionice -c 2 -n 7 "$@" 2>/dev/null
  else timeout "$secs" nice -n 19 "$@" 2>/dev/null; fi
}

usage() {
  cat <<'EOF'
php2shell-check.sh: read-only PHP2Shell (CVE-2026-109618 / CVE-2026-109619) exposure and compromise check.
  bash php2shell-check.sh               run every check (as root, on the box)
  SINCE=YYYY-MM-DD bash php2shell-check.sh
  bash php2shell-check.sh --self-test   logic tests only
Exit: 0 no FAIL, 1 at least one FAIL, 2 bad usage.
EOF
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
    # compare WITHOUT the epoch: an epoch outranks everything after it, so "1:<old>" would always win
    if dpkg --compare-versions "$bare" ge "$floor" 2>/dev/null; then echo patched; else echo unpatched; fi
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

# Reads `nginx -T` on stdin. Prints one "<server_name><TAB><how>" line per server block that hands
# requests to PHP, and "(unattributed)<TAB>fastcgi_pass in <file>" for any fastcgi_pass the parser
# could not tie to a server block (so any fastcgi_pass anywhere always produces output).
# nginx -T dumps every included file as its own "# configuration file <path>:" section, so a
# fastcgi_pass that lives in an included snippet is found by following the include directives
# (relative paths resolve against the main config's directory, globs are honoured).
NGINX_AWK=$(cat <<'AWK'
function flushsrv() {
  if (insrv) { ns++; sname[ns] = (name == "" ? "(no server_name)" : name); sdirect[ns] = direct; shint[ns] = hint; sinc[ns] = incs }
  insrv = 0
}
function abspath(p) { return (substr(p, 1, 1) == "/") ? p : confdir "/" p }
function glob2re(g,   i, c, out) {
  out = ""
  for (i = 1; i <= length(g); i++) {
    c = substr(g, i, 1)
    if (c == "*") out = out "[^/]*"
    else if (c == "?") out = out "[^/]"
    else if (index(".+()^$|{}\\", c)) out = out "\\" c
    else out = out c
  }
  return "^" out "$"
}
# first file of set S matched by one of the newline-separated patterns in list ("" when none)
function firstin(list, S,   n, a, k, h) {
  n = split(list, a, "\n")
  for (k = 1; k <= n; k++) { if (a[k] == "") continue; for (h in S) if (h ~ a[k]) return h }
  return ""
}
BEGIN { ns = 0; nf = 0; confdir = ""; file = "(stdin)"; insrv = 0 }
/^# configuration file .*:[[:space:]]*$/ {
  flushsrv()
  f = $0; sub(/^# configuration file /, "", f); sub(/:[[:space:]]*$/, "", f)
  file = f; nf++; files[nf] = f
  if (confdir == "") { confdir = f; sub(/\/[^\/]*$/, "", confdir) }
  next
}
{
  line = $0; sub(/#.*/, "", line)
  if (!insrv && line ~ /(^|[[:space:];{}])server[[:space:]]*\{/) { insrv = 1; depth = 0; name = ""; direct = 0; hint = 0; incs = "" }
  rest = line
  while (match(rest, /(^|[[:space:];{}])include[[:space:]]+[^;[:space:]]+[[:space:]]*;/)) {
    d = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH)
    sub(/^.*include[[:space:]]+/, "", d); sub(/[[:space:]]*;$/, "", d); gsub(/"/, "", d); gsub("'", "", d)
    re = glob2re(abspath(d))
    if (insrv) { incs = incs "\n" re; if (d ~ /fastcgi-php\.conf|fastcgi_params|fastcgi\.conf/) hint = 1 }
    else finc[file] = finc[file] "\n" re
  }
  if (line ~ /(^|[[:space:];{}])fastcgi_pass[[:space:]]/) { if (insrv) direct = 1; else { passout[file] = 1; nfiles[file] = 1 } }
  if (insrv && line ~ /(^|[[:space:];{}])server_name[[:space:]]/) { n = line; sub(/.*server_name[[:space:]]+/, "", n); sub(/;.*/, "", n); name = (name == "" ? n : name " " n) }
  if (insrv) { o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line); depth += o - c; if (depth <= 0 && (o > 0 || c > 0)) flushsrv() }
}
END {
  flushsrv()
  # H: files whose fastcgi_pass sits outside any server block, closed under "this file includes an H file"
  for (f in passout) H[f] = 1
  changed = 1
  while (changed) {
    changed = 0
    for (i = 1; i <= nf; i++) { f = files[i]; if (f in H) continue; if (firstin(finc[f], H) != "") { H[f] = 1; changed = 1 } }
  }
  for (s = 1; s <= ns; s++) {
    if (sdirect[s]) { print sname[s] "\tfastcgi_pass"; continue }
    via = firstin(sinc[s], H)
    if (via != "") { print sname[s] "\tfastcgi_pass in " via; R[via] = 1; continue }
    if (shint[s]) print sname[s] "\tfastcgi include"
  }
  # R: H files reached from a server block; anything with a fastcgi_pass that no server reaches is still reported
  changed = 1
  while (changed) {
    changed = 0
    for (r in R) { n = split(finc[r], a, "\n"); for (k = 1; k <= n; k++) { if (a[k] == "") continue; for (h in H) if (!(h in R) && h ~ a[k]) { R[h] = 1; changed = 1 } } }
  }
  for (f in passout) if (!(f in R)) print "(unattributed)\tfastcgi_pass in " f
}
AWK
)
nginx_php_servers() { awk "$NGINX_AWK"; }

# Alternation (for a regex) of every day from today back to $1 (YYYY-MM-DD), formatted with date(1)
# format $2. It walks BACK from today, so the look-back cap drops the oldest days, never today.
day_alternation() {
  local from="$1" fmt="$2" today i=0 out="" key
  today=$(date +%F)
  from=$(date -d "$from" +%F 2>/dev/null) || return 1
  while :; do
    key=$(date -d "$today -$i day" +%F)
    out="${out:+$out|}$(date -d "$key" +"$fmt")"
    [[ ! "$key" > "$from" ]] && break
    i=$((i + 1))
    [ "$i" -gt "$LOOKBACK_CAP" ] && break
  done
  printf '%s' "$out"
}

# Normalised SINCE on stdout; non-zero when it is not a real YYYY-MM-DD date or lies in the future.
valid_since() {
  local s="$1" n
  [[ "$s" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  n=$(date -d "$s" +%F 2>/dev/null) || return 1
  [ "$n" = "$s" ] || return 1
  [[ "$n" > "$(date +%F)" ]] && return 1
  printf '%s' "$n"
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
  local bad=0 got v want
  check() { # name expected actual
    if [ "$2" = "$3" ]; then printf 'pass  %s\n' "$1"; else printf 'FAIL  %s: expected [%s] got [%s]\n' "$1" "$2" "$3"; bad=$((bad + 1)); fi
  }
  while IFS='|' read -r v want; do
    [ -z "$v" ] && continue
    check "version $v" "$want" "$(version_verdict "$v")"
  done <<'EOF'
8.3.6-0ubuntu0.24.04.13|patched
8.3.6-0ubuntu0.24.04.14|patched
8.3.6-0ubuntu0.24.04.12|unpatched
8.3.6-0ubuntu0.24.04.11|unpatched
1:8.3.6-0ubuntu0.24.04.11|unpatched
1:8.3.6-0ubuntu0.24.04.13|patched
8.1.2-1ubuntu2.28|patched
8.1.2-1ubuntu2.27|unpatched
1:8.1.2-1ubuntu2.27|unpatched
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
8.3.36|patched
8.3.12|unpatched
7.4.33-1+deb11u7|unknown
8.0.30-1|unknown
8.1.31-1|unknown
8.6.0-1|unknown
garbage|unknown
EOF

  # nginx: single-file inputs (no "# configuration file" headers)
  local wp static mixed inc glob unattr
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
server { listen 443; server_name api.example.com; location / { proxy_pass http://127.0.0.1:4000; } }
upstream php { server 127.0.0.1:9000; }'
  mixed="$static"$'\n'"$wp"$'\n''server { server_name last.example.com; location ~ \.php$ { fastcgi_pass 127.0.0.1:9000; } }'
  check "nginx: PHP server found"           $'blog.example.com www.blog.example.com\tfastcgi_pass' "$(printf '%s\n' "$wp" | nginx_php_servers)"
  check "nginx: static, proxy and upstream are clean" "" "$(printf '%s\n' "$static" | nginx_php_servers)"
  check "nginx: only PHP servers listed"    $'blog.example.com www.blog.example.com\tfastcgi_pass\nlast.example.com\tfastcgi_pass' "$(printf '%s\n' "$mixed" | nginx_php_servers)"
  check "nginx: fastcgi_params include"     $'inc.example.com\tfastcgi include' "$(printf '%s\n' 'server { server_name inc.example.com; include fastcgi_params; }' | nginx_php_servers)"
  check "nginx: fastcgi_pass_header is not a pass" "" "$(printf '%s\n' 'server { server_name h.example.com; location / { fastcgi_pass_header X-A; } }' | nginx_php_servers)"

  # nginx: real `nginx -T` shape, the pass two includes deep (this exact layout reproduced with nginx 1.24)
  inc='# configuration file /etc/nginx/nginx.conf:
events {}
http { include /etc/nginx/sites-enabled/*; }

# configuration file /etc/nginx/sites-enabled/static:
server { listen 80; server_name static.example.com; root /srv/out; }

# configuration file /etc/nginx/sites-enabled/wordpress:
server {
    server_name blog.example.com;
    location / { try_files $uri /index.php?$args; }
    include snippets/php-handler.conf;
}

# configuration file /etc/nginx/snippets/php-handler.conf:
location ~ \.php$ {
    include snippets/fpm-pass.conf;
}

# configuration file /etc/nginx/snippets/fpm-pass.conf:
fastcgi_pass unix:/run/php/php8.3-fpm.sock;'
  check "nginx -T: pass inside a nested include is tied to its server" $'blog.example.com\tfastcgi_pass in /etc/nginx/snippets/php-handler.conf' "$(printf '%s\n' "$inc" | nginx_php_servers)"
  glob='# configuration file /etc/nginx/nginx.conf:
http { server { server_name g.example.com; location ~ \.php$ { include "/etc/nginx/php.d/*.conf"; } } }

# configuration file /etc/nginx/php.d/fpm.conf:
fastcgi_pass 127.0.0.1:9000;'
  check "nginx -T: glob and quoted include" $'g.example.com\tfastcgi_pass in /etc/nginx/php.d/fpm.conf' "$(printf '%s\n' "$glob" | nginx_php_servers)"
  unattr='# configuration file /etc/nginx/nginx.conf:
http { server { server_name u.example.com; include elsewhere/handler.conf; } }

# configuration file /etc/nginx/snippets/handler.conf:
location ~ \.php$ { fastcgi_pass unix:/run/php/php8.3-fpm.sock; }'
  check "nginx -T: a pass no server can be tied to is still reported" $'(unattributed)\tfastcgi_pass in /etc/nginx/snippets/handler.conf' "$(printf '%s\n' "$unattr" | nginx_php_servers)"

  # dates
  local today; today=$(date +%F)
  check "days: today only" "$(date +'%d-%b-%Y')" "$(day_alternation "$today" '%d-%b-%Y')"
  got=$(day_alternation "$(date -d '2 day ago' +%F)" '%d/%b/%Y')
  check "days: three days" "3" "$(printf '%s\n' "$got" | tr '|' '\n' | wc -l | tr -d ' ')"
  check "days: future date gives today only" "$today" "$(day_alternation "$(date -d '+3 day' +%F)" '%F')"
  check "days: bad date is refused" "1" "$(day_alternation 'not-a-date' '%F' >/dev/null; echo $?)"
  got=$(day_alternation "$(date -d '60 day ago' +%F)" '%F')
  check "days: a 60-day look-back keeps today" "1" "$(printf '%s\n' "$got" | tr '|' '\n' | grep -cx "$today")"
  check "days: a 60-day look-back is capped" "$((LOOKBACK_CAP + 1))" "$(printf '%s\n' "$got" | tr '|' '\n' | wc -l | tr -d ' ')"
  check "since: ISO date accepted" "2026-10-18" "$(valid_since 2026-10-18)"
  check "since: day/month order refused" "1" "$(valid_since 18/10/2026 >/dev/null; echo $?)"
  check "since: impossible date refused" "1" "$(valid_since 2026-13-01 >/dev/null; echo $?)"
  check "since: future date refused" "1" "$(valid_since "$(date -d '+2 day' +%F)" >/dev/null; echo $?)"

  if [ "$bad" -eq 0 ]; then echo "self-test: all passed"; return 0; fi
  echo "self-test: $bad failed"; return 1
}

# ---------------------------------------------------------------------------------------------
# The checks (read the host)
# ---------------------------------------------------------------------------------------------

UNPATCHED_WEB=0; UNPATCHED_CLI=0; UNKNOWN_PKG=0; PHP_ROUTED=0; PHP_RUNNING=0; RESTART_NEEDED=0
FPM_USERS="www-data"

section_identity() {
  title "Where this is running"
  info "host: $(hostname 2>/dev/null)   user: $(id -un 2>/dev/null)   now: $(date -u +'%F %T') UTC   look-back from: $SINCE"
  [ "$IS_ROOT" -eq 1 ] || warn "not root: logs, /proc of other users and other users' files cannot all be read, so some checks are judged from file modes only"
  if [ -d /opt/dashmani-platform ]; then ok "/opt/dashmani-platform exists (this looks like the platform box)"
  else warn "/opt/dashmani-platform not found: make sure this is the box you meant (the old 'linode' alias is the OTHER box)"; fi
  local days=$(( ( $(date -d "$(date +%F)" +%s) - $(date -d "$SINCE" +%s) ) / 86400 ))
  [ "$days" -gt "$LOOKBACK_CAP" ] && warn "SINCE is $days days back: the log checks read only the newest $LOOKBACK_CAP days (file checks use the full date)"
  local u
  u=$(grep -rhE '^[[:space:]]*user[[:space:]]*=' /etc/php/*/fpm/pool.d/ 2>/dev/null | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:];].*//' | sort -u | tr '\n' ' ')
  FPM_USERS=$(printf '%s\n' www-data $u | sort -u | tr '\n' ' ')
}

section_packages() {
  title "Installed PHP engines and whether they carry the fix"
  if ! have dpkg-query; then UNKNOWN_PKG=$((UNKNOWN_PKG + 1)); warn "no dpkg here: check PHP by hand and compare with the fixed versions in the header"; return; fi
  local rows pkg ver kind verdict how
  rows=$(dpkg-query -W -f='${Package}\t${Version}\t${db:Status-Abbrev}\n' 2>/dev/null \
    | awk -F'\t' '$3 ~ /^ii/ && $1 ~ /^(php[0-9]+\.[0-9]+-(fpm|cgi|cli)|libapache2-mod-php[0-9]+\.[0-9]+|lsphp[0-9]+)$/ { print $1 "\t" $2 }')
  if [ -z "$rows" ]; then ok "no PHP engine package (fpm, cgi, cli, apache module, LiteSpeed lsphp) is installed through dpkg"; return; fi
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
        if [ "$kind" = web ]; then UNPATCHED_WEB=$((UNPATCHED_WEB + 1)); else UNPATCHED_CLI=$((UNPATCHED_CLI + 1)); fi
        warn "$pkg $ver: cannot confirm a fix (PHP 8.1 and older need a vendor backport; no CVE in its changelog). Treated as unpatched." ;;
    esac
  done <<<"$rows"
  if have apt-cache; then
    local cand
    for pkg in $(awk -F'\t' '{print $1}' <<<"$rows"); do
      cand=$(apt-cache policy "$pkg" 2>/dev/null | awk '/Candidate:/ {print $2}')
      [ -n "$cand" ] && info "$pkg: apt would install $cand (from the last 'apt-get update'; the mirror may lag the release)"
    done
  fi
}

section_other_php() {
  title "PHP that is not a Debian package"
  local found rc
  found=$(low 90 find /usr/local /opt /snap /srv /var/www -xdev \( -name node_modules -o -name .git -o -name .next \) -prune -o \
            -type f -perm -u+x \( -name php -o -name 'php[0-9]*' -o -name php-fpm -o -name php-cgi -o -name 'php-fpm[0-9]*' -o -name frankenphp -o -name 'lsphp*' \) -print)
  rc=$?
  if [ -n "$found" ]; then
    UNKNOWN_PKG=$((UNKNOWN_PKG + 1)); UNPATCHED_WEB=$((UNPATCHED_WEB + 1))
    warn "PHP-looking executables outside dpkg, TREATED AS UNPATCHED (never executed here; check each with '<path> -v' and compare with the header):"
    lines "$(head -20 <<<"$found")"
  elif [ "$rc" -eq 124 ]; then warn "the search for PHP outside dpkg timed out after 90 s: result INCOMPLETE"
  else ok "none found under /usr/local /opt /snap /srv /var/www"; fi

  have docker || return
  local di
  timeout 15 docker info >/dev/null 2>&1; di=$?
  if [ "$di" -eq 124 ]; then warn "docker did not answer in 15 s: containers NOT checked"; return; fi
  [ "$di" -ne 0 ] && { info "docker is installed but not answering (not running, or not root): containers not checked"; return; }
  local rowsd name img ports env pv vd any=0
  rowsd=$(timeout 15 docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null)
  while IFS=$'\t' read -r name img ports; do
    [ -z "$name" ] && continue
    env=$(timeout 10 docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" 2>/dev/null)
    pv=$(sed -n 's/^PHP_VERSION=//p' <<<"$env" | head -1)
    if [ -z "$pv" ] && ! grep -qiE 'php|wordpress|drupal|joomla|laravel|nextcloud|magento|lamp' <<<"$name $img"; then continue; fi
    any=1
    vd=unknown; [ -n "$pv" ] && vd=$(version_verdict "$pv")
    if [ "$vd" != patched ]; then UNPATCHED_WEB=$((UNPATCHED_WEB + 1)); [ "$vd" = unknown ] && UNKNOWN_PKG=$((UNKNOWN_PKG + 1)); fi
    case "$ports" in *'->'*) PHP_ROUTED=1 ;; esac
    if [ "$vd" = patched ]; then ok "container $name ($img): PHP $pv, patched"
    else warn "container $name ($img): PHP ${pv:-version not declared} -> $vd${ports:+; publishes $ports}. Rebuild it from a patched image."; fi
  done <<<"$rowsd"
  [ "$any" -eq 0 ] && ok "no running container declares PHP_VERSION or looks PHP-based"
}

section_running_and_reachable() {
  title "Is PHP running, and can the internet reach it"
  local procs
  procs=$(ps -eo comm= 2>/dev/null | awk '/^(php-fpm|php-cgi|lsphp|frankenphp|apache2|httpd|litespeed|lshttpd|openlitespeed)/ { n[$1]++ } END { for (k in n) printf "%s x%d\n", k, n[k] }')
  if [ -n "$procs" ]; then PHP_RUNNING=1; warn "running now: $(tr '\n' ' ' <<<"$procs")"; else ok "no php-fpm, php-cgi, apache, LiteSpeed or FrankenPHP process is running"; fi
  if grep -qE '^(litespeed|lshttpd|openlitespeed|frankenphp)' <<<"$procs"; then PHP_ROUTED=1; warn "a web server that runs PHP itself (LiteSpeed or FrankenPHP) is running: PHP is treated as reachable"; fi

  # nginx: which server blocks hand requests to PHP (including through included files)
  if have nginx; then
    local dump rc routed err hits
    dump=$(nginx -T 2>/dev/null); rc=$?
    if [ "$rc" -ne 0 ] || ! grep -q '^# configuration file ' <<<"$dump"; then
      err=$(nginx -t 2>&1 | grep -v -e 'syntax is ok' -e 'test is successful' | head -2 | tr '\n' ' ')
      warn "nginx -T could not dump the configuration (${err:-exit status $rc}); reading the config files instead"
      hits=$(grep -RlsE '^[^#]*fastcgi_pass[[:space:]]' /etc/nginx/nginx.conf /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/snippets 2>/dev/null)
      if [ -n "$hits" ]; then PHP_ROUTED=1; warn "these nginx files pass requests to PHP (fastcgi_pass), so PHP is treated as reachable:"; lines "$hits"
      else ok "no fastcgi_pass in /etc/nginx/nginx.conf, sites-enabled, conf.d or snippets (read from the files)"; fi
    else
      routed=$(printf '%s\n' "$dump" | nginx_php_servers)
      if [ -n "$routed" ]; then
        PHP_ROUTED=1
        warn "nginx hands requests to PHP for these sites$(pgrep -x nginx >/dev/null 2>&1 || echo ' (nginx is not running right now)'):"
        while IFS=$'\t' read -r name how; do info "$name   ($how)"; done <<<"$routed"
      else ok "no nginx server block reaches fastcgi_pass, directly or through an include (nginx cannot reach PHP)"; fi
    fi
  else info "nginx is not installed here"; fi

  # apache: judged from the enabled config (works without root), plus whether it is running
  if [ -d /etc/apache2 ] || have httpd; then
    local modphp fpmh arunning=0
    pgrep -x apache2 >/dev/null 2>&1 || pgrep -x httpd >/dev/null 2>&1 && arunning=1
    modphp=$(ls /etc/apache2/mods-enabled/ 2>/dev/null | grep -E '^php[0-9.]*\.load$' | tr '\n' ' ')
    fpmh=$(grep -RlsiE '^[^#]*(SetHandler[[:space:]]+"?proxy:(unix|fcgi)|ProxyPassMatch.*fcgi://)' /etc/apache2/conf-enabled /etc/apache2/sites-enabled 2>/dev/null | tr '\n' ' ')
    if [ "$arunning" -eq 1 ] && { [ -n "$modphp" ] || [ -n "$fpmh" ]; }; then
      PHP_ROUTED=1
      [ -n "$modphp" ] && warn "apache is running with mod_php enabled ($modphp): the highest-risk setup, the bug fires before any application code runs"
      [ -n "$fpmh" ] && warn "apache is running and hands .php to php-fpm ($fpmh)"
    elif [ -n "$modphp$fpmh" ]; then info "apache is configured for PHP (${modphp}${fpmh}) but not running"
    elif [ "$arunning" -eq 1 ]; then ok "apache is running without mod_php or a php-fpm handler in conf-enabled/sites-enabled"
    else ok "apache is not running"; fi
  fi

  # php-fpm bound to a non-loopback TCP port is reachable by anyone who can reach the port
  local pools lis
  pools=$(grep -rhE '^[[:space:]]*listen[[:space:]]*=' /etc/php/*/fpm/pool.d/ 2>/dev/null | tr -s ' ' | tr '\n' ';')
  [ -n "$pools" ] && info "php-fpm pool listen settings: $pools"
  lis=$(ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -E ':(9000|9001)$' | grep -vE '^(127\.|\[::1\]|::1)' || true)
  lis="$lis$(ss -H -ltnp 2>/dev/null | awk '/php-fpm|php-cgi|lsphp/ {print $4}' | grep -vE '^(127\.|\[::1\]|::1)' || true)"
  if [ -n "$lis" ]; then PHP_ROUTED=1; fail "PHP FastCGI listens on a public address: $(tr '\n' ' ' <<<"$lis") (anyone who reaches it runs PHP, no web server involved; bind it to a unix socket or 127.0.0.1)"
  else ok "no PHP listener on a non-loopback TCP address"; fi
  have ufw && [ "$IS_ROOT" -eq 1 ] && info "ufw: $(ufw status 2>/dev/null | head -1)"
}

# An upgrade does not reach a process that was already running: php-fpm (and apache with mod_php)
# keep the old engine in memory until restarted. Both signals here are read-only.
section_running_old_code() {
  title "Does a running PHP process still use the engine from before the upgrade"
  local now pid ppid comm et pcomm exe series pkgf pkgt start stale="" checked=0
  now=$(date +%s)
  while read -r pid ppid comm et; do
    case "$comm" in php-fpm*|apache2|httpd) ;; *) continue ;; esac
    pcomm=$(ps -o comm= -p "$ppid" 2>/dev/null)
    [ "$pcomm" = "$comm" ] && continue                      # a worker: its master decides
    checked=$((checked + 1))
    exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
    case "$exe" in *'(deleted)'*) stale="$stale$comm pid $pid runs a binary that was replaced on disk ($exe)"$'\n'; continue ;; esac
    if [ "$comm" = apache2 ] || [ "$comm" = httpd ]; then
      grep -qE 'libphp.*\(deleted\)' "/proc/$pid/maps" 2>/dev/null && stale="$stale$comm pid $pid still maps a deleted mod_php library"$'\n'
      continue
    fi
    series="${comm#php-fpm}"
    pkgf="/var/lib/dpkg/info/php${series}-fpm.list"
    [ -n "$series" ] && [ -f "$pkgf" ] || continue
    pkgt=$(stat -c %Y "$pkgf" 2>/dev/null) || continue
    start=$((now - et))
    [ "$start" -lt $((pkgt - 5)) ] && stale="$stale$comm pid $pid started $(date -u -d "@$start" +'%F %T') UTC, before php${series}-fpm was installed or upgraded ($(date -u -d "@$pkgt" +'%F %T') UTC)"$'\n'
  done < <(ps -eo pid=,ppid=,comm=,etimes= 2>/dev/null)
  if [ -n "$stale" ]; then
    RESTART_NEEDED=1
    fail "a PHP process still runs the OLD engine: restart it (systemctl restart php8.3-fpm, or apache2) and re-run this check"
    lines "$stale"
  elif [ "$checked" -gt 0 ]; then ok "every running php-fpm / apache master started after its package was last installed or upgraded"
  else info "no php-fpm or apache master is running"; fi
}

section_verdict_exposure() {
  title "Exposure verdict"
  if [ "$UNPATCHED_WEB" -gt 0 ] && [ "$PHP_ROUTED" -eq 1 ]; then
    fail "EXPOSED: a PHP engine without a confirmed fix is reachable from the web. Patch or retire it NOW (runbook docs/superpowers/plans/2026-10-22-php2shell-runbook.md), then treat the box as possibly compromised."
  elif [ "$RESTART_NEEDED" -eq 1 ] && [ "$PHP_ROUTED" -eq 1 ]; then
    fail "EXPOSED: the fix is installed but a running process still uses the old engine and the web reaches it. Restart it now."
  elif [ "$UNPATCHED_WEB" -gt 0 ] && [ "$PHP_RUNNING" -eq 1 ]; then
    warn "an unpatched PHP engine is running but nothing found routes the web to it. Patch it or stop it; do not leave it as is."
  elif [ "$UNPATCHED_WEB" -gt 0 ]; then
    warn "an unpatched PHP web engine is installed but not running. Patch or remove it."
  elif [ "$PHP_ROUTED" -eq 1 ]; then
    ok "PHP is reachable from the web, every engine found carries the fix, and no running process uses the old one"
  else
    ok "no unpatched PHP web engine is reachable from the web"
  fi
  [ "$UNPATCHED_CLI" -gt 0 ] && info "unpatched PHP command line remains: it only matters if a cron job or worker feeds it untrusted input"
}

section_mitigations_in_place() {
  title "Interim mitigation settings found (informational; PHP says patching is the only complete fix)"
  local l
  l=$(grep -rhE '^[[:space:]]*(session\.upload_progress\.enabled|memory_limit|post_max_size|fatal_error_backtraces)[[:space:]]*=' /etc/php/*/fpm/php.ini /etc/php/*/fpm/conf.d/ 2>/dev/null | sort | uniq -c)
  l="$l"$'\n'"$(grep -rhE 'php_(admin_)?(value|flag)\[(session\.upload_progress\.enabled|memory_limit|post_max_size|fatal_error_backtraces)\]' /etc/php/*/fpm/pool.d/ 2>/dev/null)"
  if [ -n "$(tr -d '[:space:]' <<<"$l")" ]; then lines "$l"; else info "none found"; fi
}

# A PHP RCE runs as the php-fpm pool user. If that user can read the platform's .env files or the
# backups of them, the attacker gets JWT_SECRET, the database URL and every API key in one read.
section_platform_secrets() {
  title "Could PHP's user read the platform's secrets or backups"
  local u f mode d targets="" checked=0 newest
  for f in /opt/dashmani-platform/.env /opt/dashmani-platform/apps/api/.env /opt/dashmani-platform/packages/db/.env; do [ -e "$f" ] && targets="$targets$f"$'\n'; done
  for d in /opt/backups/dashmani /opt/backups/dashmani/pre-deploy; do
    [ -d "$d" ] || continue
    for f in 'config_*' 'db_*' '*'; do
      newest=$(ls -1t "$d"/$f 2>/dev/null | head -1)
      [ -n "$newest" ] && [ -f "$newest" ] && ! grep -qxF "$newest" <<<"$targets" && targets="$targets$newest"$'\n'
    done
  done
  [ -z "$targets" ] && { info "no platform .env file or backup under /opt to test (not the platform box?)"; return; }
  for u in $FPM_USERS; do
    id "$u" >/dev/null 2>&1 || continue
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      checked=$((checked + 1)); mode=$(stat -c '%a %U:%G' "$f" 2>/dev/null)
      if [ "$IS_ROOT" -eq 1 ] && have runuser; then
        if runuser -u "$u" -- test -r "$f" 2>/dev/null; then fail "$f is READABLE by $u (mode $mode): every secret in it is one PHP exploit away. Fix: chmod 600 $f (and chmod 700 its folder if it is a backup folder)"
        else ok "$f is not readable by $u (mode $mode)"; fi
      else
        # not root: judge by the 'other' bits of the file and every folder above it
        local p="$f" open=1
        [ "$(( 0$(stat -c '%a' "$f" 2>/dev/null) & 04 ))" -ne 0 ] || open=0
        while p=$(dirname "$p"); [ "$p" != / ]; do [ "$(( 0$(stat -c '%a' "$p" 2>/dev/null) & 01 ))" -ne 0 ] || open=0; done
        if [ "$open" -eq 1 ]; then warn "$f looks readable by anyone (mode $mode, folders traversable): judged from mode bits only, not root. chmod 600 $f"
        else info "$f: 'other' cannot read it (mode $mode); judged from mode bits only (not root)"; fi
      fi
    done <<<"$targets"
  done
}

WP_ROOTS=""
section_find_web_roots() {
  title "WordPress and other PHP sites on disk"
  local out rc
  out=$(low 120 find /var/www /srv /home /root /opt -xdev \( -name node_modules -o -name .git -o -name .next \) -prune -o -type f -name wp-config.php -print)
  rc=$?
  WP_ROOTS=$(printf '%s\n' "$out" | sed '/^$/d' | xargs -r -n1 dirname | sort -u)
  if [ -n "$WP_ROOTS" ]; then
    warn "WordPress installs found (a PHP site exists on this box):"
    lines "$WP_ROOTS"
    info "If nobody uses the site any more, the safest fix is to retire it (runbook, option B)."
  fi
  if [ "$rc" -eq 124 ]; then warn "the wp-config.php search timed out after 120 s: the list above may be INCOMPLETE"
  elif [ -z "$WP_ROOTS" ]; then ok "no wp-config.php found under /var/www /srv /home /root /opt"; fi
  [ -d /var/www ] && [ -n "$(ls -A /var/www 2>/dev/null)" ] && info "/var/www contains: $(ls -A /var/www | head -8 | tr '\n' ' ')"
}

section_compromise_hunt() {
  title "Signs of compromise since $SINCE (a clean result is not proof)"
  local roots="" r out rc
  for r in $WP_ROOTS /var/www /srv; do [ -d "$r" ] && roots="$roots $r"; done
  roots=$(printf '%s\n' $roots | sort -u | tr '\n' ' ')

  if [ -n "$(tr -d ' ' <<<"$roots")" ]; then
    out=$(low 180 find $roots -xdev -type f \( -iname '*.php' -o -iname '*.phtml' -o -iname '*.phar' -o -iname '*.php[0-9]' \) \( -path '*/uploads/*' -o -path '*/cache/*' -o -path '*/tmp/*' \) -print); rc=$?
    if [ -n "$out" ]; then fail "PHP files inside upload, cache or tmp folders (these should hold no code):"; lines "$(head -30 <<<"$out")"
    elif [ "$rc" -eq 124 ]; then warn "the uploads/cache/tmp search timed out: INCOMPLETE"
    else ok "no PHP files inside uploads, cache or tmp folders"; fi

    out=$(low 240 grep -rIlsE --include='*.php' --include='*.phtml' \
      -e 'eval[[:space:]]*\([[:space:]]*(base64_decode|gzinflate|gzuncompress|str_rot13)' \
      -e '(assert|system|passthru|shell_exec|exec|popen|proc_open)[[:space:]]*\([[:space:]]*\$_(POST|GET|REQUEST|COOKIE)' \
      -e 'FilesMan|c99shell|r57shell|b374k|WSO[[:space:]]shell' \
      -e 'pearcmd' $roots); rc=$?
    if [ -n "$out" ]; then fail "files matching web-shell signatures (open each one; a few plugins use eval legitimately):"; lines "$(head -30 <<<"$out")"
    elif [ "$rc" -eq 124 ]; then warn "the web-shell signature search timed out: INCOMPLETE"
    else ok "no web-shell signatures in the PHP files of those sites"; fi

    out=$(low 180 find $roots -xdev -type f -iname '*.php' -newermt "$SINCE" -printf '%TY-%Tm-%Td %TH:%TM  %p\n'); rc=$?
    if [ -n "$out" ]; then warn "PHP files changed since $SINCE (normal after a plugin or core update; unexpected otherwise), newest first:"; lines "$(sort -r <<<"$out" | head -25)"
    elif [ "$rc" -eq 124 ]; then warn "the changed-PHP-files search timed out: INCOMPLETE"
    else ok "no PHP file changed since $SINCE under those sites"; fi

    local mu
    for r in $(find $roots -maxdepth 4 -type d -name mu-plugins 2>/dev/null | head -5); do
      [ -n "$(ls -A "$r" 2>/dev/null)" ] && warn "must-use plugins (they load without being listed in the admin; backdoors hide here): $r: $(ls -A "$r" | head -10 | tr '\n' ' ')"
    done
    mu=$(find $roots -maxdepth 5 -type d \( -iname 'updraftplus' -o -iname 'updraftcentral*' \) 2>/dev/null | head -5)
    [ -n "$mu" ] && warn "UpdraftPlus/UpdraftCentral is installed ($(tr '\n' ' ' <<<"$mu")): Patchstack reports attackers using valid UpdraftCentral keys to install backdoors. Delete the keys in the dashboard and re-create them."
  else
    info "no PHP site directories to search"
  fi

  # Crash and out-of-memory traces. The trigger for both bugs is a fatal error (typically memory_limit)
  # during a multipart request. With php-fpm's default catch_workers_output=no that fatal is NOT in
  # php-fpm.log: nginx writes it to its error log ('FastCGI sent in stderr: ... Allowed memory size').
  local pd nd ed fpmlogs crashes=0 oom=0 n f logs_read=0
  pd=$(day_alternation "$SINCE" '%d-%b-%Y'); nd=$(day_alternation "$SINCE" '%d/%b/%Y'); ed=$(day_alternation "$SINCE" '%Y/%m/%d')
  fpmlogs=$(ls /var/log/php*-fpm.log* 2>/dev/null)
  if [ -n "$fpmlogs" ]; then
    logs_read=$((logs_read + $(wc -l <<<"$fpmlogs")))
    crashes=$(zgrep -hE "^\[($pd)" $fpmlogs 2>/dev/null | grep -cE 'exited on signal (4|6|7|8|11)|SIGSEGV|SIGABRT|Out of memory')
    n=$(zgrep -hE "^\[($pd)" $fpmlogs 2>/dev/null | grep -c 'Allowed memory size'); oom=$((oom + n))
    if [ "$crashes" -gt 0 ]; then warn "php-fpm workers crashed $crashes time(s) since $SINCE (unexplained worker restarts are a listed sign): grep -E 'exited on signal' /var/log/php*-fpm.log"
    else ok "no php-fpm worker crash in the php-fpm logs since $SINCE"; fi
  else info "no /var/log/php*-fpm.log to read"; fi
  for f in $(ls /var/log/nginx/*error*.log* 2>/dev/null); do
    logs_read=$((logs_read + 1))
    n=$(zgrep -hE "^($ed) " "$f" 2>/dev/null | grep -c 'Allowed memory size'); oom=$((oom + n))
  done
  for f in $(ls /var/log/apache2/*error*.log 2>/dev/null); do        # current files only: apache dates are not filtered
    logs_read=$((logs_read + 1))
    n=$(grep -c 'Allowed memory size' "$f" 2>/dev/null); oom=$((oom + ${n:-0}))
  done
  for r in $WP_ROOTS; do
    f="$r/wp-content/debug.log"; [ -r "$f" ] || continue
    logs_read=$((logs_read + 1))
    n=$(grep -E "^\[($pd)" "$f" 2>/dev/null | grep -c 'Allowed memory size'); oom=$((oom + n))
  done
  if [ "$logs_read" -eq 0 ]; then info "no php-fpm, nginx, apache or WordPress error log to read for out-of-memory fatals"
  elif [ "$oom" -ge 5 ]; then warn "'Allowed memory size ... exhausted' appears $oom times since $SINCE in $logs_read error logs: that fatal is the trigger, so look at when and from where"
  elif [ "$oom" -gt 0 ]; then info "'Allowed memory size' appears $oom time(s) since $SINCE in $logs_read error logs (a few are normal)"
  else ok "no 'Allowed memory size' fatal since $SINCE in $logs_read error logs"; fi

  # POSTs that ended in a server error. The shared nginx access.log also carries the platform's own API,
  # so in it only PHP-looking paths count; per-site and apache access logs count every POST.
  local acc hits="" base sel
  acc=$(ls /var/log/nginx/*access*.log* /var/log/apache2/*access*.log* 2>/dev/null)
  if [ -n "$acc" ]; then
    for f in $acc; do
      base=$(basename "$f")
      sel=$(zgrep -hE "\[($nd):" "$f" 2>/dev/null | grep -E '"(POST|PUT) [^"]* HTTP/[0-9.]+" (500|502|503|504) ')
      case "$f" in /var/log/nginx/access.log*) sel=$(grep -E '"(POST|PUT) ([^" ]*\.php|/wp-|/xmlrpc|/(\?[^" ]*)? )' <<<"$sel") ;; esac
      [ -n "$sel" ] && hits="$hits$sel"$'\n'
    done
    hits=$(sed '/^$/d' <<<"$hits")
    if [ -n "$hits" ]; then
      n=$(wc -l <<<"$hits" | tr -d ' ')
      warn "$n POST/PUT request(s) to PHP paths ended in a server error since $SINCE (the logs cannot show multipart bodies: a hint only). Top paths:"
      lines "$(awk '{print $7}' <<<"$hits" | sort | uniq -c | sort -rn | head -5)"
    else ok "no POST/PUT to a PHP path ended in a 5xx since $SINCE ($(wc -l <<<"$acc" | tr -d ' ') access logs read)"; fi
  else info "no nginx or apache access log to read"; fi

  # persistence
  local ch
  ch=$(find /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /var/spool/cron /etc/systemd/system /etc/ld.so.preload /etc/rc.local /root/.ssh /home/*/.ssh /etc/sudoers /etc/sudoers.d /etc/passwd /etc/shadow -xdev -type f -newermt "$SINCE" -printf '%TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort -r | head -20)
  if [ -n "$ch" ]; then warn "persistence-related files changed since $SINCE (unattended-upgrades and your own work explain some; anything else does not):"; lines "$ch"
  else ok "no cron, systemd, ssh key, sudoers or account file changed since $SINCE"; fi
  [ -e /etc/ld.so.preload ] && fail "/etc/ld.so.preload exists (rootkit persistence): $(head -3 /etc/ld.so.preload 2>/dev/null | tr '\n' ' ')"

  # processes of the PHP users, judged by the executable (a command line can be faked)
  local u pid exe args odd="" unk=0
  for u in $FPM_USERS; do
    id "$u" >/dev/null 2>&1 || continue
    for pid in $(pgrep -u "$u" 2>/dev/null); do
      exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
      [ -z "$exe" ] && { unk=$((unk + 1)); continue; }
      case "$exe" in
        *'(deleted)'*) ;;
        /usr/sbin/php-fpm[0-9]*|/usr/sbin/nginx|/usr/sbin/apache2|/usr/sbin/httpd|/usr/sbin/lshttpd|/usr/local/lsws/*) continue ;;
      esac
      args=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-160)
      odd="$odd$u pid $pid  exe=$exe  args=$args"$'\n'
    done
  done
  if [ -n "$odd" ]; then fail "processes of the PHP users ($FPM_USERS) that are not nginx, apache or php-fpm (by executable):"; lines "$odd"
  elif [ "$unk" -gt 0 ]; then warn "$unk process(es) of $FPM_USERS could not be inspected (not root): re-run as root"
  else ok "the PHP users ($FPM_USERS) run nothing except nginx, apache and php-fpm"; fi

  local out2
  out2=$(ss -H -tnp 2>/dev/null | awk '$1=="ESTAB" && /php-fpm|php-cgi|lsphp|apache2|httpd|litespeed/ && $5 !~ /^(127\.|\[::1\])/ {print $4 " -> " $5 "  " $6}' | head -10)
  if [ -n "$out2" ]; then warn "PHP workers hold outbound connections right now (WordPress update checks are normal; reverse shells are not):"; lines "$out2"
  elif [ "$IS_ROOT" -eq 1 ]; then ok "no outbound connection from PHP workers at this moment"
  else info "outbound connections of PHP workers need root to see"; fi
}

section_next_steps() {
  title "Summary"
  printf 'OK %d   WARN %d   FAIL %d\n' "$OK" "$WARN" "$FAIL"
  if [ "$FAIL" -gt 0 ]; then
    cat <<'EOF'
Next: patch or stop PHP first (runbook docs/superpowers/plans/2026-10-22-php2shell-runbook.md, options A or B),
restart php-fpm, then re-run this check the same way you ran it.
If any "compromise" FAIL line above is real: shut the door first (stop php-fpm and remove the PHP vhost), keep a
copy of the files named, and follow the runbook's step 2 (what to rotate and which database rows to review).
EOF
  elif [ "$WARN" -gt 0 ]; then
    echo "No FAIL, but read each WARN line. Patching (or retiring PHP) is still the action: the runbook has the commands."
  else
    echo "Nothing found. Keep unattended security upgrades on so the next PHP fix lands by itself."
  fi
}

main() {
  case "${1:-}" in
    --self-test) self_test; exit $? ;;
    -h|--help)   usage; exit 0 ;;
    "")          ;;
    *)           echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  local s
  s=$(valid_since "$SINCE") || { echo "SINCE must be a real past date written YYYY-MM-DD (got '$SINCE')" >&2; exit 2; }
  SINCE="$s"
  echo "PHP2Shell (CVE-2026-109618 / CVE-2026-109619) read-only check"
  section_identity
  section_packages
  section_other_php
  section_running_and_reachable
  section_running_old_code
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
