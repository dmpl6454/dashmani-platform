# PHP2Shell on the production box: check, patch or retire PHP, and what to rotate

**Written 2026-10-22.** The platform itself (Express API + five Next.js apps) contains no PHP, so
nothing in this repository is vulnerable. The risk is the **WordPress site that shares the
production box** (`php8.3-fpm` + `mysqld`, present since about 2 Sep 2026; see the 2026-09-08 incident
file). A PHP exploit on that box runs as `www-data` on the same machine as the API, the database and
`apps/api/.env`. That is why this is a platform problem.

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
| Not a fix | WordPress core or plugin updates (the bug is in the engine), Cloudflare WAF rules alone (they only help if the origin takes traffic from Cloudflare only; our `ufw` allows 80/443 from anywhere), copy-pasted "fix" plugins |

Sources: php.net advisory via Patchstack, Sansec, Tenable, Ubuntu USN-8948-1 (all read 2026-10-22).

## Step 0: run the check (read-only, 1–3 minutes)

From a laptop, without merging anything:

```bash
git fetch origin claude/awesome-bohr-qu8x1k
git show origin/claude/awesome-bohr-qu8x1k:scripts/php2shell-check.sh | ssh dashmani-prod 'bash -s'
```

(`dashmani-prod` is 172.105.53.101. The older `linode` alias is the sales-agent box; the script warns
when `/opt/dashmani-platform` is missing.) It prints `[FAIL]`, `[WARN]` and `[ OK ]` lines and never
changes anything. Read every `[FAIL]` and `[WARN]`. The three questions it answers:

1. Is an unpatched PHP engine installed, and does nginx route the web to it?
2. Can `www-data` read `/opt/dashmani-platform/apps/api/.env`?
3. Is there any sign PHP was already used: web shells, changed PHP files, worker crashes, odd processes.

## Step 1: close the hole. Pick A or B today; C only buys hours.

### A. Patch (if the WordPress site is still wanted)

```bash
ssh dashmani-prod
apt-get update
apt-cache policy php8.3-fpm          # Candidate must be 8.3.6-0ubuntu0.24.04.13 or newer
                                     # (Sury PPA: 8.3.36-1+ubuntu24.04.1+deb.sury.org+1 or newer)
apt-get install --only-upgrade 'php8.3-*' libapache2-mod-php8.3 2>/dev/null || apt-get install --only-upgrade 'php8.3-*'
systemctl restart php8.3-fpm         # the old binary stays in memory until every worker restarts
dpkg -l php8.3-fpm php8.3-cli | awk '/^ii/ {print $2, $3}'
bash /opt/dashmani-platform/scripts/php2shell-check.sh   # must report no "NOT patched" engine
```

If `apt-cache policy` still shows `.11` or `.12` as the Candidate, the mirror has not caught up: apply
C now and retry A every few hours. Do not install a PHP from an unknown deb or a "fix plugin".
(Checked 2026-10-22 00:45 UTC from an Ubuntu 24.04 machine: `noble-security` already served
`8.3.6-0ubuntu0.24.04.13`, whose changelog names `CVE-2026-109618_109619.patch`, and the install line
above upgraded `php8.3-cli`/`-common` from `.11` to `.13`. The many "Skipping php8.3-xyz, it is not
installed" lines it prints are normal: the pattern covers every php8.3 package and only installed ones
are upgraded.)

The upgrade restarts php-fpm (a few seconds of 502 for the WordPress site only; the API, portals and
Postgres are not touched). It does not need a deploy.

### B. Retire PHP (if the WordPress site is no longer needed, or can live elsewhere)

The 2026-09-08 incident already lists "the company WordPress site off the 2 GB box" as an owner
decision. The safest end state for the platform is no PHP engine on this machine at all.

```bash
ssh dashmani-prod
# 1. keep a copy first (site files + database), then nothing below can lose anything
nginx -T 2>/dev/null | grep -B12 fastcgi_pass | grep -E 'server_name|root' # which vhost and which folder is the WordPress site
mkdir -p /root/wordpress-retire-$(date +%F)
mysqldump --all-databases --single-transaction > /root/wordpress-retire-$(date +%F)/mysql-all.sql
tar -czf /root/wordpress-retire-$(date +%F)/site.tgz <the root folder from the grep above>
# 2. stop the engine
systemctl stop php8.3-fpm && systemctl disable php8.3-fpm
# 3. remove the PHP vhost from nginx (replace with a 503 page or a redirect, your call)
#    edit the site file in /etc/nginx/sites-enabled/, then:
nginx -t && systemctl reload nginx
# 4. later, once nobody misses it
apt-get purge 'php8.3-*' php-common && apt-get autoremove
bash /opt/dashmani-platform/scripts/php2shell-check.sh   # "no PHP engine package" + "nginx cannot reach PHP"
```

If the WordPress site is `digitalsukoon.com` itself: the repository's `nginx/digitalsukoon.com` serves
the **static Next.js export** (`apps/web/out`), not PHP, so check which site file is actually enabled
before assuming the marketing site needs PHP.

### C. Interim mitigation only (hours, not days; PHP says this does NOT make the install safe)

Put these in the php-fpm pool, not in `.user.ini` or `ini_set()`, then restart every worker:

```ini
# /etc/php/8.3/fpm/pool.d/www.conf  (or the WordPress pool)
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
# inside the WordPress server { } block
if ($http_content_type ~* "multipart/form-data") { return 403; }
```

The 403 breaks media uploads and any form that posts files. The API vhost must not get this rule (the
campaign uploads are `application/octet-stream`, but the client portal's other forms are not).

A memory cgroup on php-fpm (`systemctl set-property php8.3-fpm.service MemoryMax=400M`) bounds the
damage of `memory_limit=-1` on the 2 GB box; it is not a mitigation of the bug.

## Step 2: decide whether the box was already hit

The script's compromise section is a hint, not proof. Treat the box as possibly compromised if any of
these is true: PHP files inside `uploads/`, `cache/` or `tmp/`; files matching web-shell signatures; PHP
files changed since 2026-10-18 that nobody updated; php-fpm workers that died on a signal; processes
owned by `www-data` that are not nginx or php-fpm; `/etc/ld.so.preload` exists; a cron, systemd unit,
ssh key or sudoers file changed that nobody changed.

If so, in this order:

1. Stop php-fpm and remove the PHP vhost (option B steps 2–3) so the door is shut while you look.
2. Keep the evidence: copy the named files and the logs to `/root/php2shell-$(date +%F)/` before
   touching them.
3. Rotate what PHP could read or what its memory could leak:
   - WordPress: database password in `wp-config.php` (and in MySQL), all eight salts, every admin
     password, every API key stored in plugins, **UpdraftCentral keys** (Patchstack reports attackers
     using valid keys to install backdoors; delete and re-create them).
   - If the check reported `apps/api/.env` readable by `www-data`: rotate `JWT_SECRET`
     (signs everyone out), `JWT_REFRESH_SECRET`, `CREATOR_JWT_*`, the Postgres password in
     `DATABASE_URL` (all three `.env` files + `pm2 restart api`), `RAZORPAY_KEY_SECRET` and
     `RAZORPAY_WEBHOOK_SECRET` (dashboard), `META_TOKEN_ENC_KEY` cannot be rotated without
     reconnecting Meta, the `META_OAUTH_*` app secret (Meta app dashboard), `SMTP_PASS` (a new Gmail app
     password), `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `YOUTUBE_API_KEY`.
   - Then `chmod 600` the three `.env` files so this cannot repeat.
4. Rebuild rather than clean: a WordPress install with a confirmed shell is reinstalled from a clean
   core + plugins with the database restored from a backup taken before 2026-10-18 if one exists, or the
   current database after a review of the `wp_users` and `wp_options` tables.

## Step 3: keep it closed

- Whatever you chose, re-run the check script and keep its output with the date.
- Unattended-upgrades is on (it is what restarted Postgres on 2026-09-11). Confirm `noble-security`
  is in `/etc/apt/apt.conf.d/50unattended-upgrades` `Allowed-Origins`, so the next PHP security
  release lands by itself.
- Optional hardening with real blast radius, so an owner decision: restrict 443 on `ufw` to Cloudflare's
  published ranges. It makes Cloudflare's WAF rules effective for every proxied host, but anything that
  reaches the box directly by IP (nothing should, if every record is orange-clouded) stops working.
  Test with the API health check and a Razorpay webhook replay before and after.
- The lasting answer stays the one already on record: the WordPress tenant off the platform box.

## Script self-test

`bash scripts/php2shell-check.sh --self-test` runs the version and nginx-parsing logic against fixed
inputs without reading the host. Add a line to the version table in the script when a new fixed
version is published.
