# PHP2Shell on the production box: check, patch or retire PHP, and what to rotate

**Written 2026-10-22, revised 2026-10-23 after review.** The platform itself (Express API + five
Next.js apps) contains no PHP, so nothing in this repository is vulnerable. The risk is the
**WordPress site that shares the production box** (`php8.3-fpm` + `mysqld`, present since about
2 Sep 2026; see the 2026-09-08 incident file). A PHP exploit on that box runs as the php-fpm user
(`www-data`) on the same machine as the API, Postgres, `apps/api/.env` and the backups in
`/opt/backups`. That is why this is a platform problem.

## What the attack is

| | |
|---|---|
| Name | "PHP2Shell": CVE-2026-109618 (out-of-memory corruption in request setup) and CVE-2026-109619 (stale request state used after it is freed) |
| Severity | both CVSS v4.0 **9.2**, unauthenticated remote code execution; memory disclosure is a confirmed impact (worker memory can come back inside a `PHPSESSID` cookie) |
| Who is affected | every web-serving PHP since 5.4: php-fpm, mod_php (highest risk), php-cgi, FrankenPHP, LiteSpeed; default configuration is enough |
| Fixed upstream | **2026-10-21**: PHP 8.5.12, 8.4.27, 8.3.36, 8.2.35. PHP 8.1 and older: no upstream release, only vendor backports |
| Fixed on Ubuntu | USN-8948-1, same day: 24.04 `php8.3` **8.3.6-0ubuntu0.24.04.13**, 22.04 `php8.1` 8.1.2-1ubuntu2.28 (the version number stays small; the fix is a backport, so compare with the vendor string, not with 8.3.36) |
| Exploitation | attempts seen from 2026-10-21 07:43 UTC, before the fix was out. Reports disagree on how widespread real breaches are; mass exploitation is expected now that writeups are public |
| Trigger | a fatal error during a request, typically `memory_limit` exhausted by a `multipart/form-data` request; the next request on the same worker reads freed memory |
| Not a fix | WordPress core or plugin updates (the bug is in the engine), Cloudflare WAF rules alone (they only help if the origin takes traffic from Cloudflare only; our `ufw` allows 80/443 from anywhere), copy-pasted "fix" plugins, upgrading the package without restarting php-fpm |

Sources: php.net advisory via Patchstack, Sansec, Tenable, Ubuntu USN-8948-1 (all read 2026-10-22).

## Step 0: run the check (read-only, 1–3 minutes)

On the box, as root (copies the one file out of the branch; the checkout stays on `main`):

```bash
cd /opt/dashmani-platform
git fetch origin claude/awesome-bohr-qu8x1k
git show origin/claude/awesome-bohr-qu8x1k:scripts/php2shell-check.sh > /root/php2shell-check.sh
bash /root/php2shell-check.sh 2>&1 | tee /root/php2shell-$(date +%F-%H%M).log
```

Or from a laptop with the repository:
`git show origin/claude/awesome-bohr-qu8x1k:scripts/php2shell-check.sh | ssh dashmani-prod 'bash -s'`.

⚠️ Never `git checkout`, `pull` or `merge` that branch on the box: production stays on `main`, and
`scripts/deploy.sh` resets to it. The re-runs below use `/root/php2shell-check.sh`; a path under
`/opt/dashmani-platform/scripts/` only exists once the script reaches `main` (a normal deploy, with
its pm2 restarts).

(`dashmani-prod` is 172.105.53.101. The older `linode` alias is the sales-agent box; the script warns
when `/opt/dashmani-platform` is missing.) It prints `[FAIL]`, `[WARN]` and `[ OK ]` lines and never
changes anything. Read every `[FAIL]` and `[WARN]`; a search that timed out says INCOMPLETE. It answers:

1. Is an engine without a confirmed fix installed (dpkg, outside dpkg, or in a container), and does
   nginx, apache or a public FastCGI port reach it? Is php-fpm still running the pre-upgrade engine?
2. Can the php-fpm user read the platform's `.env` files or the backups in `/opt/backups`?
3. Is there any sign PHP was already used: web shells, changed PHP files, worker crashes,
   out-of-memory fatals, odd processes, changed cron/ssh/systemd files.

## Step 1: close the hole. Pick A or B today; C only buys hours.

### A. Patch (if the WordPress site is still wanted)

```bash
apt-get update
apt-cache policy php8.3-fpm          # Candidate must be 8.3.6-0ubuntu0.24.04.13 or newer
                                     # (Sury PPA: 8.3.36-1+ubuntu24.04.1+deb.sury.org+1 or newer)
NEEDRESTART_MODE=l apt-get install --only-upgrade '^php8\.3-' '^libapache2-mod-php8\.3$'
systemctl restart php8.3-fpm         # the old engine stays in memory until php-fpm restarts
dpkg -l php8.3-fpm php8.3-cli | awk '/^ii/ {print $2, $3}'
bash /root/php2shell-check.sh        # must end with no FAIL and no "NOT patched" line
```

- `NEEDRESTART_MODE=l` makes needrestart only **list** services with stale libraries instead of
  offering to restart them. Without it an interactive "Services to be restarted" dialog can pre-select
  `postgresql@16-main` and `pm2-root` (every pm2 app). If such a dialog appears anyway, untick
  everything except `php8.3-fpm`.
- The two patterns are anchored regular expressions: every installed `php8.3-*` package is upgraded
  together (extensions pin `php8.3-common` to the same version), and a pattern for a package that is
  not installed only prints "Skipping …, it is not installed". Any other error (the dpkg lock held by
  the nightly unattended-upgrades run, "dpkg was interrupted") is a real failure: read it, wait or run
  `dpkg --configure -a`, and repeat.
- If `apt-cache policy` still shows `.11` or `.12`, the mirror has not caught up: apply C now and
  retry A every few hours. Do not install a PHP from an unknown deb or a "fix plugin".
- Checked 2026-10-22 00:45 UTC on an Ubuntu 24.04 machine: `noble-security` served
  `8.3.6-0ubuntu0.24.04.13`, whose changelog names `CVE-2026-109618_109619.patch`, and the upgrade
  moved `php8.3-cli`/`-common` from `.11` to `.13`.
- Done this way, only php-fpm restarts (a few seconds of 502 for the WordPress site). The API, the
  portals and Postgres are not touched and no deploy is needed.

### B. Retire PHP (if the WordPress site is no longer needed, or can live elsewhere)

The 2026-09-08 incident already lists "the company WordPress site off the 2 GB box" as an owner
decision. The safest end state for the platform is no PHP engine on this machine at all.

```bash
# 1. Which site and which folder: the check's "WordPress installs found" lines name the folders that
#    hold wp-config.php; this names the nginx files that pass requests to PHP.
grep -RlsE '^[^#]*fastcgi_pass' /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/snippets
D=/root/wordpress-retire-$(date +%F); mkdir -p "$D"; chmod 700 "$D"
WP=<the folder holding wp-config.php>; ls "$WP/wp-config.php"
df -h /root; du -sh "$WP"            # the dump + tarball must fit; Postgres shares this disk

# 2. Stop the engine first, so nothing writes while you copy
systemctl stop php8.3-fpm && systemctl disable php8.3-fpm

# 3. Keep a copy (database + files) and PROVE the dump is complete before going further
mysqldump --all-databases --single-transaction --routines --events | gzip > "$D/mysql-all.sql.gz"
zcat "$D/mysql-all.sql.gz" | tail -n1 | grep -q 'Dump completed' && echo DUMP OK || echo "DUMP FAILED: stop here"
#    "Access denied": MySQL root no longer uses auth_socket. Use the site's own credentials instead:
#    mysqldump -u<DB_USER> -p --databases <DB_NAME> --single-transaction | gzip > "$D/mysql-site.sql.gz"
#    (DB_USER / DB_NAME are in $WP/wp-config.php)
tar -czf "$D/site.tgz" -C "$(dirname "$WP")" "$(basename "$WP")" && ls -lh "$D"

# 4. Remove the PHP vhost from nginx (replace it with a 503 page or a redirect, your call), then:
nginx -t && systemctl reload nginx

# 5. Later, once nobody misses it
NEEDRESTART_MODE=l apt-get purge '^php8\.3-' php-common && NEEDRESTART_MODE=l apt-get autoremove
bash /root/php2shell-check.sh        # "no PHP engine package" and "nginx cannot reach PHP"
```

If the WordPress site is `digitalsukoon.com` itself: the repository's `nginx/digitalsukoon.com` serves
the **static Next.js export** (`apps/web/out`), not PHP, so check which site file is actually enabled
before assuming the marketing site needs PHP.

### C. Interim mitigation only (hours, not days; PHP says this does NOT make the install safe)

Put these in the php-fpm pool, not in `.user.ini` or `ini_set()`, then restart every worker:

```ini
; /etc/php/8.3/fpm/pool.d/www.conf  (or the WordPress pool)
php_admin_flag[session.upload_progress.enabled] = off     ; CVE-2026-109619
php_admin_value[memory_limit] = -1                         ; CVE-2026-109618 (removes the OOM trigger;
                                                           ; one request may now use all memory, so:)
php_admin_value[post_max_size] = 8M                        ; 32M if media uploads are needed
php_admin_value[upload_max_filesize] = 4M                  ; must stay below post_max_size
```

```bash
systemctl restart php8.3-fpm
```

Then, in the **PHP vhost only**, cap the body nginx accepts (`client_max_body_size 8m;`) and, if the
site needs no uploads at all, refuse multipart requests outright:

```nginx
# inside the WordPress server { } block (an `if` that only returns is safe in server context)
if ($http_content_type ~* "multipart/form-data") { return 403; }
```

The 403 breaks media uploads and any form that posts files. The platform's vhosts must not get this
rule (job applications and the portals' file forms are multipart).

`memory_limit=-1` lets one request take all memory on the 2 GB box, where the API and Postgres live.
Bound php-fpm with a cgroup, measured first:

```bash
systemctl show -p MemoryCurrent -p MemoryPeak php8.3-fpm          # a normal day's usage
systemctl set-property php8.3-fpm.service MemoryHigh=350M MemoryMax=600M   # persistent until undone
# undo (also after option B):  systemctl set-property php8.3-fpm.service MemoryHigh= MemoryMax=
```

`MemoryHigh` slows the pool down under pressure; `MemoryMax` kills a worker. Worker deaths on
signal 9 after this change are the cgroup, not PHP2Shell.

## Step 2: decide whether the box was already hit

The check's compromise section is a hint, not proof. Treat the box as possibly compromised if any of
these is true: PHP files inside `uploads/`, `cache/` or `tmp/`; files matching web-shell signatures;
PHP files changed since 2026-10-18 that nobody updated; php-fpm workers that died on a signal; a
burst of "Allowed memory size" fatals; processes of the PHP user that are not nginx, apache or php-fpm;
`/etc/ld.so.preload` exists; a cron, systemd unit, ssh key or sudoers file changed that nobody changed.

If so, in this order:

1. **Shut the door:** stop php-fpm and remove the PHP vhost (option B steps 2 and 4).
2. **Keep the evidence:** copy the named files and the logs to `/root/php2shell-$(date +%F)/`
   (`chmod 700`) before touching them.
3. **WordPress:** rotate the database password in `wp-config.php` (and in MySQL), all eight salts,
   every admin password, every API key stored in plugins, and the **UpdraftCentral keys** (Patchstack
   reports attackers using valid keys to install backdoors: delete and re-create them). Rebuild rather
   than clean: reinstall core and plugins from clean copies; restore the database from a backup older
   than 2026-10-18 if one exists, otherwise review `wp_users` and `wp_options` first.
4. **The platform, if the check said the PHP user could read `apps/api/.env` or anything in
   `/opt/backups`.** Assume everything in those files is known and that the attacker could write to
   the platform database (`DATABASE_URL` is the owner role of every table). Rotating secrets does not
   undo rows, so do both:

   a. **Database rows** (as the `dashmani` role or postgres):
   ```sql
   DELETE FROM otp_tokens;            -- password-reset tokens are stored as issued: void them
   DELETE FROM refresh_tokens;        -- signs every staff/HR/client session out
   DELETE FROM creator_refresh_tokens; DELETE FROM creator_oauth_states;
   UPDATE admin_invites  SET used_at = now() WHERE used_at IS NULL;
   UPDATE client_invites SET used_at = now() WHERE used_at IS NULL;
   SELECT id, email, status, created_at, updated_at FROM users   WHERE created_at > '2026-10-18' OR updated_at > '2026-10-18';
   SELECT user_id, role_id, created_at FROM user_roles           WHERE created_at > '2026-10-18';
   SELECT id, email, status, created_at FROM clients             WHERE created_at > '2026-10-18';
   SELECT id, email, status, created_at FROM creators            WHERE created_at > '2026-10-18';
   SELECT * FROM audit_logs WHERE created_at > '2026-10-18' ORDER BY created_at;
   \du                                -- any database role nobody created?
   ```
   Check each row you did not expect before deleting it. Then change the database password
   (`ALTER USER dashmani PASSWORD '…'`, the new value in all three `.env` files, `pm2 restart api`).

   b. **Secrets, with their side effects:**
   - `JWT_SECRET`, `JWT_REFRESH_SECRET`: signs everyone out of the internal, HR and client portals.
     Campaign media links are signed with `CAMPAIGN_MEDIA_URL_SECRET` when it is set, otherwise with
     `JWT_SECRET`: check for items mid-publish (`queued`, or locked) before rotating.
   - `CREATOR_JWT_SECRET`, `CREATOR_JWT_REFRESH_SECRET`: signs every creator out.
   - `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` (Razorpay dashboard; update the webhook too).
   - `META_SYSTEM_USER_TOKEN` (never expires: regenerate it in Business Manager and remove the old
     one) and `META_APP_SECRET` (the "Dashmani Insights" app).
   - `META_OAUTH_APP_SECRET` ("Post Automation 2"): ⚠️ the app is shared with postautomation.co.in and
     the creators portal, so a reset breaks them until each has the new secret. Coordinate with the
     postautomation.co.in owner, update `apps/api/.env` (and `CREATOR_META_APP_SECRET` if split), then
     `pm2 restart api`.
   - `META_TOKEN_ENC_KEY`: with the database it decrypts every stored Meta token. Rotate it, have the
     staff grantor remove "Post Automation 2" under Facebook Settings → Apps and websites and reconnect,
     and email every creator with a connection to reconnect.
   - `SMTP_PASS` (a new Gmail app password), `GOOGLE_CLIENT_ID` needs nothing (it is public), and every
     AI or API key present: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`,
     `DEEPSEEK_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `YOUTUBE_API_KEY` (list what exists with
     `grep -oE '^[A-Z0-9_]+=' /opt/dashmani-platform/apps/api/.env`).
   - `SEED_ADMIN_PASSWORD` in `packages/db/.env` and the `admin@digitalsukoon.com` password itself.

   c. **Close the read path so it cannot repeat:**
   ```bash
   chmod 600 /opt/dashmani-platform/.env /opt/dashmani-platform/apps/api/.env /opt/dashmani-platform/packages/db/.env
   chmod 700 /opt/backups /opt/backups/dashmani /opt/backups/dashmani/pre-deploy
   find /opt/backups -type f -exec chmod 600 {} +
   ```
   The API runs as root under pm2, so nothing else needs to read them. `scripts/backup.sh` and
   `scripts/pre-deploy-backup.sh` now write with `umask 077` (on the box once they reach `main`).

Even when the check found nothing, step 4c costs nothing and should be done today.

## Step 3: keep it closed

- Re-run `/root/php2shell-check.sh` after whatever you chose and keep the log with its date.
- Unattended security upgrades: confirm they are on and include the security pocket, and see whether
  the PHP fix already arrived by itself:
  ```bash
  grep -n 'codename}-security' /etc/apt/apt.conf.d/50unattended-upgrades     # must be an uncommented line
  grep 'Allowed origins' /var/log/unattended-upgrades/unattended-upgrades.log | tail -1   # lists a=noble-security
  grep -h php8.3 /var/log/unattended-upgrades/unattended-upgrades.log | tail -3
  ```
  Even when it upgrades PHP by itself, needrestart only lists php-fpm when it runs unattended: the
  check's "still runs the OLD engine" line is how you notice.
- Optional hardening with real blast radius, so an owner decision: accept 80/443 only from Cloudflare.
  ufw takes the FIRST matching rule, so the broad rules must go, IPv4 and IPv6 both:
  ```bash
  ufw status numbered                                  # note the '80/tcp ALLOW Anywhere' and '443/tcp ALLOW Anywhere' rules, and their (v6) twins
  for r in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
    ufw allow proto tcp from "$r" to any port 80,443
  done
  ufw delete <number>                                   # each broad 80/443 rule, highest number first
  ufw status                                            # then verify:
  curl -s https://api.digitalsukoon.com/v1/health       # still {"success":true}
  ```
  From a machine that is not behind Cloudflare, `curl -m5 -k https://172.105.53.101` must now time
  out. SSH (22) is untouched, so deploys keep working. Cloudflare's ranges change occasionally; refresh
  the rules when they do.
- The lasting answer stays the one already on record: the WordPress tenant off the platform box.

## Script self-test

`bash scripts/php2shell-check.sh --self-test` runs the version, nginx-parsing (including
`nginx -T`'s multi-file dumps) and date logic against fixed inputs without reading the host. Add a
line to the version table in the script when a new fixed version is published.
