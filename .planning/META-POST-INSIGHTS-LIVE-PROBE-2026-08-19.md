# Meta post-level insights — LIVE-PROBED metric reference (2026-08-19)

Probed from the Linode prod IP against the **real Graph API v21.0** using the existing
`META_SYSTEM_USER_TOKEN`. Recorded because this codebase's repeated lesson is that
**mocks cannot catch Graph API field-shape lies** — every line below was observed, not
inferred from docs.

> ⚠️ No credentials in this file. The "Post Automation 2" app secret lives only in
> `apps/api/.env` (gitignored).

---

## Instagram — per-post

### Cheap fields (FREE, one paginated call, no per-post request)
```
GET /{ig-user-id}/media
    ?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count
```
**`like_count` and `comments_count` come back here** — so likes + comments for a whole
page of posts cost ONE call. This is the single most important performance fact for the
posts view: never fetch per-post insights just to get likes/comments.

### Per-post insights (one call per media, metrics BATCHABLE)
```
GET /{media-id}/insights?metric=reach,views,saved,total_interactions,shares
```
Verified working (real values returned): `reach`=335, `views`=945, `saved`=1,
`total_interactions`=1, `likes`=0, `comments`=0, `shares`=0.

### ⚠️ Metrics that DO NOT work
| Metric | Result |
|---|---|
| `impressions` | **`(#100)` — deprecated from v22.0+.** Use `views`. |
| `plays` | `(#100)` not a valid value |
| `video_views` | `(#100)` not a valid value |

### Authoritative valid-metric enum
Obtained by requesting a bogus metric — **the API enumerates its own valid values**, which
beats guessing from docs:
```
impressions, reach, replies, saved, likes, comments, shares, total_interactions,
follows, profile_visits, profile_activity, navigation, ig_reels_video_view_total_time,
ig_reels_avg_watch_time, views, reels_skip_rate, reposts, facebook_views,
crossposted_views, total_views, total_likes, total_comments, link_clicks
```
(`impressions` is listed but still errors as deprecated — presence in the enum is not
proof a metric works.)

---

## Facebook — per-post

Requires a **Page token**, minted per page: `GET /{page-id}?fields=access_token`.

### Post list
```
GET /{page-id}/published_posts?fields=id,message,permalink_url,created_time
```
`message` is simply absent on posts with no caption text — not an error.

### Per-post insights (metrics BATCHABLE — verified 4 in one call)
```
GET /{post-id}/insights?metric=post_reactions_by_type_total,post_activity_by_action_type,post_clicks,post_video_views
```
Verified working: `post_reactions_by_type_total`, `post_activity_by_action_type`,
`post_clicks`(=3), `post_video_views`, `post_video_views_organic`,
`post_reactions_like_total`, `post_clicks_by_type`(={'photo view': 3}),
`blue_reels_play_count` (valid name; empty on a non-reel), `post_video_avg_time_watched`.

⚠️ Batching works but a **documented prior gotcha still applies**: for some post types an
invalid metric 400s the WHOLE batch. Batch, then fall back to individual metrics on a 400.

### ⚠️ Metrics that DO NOT work (deprecated/removed)
| Metric | Result |
|---|---|
| `post_impressions` | `(#100)` not a valid insights metric |
| `post_impressions_unique` | `(#100)` |
| `post_views` | `(#100)` — does **not** exist; FB's view metric is `post_video_views` |
| `post_engaged_users` | `(#100)` |
| `post_negative_feedback` | `(#100)` |

### ⚠️⚠️ The `likes.summary` / `comments.summary` question — THE decisive unknown
```
GET /{post-id}?fields=likes.summary(true).limit(0),comments.summary(true).limit(0),shares
→ (#10) This endpoint requires the 'pages_read_engagement' permission
        or the 'Page Public Content Access' feature
```
This failed **with the OLD "Dashmani Insights" app**, whose `pages_read_engagement` is only
at Standard access. The **new "Post Automation 2" app HAS `pages_read_engagement` approved
at Advanced Access**, so these fields are *expected* to work with a token minted through it.

**This is UNVERIFIED and MUST be live-probed with the new app's token the moment an admin
completes OAuth.** Do not build a UI that assumes FB likes/comments are available until it
is confirmed. If it still returns `(#10)`, FB likes/comments must come from
`post_reactions_by_type_total` (summed) and `post_activity_by_action_type.comment` instead —
which is the path the existing `facebook.provider.ts` already uses.

---

## Design consequences

1. **Two-speed fetching.** IG likes/comments and FB post lists are cheap and paginated;
   per-post insights are one call each. Bound the number of posts enriched per run.
2. **Batch metrics per post** (one call, not four) — with a per-metric fallback on 400.
3. **Never claim a metric exists because the docs list it.** `impressions`/`post_impressions`
   are both dead in v21+; `views` (IG) and `post_video_views` (FB) are the live equivalents.
4. A metric that is genuinely absent must render as an em-dash, never a fabricated `0` —
   the repeatedly-relearned lesson from the Snapchat `showLikes` work.
