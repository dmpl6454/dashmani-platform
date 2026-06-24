# Facebook Insights — the App-Review unlock (ops task, not code)

**Status (2026-06-24):** Facebook post enrichment returns **0 readable** — the
code is complete and correct, but Meta blocks Page **content** reads until the
Dashmani Insights app passes App Review. This doc is the unlock path. Everything
downstream (the Top Facebook Links panel, link-search FB coverage) auto-fills the
moment this clears — **no further code.**

---

## What we proved (3 live probes, conclusive)

The tracked FB accounts DO overlap our 87 managed Pages (TellyDramaTv → "Telly
Drama Paparazzi", PapHQ → "Pap HQ", Bollywood Chronicle, the Paparazzi/Bollywood
family). So this is **not** an ownership problem. The wall is App Review:

| Probe | Result |
|---|---|
| `GET /{post-id}` (read a post by id) | `(#10) Application does not have permission` |
| `GET /{page-id}/feed` with the System User token | `(#10) requires pages_read_engagement` |
| `GET /{page-id}/feed` with a **valid Page access token** (the two-step) | **still** `(#10) requires pages_read_engagement` |
| `GET /{page-id}/published_posts` | `(#210) page access token required` |

The token's `debug_token` scopes **already list** `pages_read_engagement` — but
Meta does **not honor** it for Page CONTENT reads while the app is in
Development/Standard mode. Instagram works because `instagram_basic` +
`instagram_manage_insights` ARE honored; Facebook Page content reads require App
Review. **No code path bypasses this** — feed-paging, Page tokens, every edge were
tested and all hit the same `(#10)`.

---

## The unlock (do this in Meta's dashboard)

App: **Dashmani Insights** (App ID `998903906094758`), under the Digital Sukoon /
Dashmani business portfolio.

1. **Business verification** — Meta Business Settings → Security Center → complete
   business verification if not already done (required before App Review for these
   permissions).
2. **Request the permission** — App Dashboard → App Review → Permissions and
   Features → request **`pages_read_engagement`** (Advanced Access). For reading
   posts on Pages you don't have a direct admin role on, you may also need the
   **Page Public Content Access** feature — request it too if the System User isn't
   an explicit admin of every tracked Page.
3. **Provide the use-case + screencast** — Meta requires a written use case ("read
   engagement metrics + captions of our managed Pages' posts for internal
   analytics") and a screencast showing the data flow. Use the existing
   `/reports` Link Search + Top Facebook Links panel as the demo surface.
4. **Submit + wait** — review is typically days to ~2 weeks. Until approved, only
   Pages where the System User has an explicit admin role return content (good for
   a pre-approval smoke test).
5. **After approval** — no token regeneration is strictly required (the scope is
   already on the token), but if reads still 401, regenerate the System User token
   (Business Settings → System Users → generate token → Dashmani Insights → Never)
   and update prod `META_SYSTEM_USER_TOKEN` in `apps/api/.env`, then `pm2 restart api`.

---

## Verify it worked (one command)

```bash
ssh linode 'cd /opt/dashmani-platform && TOKEN=$(grep -E "^META_SYSTEM_USER_TOKEN=" apps/api/.env | cut -d= -f2-) \
  && PID=$(curl -s "https://graph.facebook.com/v21.0/me/accounts?fields=id&limit=1&access_token=$TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"data\"][0][\"id\"])") \
  && curl -s "https://graph.facebook.com/v21.0/$PID/feed?fields=id,message,likes.summary(true)&limit=2&access_token=$TOKEN"'
```
If this returns post rows (not `(#10)`), FB is unlocked. Then the existing 6h cron
enriches FB automatically (the provider already pages owned-Page feeds the same way
IG does — see note below), and the Top Facebook Links panel + link-search FB
coverage fill in with no code change.

> **Code note for whoever picks this up:** the *current* `facebook.provider.ts`
> still reads by `GET /{post-id}` (the path that returns `(#10)`). Once App Review
> clears, switch its `fetchBatch` to the **owned-Page feed-paging** pattern that
> Instagram already uses (`harvestContent()` + a per-Page `/feed` map keyed by
> `canonicalKey`) — fetch each managed Page's access_token, page `/{page-id}/feed`,
> match by `fb:<numericId>`. The architecture (provider/cron/link_content/banner)
> is already in place; only the FB `fetchBatch` body changes. Bound it like IG
> (`FB_BACKFILL_MAX_PAGES`, 90-day window, `fbRateLimited` short-circuit). Realistic
> yield even then: the clean `/reel/<id>` slice (~3,400 / 18% of FB links) on
> managed Pages — the opaque `/share/` 81% stays forward-only via the submit-time
> resolver. Keep the coverage banner honest.

---

## Until then (current honest behavior — already shipped)

- **Top Facebook Links** panel renders a "Facebook insights pending Meta approval"
  state (not a fake-empty table).
- **Link Search** coverage shows Facebook as `0 searchable of <submitted>` with a
  "pending Meta approval" note — and the self-healing denominator means failed FB
  attempts never inflate the searchable tally.
- Submit-time opaque-`/share/` resolution still runs (fail-open) so new FB links
  come in cleaner for the day the API opens up.
