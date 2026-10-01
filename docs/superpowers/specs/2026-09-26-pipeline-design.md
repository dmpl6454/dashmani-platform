# Pipeline: design spec (HR portal, v1)

**Date:** 2026-09-26
**Status:** Draft for owner review. Nothing is implemented. No schema, route or UI exists yet.
**Feature:** an internal lifecycle board for campaigns and projects, with a conversation inside each project.

**How to read this document**
- **Part 1** (below, about 3 pages): the owner summary. It covers what the feature does, the decisions already made, how it avoids the failures that have hit this platform before, and what still needs your decision.
- **Part 2**: the complete technical design. Engineers implement from it: schema, every route, the sync protocol, concurrency rules, notifications, rate limits, frontend, prerequisites, tests and rollout.
- **Part 3**: the rollout milestones. Each one ships and can be verified on its own.
- **Part 4**: the decision log (alternatives that were rejected, and why) and the review log (the 64 issues the reviewers raised, all resolved).

**How it was produced**
1. Eight read-only agents mapped every subsystem the feature touches.
2. Three architects drafted the design independently: one from a performance angle, one from correctness, one from phone UX.
3. A lead architect scored the drafts and merged them.
4. Four adversarial reviewers tried to break the merged design: rate limits and database load, security and isolation, data integrity and deploys, and phone UX and failure states. They raised 64 issues, including 1 blocker. Every issue was verified and fixed.
5. The load-bearing claims were then spot-checked against the code at commit `98e60ef`.

---

## Part 1: Owner summary

### What it is

A kanban board in the HR portal at **`/pipeline`**. Each card is a project or campaign. It moves through lifecycle phases: **Brief → Planning → In Production → Review → Approved → Live → Done**. The phases are stored as data, so you can rename, reorder or add them later without a code change.

- **Board:** anyone can create, open, drag and edit any project.
- **Conversation:** each project has its own isolated thread, with messages, one level of replies, @mentions and emoji reactions.
- **Notifications:** only the people involved with a project are notified in the portal bell. That means its members, plus anyone who posts, replies or is @mentioned there. Nobody else is notified.

### Decisions you made (fixed)

| Topic | Decision |
|---|---|
| Where | **HR portal only for v1**, at `/pipeline`. The internal portal comes later: the API accepts an extra token type then, with no schema change. |
| Who creates | **Any internal user.** The creator becomes the project's **owner**. |
| Access | **Open.** Everyone can open and fully edit any project: move it, edit its fields, add members, post, reply and react. |
| Owner/admin-only actions | Only the **owner or an Admin/Super Admin** can archive, unarchive, delete, restore or transfer ownership. Admin status is checked in the database at the moment of the action, never read from the login token. |
| Membership | Decides **who is notified** and the **"My projects"** filter. It grants no extra powers. |
| Followers | Posting, replying or being @mentioned makes you a follower, who is notified like a member. Anyone can unfollow. |
| Clients | Standalone. No link to clients or to the existing client-portal "Projects". |
| Conversation | One thread per project, one level of replies, @mentions, a fixed set of 8 reactions, and author-only edit and delete. **No attachments in v1.** |
| Freshness | About **10 seconds** while a project is open and the tab is visible. Polling only. The design allows a live connection to be added later without changing the data model. |
| Notifications | New messages are **grouped per project** into one bell entry ("Diwali campaign: 4 new messages"), updated in place until read. @mentions and replies to you get their **own** entry. Also notified: being **added to a project**; **phase moves**, with rapid moves by one person merged within 2 minutes; **due tomorrow** and **overdue**, by IST date, skipping Sundays. No emails. |
| Card fields | Title, description, owner, members, phase, **start date and due date** (IST). |
| Other bells | Pipeline notifications also appear in the **internal portal's bell**, which opens the HR portal project in a new tab. They appear in the **mobile app** as text only, because installed apps cannot be force-updated, so the row format stays backward compatible. |

### How it avoids the failures you listed

| Failure | What prevents it |
|---|---|
| **"Too many requests"** | Pipeline routes get their **own per-user rate limits** with 1-minute windows, and the site-wide limiter skips them. So pipeline polling can never use up the allowance that HR report submit, Link History, accounts and login depend on. If the pipeline itself is throttled, only the pipeline pauses, silently, and it recovers within 60 seconds. The HR bell change (P3) also *halves* the bell's use of the site-wide allowance. |
| **"An unexpected error occurred" / database pool exhaustion (P2024)** | The pipeline gets its **own 3-connection database pool**, separate from the 10 connections login and report submit share. Every statement has a short timeout (2.5 s) and every lock wait has a 1 s limit. When the pipeline is overloaded it answers "busy" and the page retries quietly; login and submit are never affected. Every expected database error is mapped to a clear response, so none becomes a generic 500. |
| **"Something went wrong" / blank lists / "links or accounts missing"** | Every screen separates *loading*, *failed (with Retry)* and *genuinely empty*. A failed load never shows "No projects" or "No messages", and a failed poll never clears data already on screen. Unsent messages are kept and retried. |
| **Slowness as data grows** | No request ever counts or scans message history. Unread counts, member counts and reply counts are stored on the rows, so the board shows them without counting anything. The thread loads 30 messages at a time. The board shows up to 100 cards per phase and says so when more exist. |
| **Server freezes (the 2026-09-08 class)** | Every text field is length-capped *before* any processing. User text never goes through the slow `safeString` regex. There are no link previews and no regex that can take quadratic time. |
| **Deploy restarts (up to 15 a day)** | Every write carries an idempotency key, so a message retried after a restart never posts twice. Polling resumes exactly where it stopped. Messages are numbered in commit order within each project, so a message can never be skipped. |
| **The feature misbehaving in production** | A **kill switch** (`pipeline.mode = off`) takes effect within 15 seconds with no deploy. A **pilot allowlist** of named users comes first. The nav item stays hidden until general release. |

**Request cost per user:** a user with one project open makes about 7 reads a minute, against a pipeline allowance of 120 a minute. Those requests add **nothing** to the site-wide allowance.

**Database cost:** each poll is **one indexed statement**, held for about 3 ms. The board is rebuilt **once per change company-wide**, not once per viewer.

### ⚠️ Found during research: HR self-registration (decided 2026-09-26)

`POST /v1/hr/auth/register` is public. Two problems came up:
- It creates **ACTIVE** accounts that can log in immediately (`apps/api/src/services/hr-auth.service.ts:99-108`). That contradicts both the login page ("An admin will approve it shortly") and CLAUDE.md.
- It **promotes any existing ONBOARDING row**, meaning an admin-created pending hire, to ACTIVE with the registrant's new password (`:47-66`). That is an account-takeover path: anyone who knows a pending hire's email can claim the account.

**Your decision:** keep instant self-registration and close the takeover. **P0** now means registration never touches an existing account:
- An email or phone that already exists, in any status including ONBOARDING, gets the same 409 "An account with this email or phone already exists" that active accounts get today.
- Pending hires are activated by an admin through the existing flow.
- New sign-ups stay ACTIVE.

**Accepted consequence:** with open access, anyone who self-registers can read and post in every pipeline project. General availability waits only for P0.

*Recommended in the same PR:* correct the login-page copy that promises approval, so the UI tells the truth.

### What must happen first

These are small, independent PRs, each deployed on a working day between 11:00 and 16:00 IST, outside the login and evening report-submit rushes:

| # | Fix | Why |
|---|---|---|
| **P0** | Registration can never take over an existing account (above) | Required before general availability |
| **P1** | HR `apiFetch`: cap the 401 retry at one; carry the HTTP status; stop logging people out when a token refresh fails only transiently | The poller has to tell 429, 403 and 5xx apart. Today a network blip during refresh signs the user out. |
| **P3 / P4** | HR and internal bells: fetch the list only while the panel is open; honest loading and error states; deep links for pipeline rows | Rows become actionable. HR bell traffic halves. |
| **P5** | Login returns to the page you came from (`?next=`) | A bell link opened while signed out must not lose the project |
| **P9** | Read-only server checks: nginx rate limits, the fail2ban jail, database connection headroom, an evening baseline | `scripts/security-setup.sh` enables a fail2ban jail that could ban a **Cloudflare edge IP for an hour**. That would hit many users at once and must be ruled out before the pilot. |
| **P12** | CORS preflight caching (`maxAge: 600`) | Halves request counts through nginx for every portal |
| P7, P8, P11, P13, P14 | Test helpers and CI guards; a linear `safeString` (platform-wide freeze fix, recommended); quieter logs; a notifications index | Details in Part 2, §10 |

### Rollout (Part 3 has the details)

| Milestone | What ships | Risk to production |
|---|---|---|
| M0a–M0e | The prerequisites above, plus server and sandbox checks | Small, independent fixes |
| M1 | Schema only: new `pipeline_*` tables and one new notification type, **created on prod by hand before the merge** | New tables only; no existing table changes |
| M2 | API, **switched off** | The feature is off; own pool and own rate limits |
| M3 | Notifications and background jobs, **switched off** | Nothing is written while off |
| M4 | HR pages, nav hidden | Other HR pages unchanged |
| M5 | Load and concurrency proof on a 1-CPU replica: 120 users, evening submit rush, a mid-run restart | Nothing deploys |
| M6 | Pilot: 5–10 named people for at least 5 working days | Flag flip; off within 15 s |
| M7 | General availability, after P0 | Flag flip |
| M8 | Optional: mobile app opens pipeline links (over-the-air update) | Your call |

**Pass bar for M5 (and watched through the pilot):**
- **zero** 429s or 5xx responses on any non-pipeline route;
- **zero** P2024 errors;
- login and HR-submit speed within 10% of a baseline run with the pipeline off;
- a poll answers in under 30 ms (p95).

### Proposed defaults awaiting your confirmation

The design adopts a default for each item. Say if any is wrong.
1. **Phases:** Brief → Planning → In Production → Review → Approved → Live → Done. Only Done counts as finished, so it gets no due or overdue alerts.
2. **Finished projects** stay on the board until someone archives them; there is no auto-archive.
3. **Due and overdue alerts:** sent once per due date, only between 09:30 and 20:00 IST, skipping Sundays. They do **not** skip company holidays yet.
4. **Removing someone:** a person who never took part is removed completely. A person who has posted is demoted to follower, who can then unfollow. An @mention still notifies someone who unfollowed.
5. **Moderation:** in v1 only authors can edit or delete their own messages. Owners and admins cannot delete other people's messages.
6. **Delete:** a soft delete with a **30-day restore window**, then a permanent purge. If an admin removed a project, only an admin can undo it.
7. **Phase moves** show in the project header, not as lines in the conversation.
8. **Reactions:** 👍 ❤️ 😂 🎉 👀 ✅ 🙏 🔥.
9. **Retention:** pipeline notifications are deleted 30 days after being read, and after 90 days at most. Messages are kept for the project's lifetime.
10. **Pilot group and switch:** you choose the 5–10 people. The flag is flipped with a dry-run-by-default script; an admin toggle can come later.

---

## Part 2: Technical design

**Inputs.**
- Owner decisions 1–12 are fixed. Performance and platform safety outrank every feature detail.
- Every code fact below was re-checked at `98e60ef`.
- Where the design depends on box state the repo cannot show, it names a read-only check (P9) that must pass before the pilot.

---

### 0. Facts this design depends on (verified at `98e60ef`)

**Request path** (`apps/api/src/app.ts`)
- **Order:**
  1. helmet
  2. cors (`allowedHeaders` = Content-Type, Authorization, X-Requested-With; **no `maxAge`**)
  3. global limiter: 1000 per 15 min. Key is `u:<type>:<userId>` for a verified *unexpired* token, else `ip:<req.ip>`, which is the Cloudflare edge. In-memory store.
  4. job-apply limiters
  5. `express.json({limit:"10mb"})`, then urlencoded
  6. login limiters
  7. morgan `combined`
  8. unauthenticated `/uploads`
  9. `/v1` routes
  10. `errorHandler`
- **express-rate-limit 7.5.1** evaluates `skip` before `keyGenerator`. body-parser skips any request whose `req._body` is already set.
- **Routing:** `routes/index.ts` mounts prefixless routers in order. No route file uses router-level `router.use()`. Nothing owns `/pipeline`.
- **Expired tokens:** an expired token fails `verifyAccessToken`, so today it is keyed on the edge IP.

**Errors**
- **`errorHandler`** maps only `AppError`. Everything else becomes 500 "An unexpected error occurred". That includes P2024, P2002, P2025, P2028, body-parser errors and raw-query errors.
- **Prisma 5.22.0:**
  - A database error from `$queryRaw` or `$executeRaw` arrives as `P2010` with the SQLSTATE in `err.meta.code`.
  - Some errors arrive as `PrismaClientUnknownRequestError` with the SQLSTATE only in the message.
  - `tests/setup.ts:80-85` already handles all three shapes.

**Database and runtime**
- **Pool:** one `PrismaClient` (`packages/db/src/index.ts`) with `connection_limit=10` and `pool_timeout=20`. `statement_timeout` is set only via `DB_STATEMENT_TIMEOUT_MS`; prod uses 60 s.
- **Analytics cap:** `utils/heavy-query.ts` caps analytics at 2 slots "so at least 8 pool connections always remain" for login, HR submit, bells and crons.
- **Crons** are boot-relative (`setTimeout(offset)` then `setInterval`). Follower sync and entity extraction run immediately at boot.
- **Deploys:** every non-docs deploy restarts the API, up to about 15 times a day.
- **Process:** one pm2 fork process with an 800M memory cap. RSS is about 390 MB.

**Notifications**
- **`notifications` table:**
  - Columns: `id text` (default uuid on the Prisma side only), `type NotificationType`, `title`, `message`, `read`, `metadata Json?`, `created_at timestamp(3)`.
  - Indexes: `(user_id, read)` and `(created_at)`.
  - `markAsRead` is `updateMany({id, userId})`.
- **Routing:** `NOTIFICATION_AUDIENCE` is an exhaustive `Record`. `dispatchNotification` falls back to ADMINS for an unmapped type.
- **HR bell:** mounted only inside `Topstrip`. It polls the 50-row list and the count every 30 s even while closed. It shows "No notifications yet" for any empty *or failed* list.
- **Internal bell:**
  - Polls the count every 15 s and fetches the list only while open.
  - Shows the same false empty state.
  - Guesses a `/employees/pending` link from the words "registration" and "approval".
- **Mobile** (`mobile/src/app/notifications.tsx`):
  - Reads `/hr/notifications` and uses only `id`, `title`, `message`, `read` and `createdAt`. Tapping a row marks it read.
  - Ships `expo-updates` (runtimeVersion policy `appVersion`) and `expo-web-browser`, so a JS-only OTA update is possible.
  - Installed binaries cannot be force-updated.

**Auth and users**
- **One `JWT_SECRET`:** every portal signs access tokens with it. `authenticate` checks the signature only.
- **Client-portal refresh tokens** are `{userId}` signed with the same secret and carry **no `type`**, so they verify as access tokens.
- **⚠️ Self-registration grants access:**
  - `registerEmployee` (`hr-auth.service.ts:99-108`) creates self-registered users as **ACTIVE** with the Employee role.
  - At `:47-66` it promotes any existing ONBOARDING row, including admin-created pending hires, to ACTIVE with a new password.
  - The public `POST /hr/auth/register` has no approval step. The UI still promises one: "An admin will approve it shortly" (`login/page.tsx:847, 955, 1096`).
  - HR login refuses only ONBOARDING and INACTIVE users.
- **Deletion:** users are soft-deleted (`deletedAt` plus status INACTIVE).

**HR frontend**
- **`apiFetch`** (`apps/hr/src/lib/api.ts`):
  - Retries a 401 after refresh with no cap.
  - `ApiError` has `code` and `details` but no status.
  - `doRefresh` returns false on a network error, a non-JSON body, or a 429. The caller then wipes the tokens and hard-redirects to `/login` with no return path.
- **Login and logout:**
  - Login always calls `router.push("/dashboard")`.
  - `HrAuthProvider` pushes `/login` with no return path.
  - Logout clears only the three auth keys and does not reload.
- **Layout:**
  - `PortalShell`'s `main` is `min-h-screen overflow-hidden pt-14 lg:pt-0`.
  - The mobile bar is `h-14 z-40`.
  - `Topstrip` is `sticky backdrop-blur-sm h-16` plus a 2 px border, 66 px in total.
- **Globals:**
  - The 16 px input floor is unconditional.
  - `html, body` clip x-overflow.
  - There is no `error.tsx` or `global-error.tsx`.
- **Dependencies and code shape:** no drag-and-drop, websocket or virtualisation library is installed. No regex lookbehind exists in `apps/hr/src`, `packages/shared/src` or `mobile/src`.
- **Deploy script:** `deploy.sh` rewrites each `apps/*/.env.local` with only `NEXT_PUBLIC_API_URL`, and runs `rm -rf` on every `.next` before building.

**Shared package**
- `packages/shared` is TypeScript source consumed by tsx and Next.
- `date.ts` has `todayIST`, `dateToIST`, `istMidnight` and `istTimeOfDay`. It has no minutes-of-day or working-day helpers.
- `safeString` is quadratic on unmatched `<` and deletes `<…>` spans.

**Box** (from `scripts/security-setup.sh`; not verified on the box)
- **fail2ban:** `[nginx-limit-req] enabled = true`, `bantime 3600`, `maxretry 5`, `backend=systemd`.
- **nginx:** `limit_req_zone zone=api rate=30r/s`, keyed on `$binary_remote_addr`. Because `real_ip` is not configured, that key is the edge IP. Whether the API block applies this zone is unknown.

**Tests**
- `tests/setup.ts` truncates an explicit table list.
- CI uses `connection_limit=1` with `pool: forks, singleFork`.
- `createTestUser`'s default email is unique only to the millisecond.
- `system_settings` is not truncated.

---

### 1. Scope & non-goals

**In scope (v1)**
- **HR portal pages:**
  - `/pipeline`: the board, plus `?view=archived|deleted`.
  - `/pipeline/[id]`: the project page, deep-linkable with `?m=<messageId>&t=<rootId>`.
- **API:** `/v1/pipeline/*`, gated by a token-type **allowlist** (`["hr"]` in v1). Phase 2 adds `"employee"` without changing the schema or routes.
- **Projects (cards):**
  - Fields: title, description, owner, members, phase, start date, due date. Dates are IST calendar days.
  - Phases are **data** (`pipeline_phases`).
- **Open access:**
  - Any ACTIVE, HR-token, feature-enabled user can view, move, edit, add members, post, reply and react on any live project.
  - Only the owner or an Admin/Super Admin, checked against the DB, can archive, unarchive, delete, restore or transfer ownership.
- **Participation:**
  - Members, plus followers created by posting, replying or being @mentioned.
  - Anyone can unfollow themselves.
  - Ownership lives only in `owner_id`.
- **Conversation:**
  - One thread per project, with one level of replies.
  - `@{uuid}` mentions and a fixed 8-emoji reaction palette.
  - Author-only edit and delete; a delete leaves a tombstone.
- **Freshness:**
  - One consolidated, visibility-gated poll (`POST /v1/pipeline/sync`): 10 s while a project is open and focused, slower otherwise, paused while hidden.
  - Commit-ordered cursors, so SSE can be added later.
- **Notifications:**
  - In-portal only, through the existing `notifications` table, with **one** new enum value, `PIPELINE`.
  - New messages are grouped per (user, project) and updated in place. Mentions and replies to you get individual rows.
  - Also sent: added to a project; phase moves, merged over 2 minutes; due tomorrow, which is working-day aware; overdue.
  - Delivered to the HR bell, the internal bell (as a new-tab deep link) and mobile (as text).
- **Operations:**
  - A `system_settings` kill switch and a pilot allowlist.
  - The nav item is hidden until GA.
  - A dedicated DB client and pool, and separate rate-limit buckets.

**Non-goals (v1)**
- **Delivery and platforms:** attachments or uploads; email or push; SSE or websockets; mobile screens; internal-portal pages (phase 2).
- **Card and thread features:** priority, labels, checklists; per-project phases; a phase-editor UI (phases change through a script); search across messages or projects; typing, presence or read receipts.
- **Links:** link previews. Never reuse `/admin/link-preview`, which is an SSRF and main-thread-hang vector. No link to `Client` or the client-portal `Project`.
- **History:** an activity or event-log table.
- **Shared payloads:** no pipeline content in the Overview activity feed or any cross-viewer cached payload.

**Gates**
- **Before the pilot:** P1, P3, P4, P5, P9 (with remediation) and P12 must be live. The load harness and the concurrency suite must pass.
- **Before GA:** **P0** (registration can no longer take over an existing account) must be live. Until then `pipeline.mode` may only be `off` or `pilot`.
- **Owner decision (2026-09-26):** self-registration stays instant, so under open access anyone who self-registers can use the pipeline. This is accepted.

---

### 2. Data model

**Rules for this schema change:**
- New tables only, prefixed `pipeline_*`.
- The only change to an existing object is `ALTER TYPE "NotificationType" ADD VALUE 'PIPELINE'`.
- Back-relations on `User` are Prisma-virtual. The DDL review must show no `ALTER TABLE "users"` and no DDL on `notifications`.
- Counters are `Int`.
- No new Postgres enums. Roles and emoji keys are text, validated in code.

```prisma
// ============ PIPELINE (HR portal v1) ============

/// Phases are DATA (owner will rename/reorder/add). Never hard-code phase ids.
model PipelinePhase {
  id         String    @id @default(uuid())
  key        String    @unique @db.VarChar(40)       // stable slug for scripts/tests
  name       String    @db.VarChar(40)
  position   Int
  color      String    @default("indigo") @db.VarChar(16) // design-token allowlist
  isTerminal Boolean   @default(false) @map("is_terminal") // no due/overdue alerts
  archivedAt DateTime? @map("archived_at")  // allowed only when NO project row (any state) references it
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")
  projects   PipelineProject[]
  @@index([position, id])
  @@map("pipeline_phases")
}

/// Single row (id = 1). Version of everything the BOARD shows. Bumped AFTER commit (§5.1).
model PipelineBoardState {
  id        Int      @id
  seq       Int      @default(0)
  updatedAt DateTime @updatedAt @map("updated_at")
  @@map("pipeline_board_state")
}

model PipelineProject {
  id                 String    @id @default(uuid())
  clientId           String    @map("client_id") @db.VarChar(64)   // create idempotency key (body field)
  title              String    @db.VarChar(120)
  description        String    @default("") @db.Text               // ≤ 5,000 chars (validator)
  ownerId            String    @map("owner_id")                    // the ONLY source of ownership
  createdById        String    @map("created_by_id")
  phaseId            String    @map("phase_id")
  rank               String    @db.VarChar(64)                     // fractional index; compare COLLATE "C"
  startDate          DateTime? @map("start_date") @db.Date
  dueDate            DateTime? @map("due_date") @db.Date
  headerRev          Int       @default(1) @map("header_rev")       // header/participant change
  threadRev          Int       @default(0) @map("thread_rev")       // thread change (delta cursor)
  lastMessageSeq     Int       @default(0) @map("last_message_seq")
  lastMessageAt      DateTime? @map("last_message_at")
  memberCount        Int       @default(1) @map("member_count")     // MEMBER rows (owner always has one)
  phaseChangedAt     DateTime? @map("phase_changed_at")
  phaseChangedById   String?   @map("phase_changed_by_id")          // informational, no FK
  moveGen            Int       @default(0) @map("move_gen")
  moveActorId        String?   @map("move_actor_id")
  moveStartedAt      DateTime? @map("move_started_at")
  moveLastAt         DateTime? @map("move_last_at")
  moveFromPhaseId    String?   @map("move_from_phase_id")
  dueSoonNotifiedFor DateTime? @map("due_soon_notified_for") @db.Date
  overdueNotifiedFor DateTime? @map("overdue_notified_for") @db.Date
  archivedAt         DateTime? @map("archived_at")
  archivedById       String?   @map("archived_by_id")
  archivedByAdmin    Boolean   @default(false) @map("archived_by_admin") // non-owner admin acted
  deletedAt          DateTime? @map("deleted_at")                   // soft delete; purged after 30 days
  deletedById        String?   @map("deleted_by_id")
  deletedByAdmin     Boolean   @default(false) @map("deleted_by_admin")
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  owner        User                  @relation("PipelineOwner",   fields: [ownerId],     references: [id], onDelete: Restrict)
  createdBy    User                  @relation("PipelineCreator", fields: [createdById], references: [id], onDelete: Restrict)
  phase        PipelinePhase         @relation(fields: [phaseId], references: [id], onDelete: Restrict)
  participants PipelineParticipant[]
  messages     PipelineMessage[]

  @@unique([createdById, clientId])
  @@index([phaseId])
  @@index([ownerId])
  @@index([dueDate])
  @@index([archivedAt, id])
  @@index([deletedAt])
  @@map("pipeline_projects")
}

/// One row per (project, user) for members and followers. Also holds read state.
model PipelineParticipant {
  projectId       String    @map("project_id")
  userId          String    @map("user_id")
  role            String    @db.VarChar(12)                  // "MEMBER" | "FOLLOWER" — never "OWNER"
  notify          Boolean   @default(true)                   // false after unfollow; only the user changes it
  lastReadSeq     Int       @default(0) @map("last_read_seq")
  seenAt          DateTime? @map("seen_at")                  // active-reader suppression; NULL on leave
  engagedAt       DateTime? @map("engaged_at")               // first post/reply/mention/explicit follow
  memberAddedById String?   @map("member_added_by_id")       // set ONLY by create / add-members
  memberAddedAt   DateTime? @map("member_added_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  project PipelineProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User            @relation("PipelineParticipation", fields: [userId], references: [id], onDelete: Cascade)

  @@id([projectId, userId])
  @@index([userId])
  @@map("pipeline_participants")
}

model PipelineMessage {
  id          String    @id @default(uuid())
  clientId    String    @map("client_id") @db.VarChar(64)    // send idempotency key (body field)
  projectId   String    @map("project_id")
  seq         Int                                             // creation order in project, immutable
  rev         Int                                             // last-change stamp = delta cursor
  parentId    String?   @map("parent_id")                     // null = top-level; replies point at the ROOT
  authorId    String    @map("author_id")
  body        String    @db.Text                              // ≤ 4,000; "" when deleted
  mentionIds  String[]  @default([]) @map("mention_ids")      // delivered (valid) mentions only, ≤ 20
  reactions   Json      @default("{}")                       // {"thumbs_up":["<userId>",…]}
  replyCount  Int       @default(0) @map("reply_count")
  lastReplyAt DateTime? @map("last_reply_at")
  editedAt    DateTime? @map("edited_at")
  deletedAt   DateTime? @map("deleted_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  project PipelineProject   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  parent  PipelineMessage?  @relation("PipelineReplies", fields: [parentId], references: [id], onDelete: Cascade)
  replies PipelineMessage[] @relation("PipelineReplies")
  author  User              @relation("PipelineMessageAuthor", fields: [authorId], references: [id], onDelete: Restrict)

  @@unique([authorId, clientId])
  @@unique([projectId, seq])
  @@unique([projectId, rev])            // total order → unambiguous delta cursor
  @@index([projectId, parentId, seq])   // top-level pages and reply lists
  @@index([parentId])                   // FK cascade on purge must not full-scan
  @@map("pipeline_messages")
}

// model User — virtual back-relations only (no DDL on users):
//   pipelineOwned PipelineProject[] @relation("PipelineOwner")
//   pipelineCreated PipelineProject[] @relation("PipelineCreator")
//   pipelineParticipations PipelineParticipant[] @relation("PipelineParticipation")
//   pipelineMessages PipelineMessage[] @relation("PipelineMessageAuthor")

enum NotificationType {
  // … existing 18 values unchanged …
  PIPELINE   // ONE value for every pipeline kind (metadata.kind). Permanent — never remove.
}
```

#### Why each denormalised column exists

The rule is that no read path aggregates an append-only table.

| Column | Replaces | Keeps this read O(1) or bounded |
|---|---|---|
| `last_message_seq` and `last_read_seq` | COUNT of unread messages per project per poll | unread = subtraction |
| `thread_rev` and `messages.rev` | timestamp scans with overlap windows | exact delta via a unique-index range |
| `header_rev` | resending the header and participants every poll | sent only when changed |
| `member_count` | COUNT of participants per card | board snapshot |
| `reply_count`, `last_reply_at` | COUNT of replies per message | thread page |
| `reactions` (jsonb) | a reactions table plus GROUP BY | one row read |
| `mention_ids` | re-parsing and joins | edit diff and redaction |
| `move_*` | an event log | race-safe 2-minute merge |
| `due_soon_notified_for`, `overdue_notified_for` | scanning notification JSON | idempotent due cron |
| `seen_at` | nothing (new behaviour) | active-reader suppression |
| `engaged_at`, `member_added_by_id`, `member_added_at` | nothing (new behaviour) | the removal and undo rules (§4) |
| `archived_by_admin`, `deleted_by_admin` | nothing (new behaviour) | a moderation action the owner cannot undo |
| `pipeline_board_state.seq` | per-user board diffing | a one-row version check |

#### onDelete rules and why

| Relation | Rule | Why |
|---|---|---|
| owner, creator, author → users | Restrict | Users are only soft-deleted; a future hard delete must not wipe shared threads. |
| participant → users | Cascade | The row belongs to that user. |
| participants, messages → project | Cascade | Used only by the purge job. |
| message → parent | Cascade | Indexed on `parent_id`; the purge deletes replies before roots anyway. |
| project → phase | Restrict | Plus a rule that a phase is archivable only with zero referencing rows. |
| informational actor ids | no FK | Fewer FK locks on `users` during DDL. |

#### DB access rules

Tests or CI enforce each of these.
1. **Client:** pipeline code imports **only** `pipelineDb` from `services/pipeline/db.ts`. A CI grep fails on the `@dashmani/db` `prisma` import anywhere in `services/pipeline/**` except `db.ts`. Transaction callbacks receive only `tx`. Memos resolve **before** a bulkhead slot is taken.
2. **Timestamps:** every raw INSERT or UPDATE sets `updated_at`, because `@updatedAt` has no DB default. Timestamps are `timezone('utc', now())`, never a bare `now()`.
3. **Rank ordering:** rank is ordered only with `COLLATE "C"`. The client uses the shared `compareRank` (plain `<` and `>`), and a CI grep bans `localeCompare` on ranks.
4. **Counts:** cast `count(*)` to `::int`.
5. **No parallel queries:** never run `Promise.all` over queries inside one pipeline operation.
6. **Lock first:** lock in statement 1, and read or modify in later statements. Under READ COMMITTED each later statement takes a snapshot *after* the lock, so a single statement that waits on `FOR UPDATE` may still read stale joined rows.
7. **Errors:** every DB error goes through `classifyDbError` (§3.3).
8. **Notification ids:** built only through `plnId()` (TypeScript) or `plnIdSql()` (the SQL fragment builder). A parity test asserts both produce the same text.
9. **Wire dates:** `YYYY-MM-DD` via `d.toISOString().slice(0,10)`. This is correct **only** for `@db.Date` values and is commented as such.

#### Seeds

The DDL script seeds these, not `seed.ts`:
- `pipeline_board_state (1, 0, timezone('utc', now()))`;
- phases Brief → Planning → In Production → Review → Approved → Live → Done, with Done `is_terminal`;
- all `ON CONFLICT DO NOTHING`.

#### Bounded growth and retention

| Table | Growth | Bound |
|---|---|---|
| `pipeline_messages` | people typing, pessimistically ~180 MB/year | Keyset reads only (LIMIT ≤ 51). Tombstones carry no body. Purged with the project. |
| `pipeline_participants` | upserted | ≤ 200 per project |
| `pipeline_projects` | people creating | Snapshot capped at 100 cards per phase, with disclosure. Soft-deleted rows purged 30 days after deletion. |
| `notifications` (type `PIPELINE`) | grouped rows are re-armed in place; direct rows append | Daily trim: read and older than 30 days, or anything older than 90 days, `PIPELINE` rows only |

There is no reactions, mentions, events, outbox or due-alert table.

**Per-user growth that the sync overlay pays for (an accepted bound, measured 2026-09-28).**
- Archiving a project keeps its participant rows. Only the purge of a *deleted* project removes them. So each user's rows in `pipeline_participants` grow with that user's **lifetime** participations, not their live ones.
- The §5.2 R1 overlay reads all of `$me`'s rows through `pipeline_participants_user_id_idx`. The live filter sits on `pipeline_projects`, served by `pipeline_projects_archived_at_id_idx` (a hash join), so `LIMIT 500` cannot stop the participant scan early.
- Its cost is therefore O(my lifetime participations + live projects company-wide). This is the one R1 read that grows with history.
- **Measured** on real, analysed tables with exactly the PR 5 indexes. Setup: local PG 16, warm cache, 12,000 projects of which 1,500 are live, and one user with 267 live participations. Median times (the last point also gives p95):

  | Lifetime participations | 267 | 1,267 | 2,267 | 4,267 | 8,267 | 10,767 |
  |---|---|---|---|---|---|---|
  | Median | 0.87 ms | 1.05 ms | 1.20 ms | 1.54 ms | 2.17 ms | 2.52 ms (p95 3.19 ms) |

- **Accepted bound:** up to about **2,000 lifetime participations per user**. The load harness seeds 300 projects in total, so reaching the bound means taking part in about 2,000 projects.
  - These local numbers are a floor, not the 1-vCPU box. The load harness (§11) runs this heavy-user case in the 1-CPU cgroup, and that run is the gate.
  - Before GA, and yearly after it, check the real maximum with one read-only query: `SELECT max(n) FROM (SELECT count(*) AS n FROM pipeline_participants GROUP BY user_id) s`.
- **Not taken now, and why.** A denormalised `project_live` flag on participants, with a `(user_id, project_live, project_id)` index, was measured on the same data and was *slower*: 4.16 ms against 2.48 ms at 10,767 participations. With `ORDER BY project_id LIMIT 500`, the planner merge-joins it against the whole `pipeline_projects` primary key.
  - If the bound is ever approached, choose the fix together with the R1 SQL in PR 8, for example a plan with one primary-key lookup per participant row. Verify it with EXPLAIN. If it needs a column or an index, ship it through the §12 DDL cycle.

---

### 3. API surface

#### 3.1 Mounting (`apps/api/src/app.ts`, in this order)

```ts
const isPipelinePath = (req: Request) => {
  const p = req.path.toLowerCase();            // app-level mount → full path
  return p === "/v1/pipeline" || p.startsWith("/v1/pipeline/");
};
// 1. global limiter: skip: (req) => isHealthProbe(req) || isPipelinePath(req)
// 2. right after it (after cors, so preflights never count):
app.use("/v1/pipeline", pipelineRateLimiter);   // buckets §8.1; key = pipelineRateLimitKey
// 3. BEFORE the global express.json (sets req._body → the 10mb parser skips):
app.use("/v1/pipeline", pipelineJson);          // express.json({limit:"64kb"}); entity.too.large → 413, parse → 400 JSON
// 4. morgan: skip = POST /v1/pipeline/sync with status < 400
```

**`pipelineRateLimitKey(req)`** (pure, in `rate-limit-key.ts`):
- It verifies the bearer token's **signature with `ignoreExpiration: true`**.
- A signature-valid token is keyed `p:<bucket>:<type>:<userId>`, even when expired. The request then reaches `authenticate`, gets its 401, and the client refreshes.
- Unsigned or garbage tokens fall back to `p:<bucket>:ip:<req.ip>`.
- This is only rate-limit keying; `authenticate` still rejects expired tokens.

**Routing:**
- In `routes/index.ts`, `router.use(pipelineRoutes)` goes directly after `hrRoutes`.
- Inside the router, the literal paths (`/pipeline/bootstrap`, `/directory`, `/sync`, the `/projects` list) are declared before `/pipeline/projects/:id…`.
- The router ends with the pipeline error middleware (§3.3), so nothing reaches the global 500.

#### 3.2 Dedicated DB client, bulkhead, gates

**`pipelineDb`** (`services/pipeline/db.ts`)
- It is a second `PrismaClient` whose URL is built from `DATABASE_URL`: the query string is stripped, then:
  - `connection_limit=${PIPELINE_DB_CONNECTIONS||3}`, `pool_timeout=2`, `connect_timeout=5`;
  - `options=-c%20statement_timeout%3D2500%20-c%20lock_timeout%3D1000`, hand-encoded as in `withConnectionPool`.
- These connections are **in addition to** the main 10. The main pool's ≥8-free rule, login, HR submit, bells and crons are untouched.
- Pipeline pool exhaustion is a fast (≤2 s), pipeline-only P2024, which maps to 503.
- The harness measures the process RSS delta. If it exceeds 100 MB, the fallback is to run on the main client with the bulkhead capped at 2.
- Tests set `PIPELINE_DB_CONNECTIONS=1` in the main suite and 3 in the concurrency suite.

**Bulkhead** (`utils/bulkhead.ts`, a new factory; `heavy-query.ts` is untouched and never used here)
- `pipelineGate`: max 3 in flight, queue ≤ 100, max wait 2,000 ms, then 503 `PIPELINE_BUSY`.
- Writes are granted ahead of reads. Background jobs acquire one slot and run sequentially.

**Wrappers**
- `pipelineRead(fn)` / `pipelineWrite(fn)`: acquire a slot, run either one autocommit statement or `pipelineDb.$transaction(fn, {maxWait:1500, timeout:4000})`, classify errors, release the slot in `finally`.
- Background jobs raise their ceiling inside their own transaction with `SET LOCAL statement_timeout = '5s'`.

**Gates**
- **G0** = `authenticate` → `requirePipelineToken`. This is synchronous: `PIPELINE_TOKEN_TYPES.includes(req.user.type)`, else **403 `FORBIDDEN`**, never 401. It carries a comment: *this must remain an allowlist; `type` is undefined on client-portal refresh tokens*.
- **G** = G0 → `asyncHandler(requirePipelineAccess)`, which reads memos only:
  - **Settings memo** (15 s): `pipeline.mode`, `pipeline.pilotUserIds`, `pipeline.pollMs`, `pipeline.minClientBuild`.
    - If a read fails and a last-known value is < 5 min old, it is used.
    - Otherwise the gate returns **503 `PIPELINE_BUSY`** with `retryAfterSec`.
    - **403 `PIPELINE_DISABLED` only after a successful read** shows `off` or no row.
  - **Access memo** (60 s, single-flight, ≤ 500 entries): `{active, isAdmin}` from one query on `pipelineDb` over `users ⋈ user_roles ⋈ roles`.
  - Other outcomes: 403 `PIPELINE_NOT_IN_PILOT` or `ACCOUNT_INACTIVE`.
- **+O** = owner or admin, checked fresh in the DB at action time (§4). **+Au** = the message's author.
- Handlers use `asyncHandler`, validators `validate(schema, source)` from `packages/shared/src/validators/pipeline.ts`, responses `success()` plus `Cache-Control: no-store`.

**Boot self-check** (after `listen`, on `pipelineDb`)
- Runs `SELECT <every pipeline column> FROM <each pipeline table> LIMIT 0` and `SELECT 'PIPELINE'::"NotificationType"`.
- On failure: log loudly, set `pipelineSchemaOk=false` (every route answers 403 `PIPELINE_DISABLED`, no job runs), and re-check every 10 minutes. A missed DDL therefore shows as "paused", never as 500s.
- On success: run one post-commit board bump (§5.1).

#### 3.3 Error mapping (router-local)

`classifyDbError(err)` returns `{sqlstate, constraint}`. It derives the SQLSTATE from:
1. `err.meta?.code` when `err.code === "P2010"`;
2. the ORM code map: P2002 → 23505, P2034 → 40001, P2025/P2003/P2024/P2028 kept as is;
3. a scan of `err.message` for `SQLSTATE (\w{5})`, `code: "(\w{5})"`, "canceling statement due to (statement|lock) timeout" or "deadlock detected".

For 23505 the constraint name is read from `meta.target` / `meta.message`.

| Source | Response |
|---|---|
| ZodError via `validate()` | 400 `VALIDATION_ERROR` + details |
| body-parser | 413 `PAYLOAD_TOO_LARGE`, 400 `INVALID_JSON` |
| 23505 on `(author_id, client_id)` or `(created_by_id, client_id)` | re-read by key; same project → 200 `replayed:true`; other project → 409 `IDEMPOTENCY_KEY_REUSED` |
| 23505 on any other constraint | 409 `CONFLICT` |
| P2025 | 404 `*_NOT_FOUND` |
| P2003 / 23503 | 404 `USER_NOT_FOUND` or `PHASE_NOT_FOUND` |
| 40P01, 40001 | one retry after 50–150 ms (idempotent ops only), then 503 |
| P2024, P2028, 57014, 55P03, bulkhead wait > 2 s, settings unreadable | **503 `PIPELINE_BUSY`** + `retryAfterSec`, never 500 |
| anything else | 500 `PIPELINE_INTERNAL`, logged with route and error; the UI never shows the server string |

#### 3.4 Routes

Buckets: **R** = read, **W** = write, **M** = the message sub-bucket, which is counted in both W and M (§8.1).

| # | Method & path | Gate | Input | 2xx `data` | Errors |
|---|---|---|---|---|---|
| 1 | GET `/pipeline/bootstrap` | G0 (feature check inside) · R | — | `{enabled:false, reason}`, or `{enabled:true, mode, navVisible, me:{id,name,isAdmin}, phases[], pollMs:{project,projectBg,board,boardBg,idle}, reactions[8], limits, minClientBuild}` | 403 FORBIDDEN; 503 PIPELINE_BUSY |
| 2 | GET `/pipeline/directory` | G · R | — | `[{id, name≤60, initials, active, pickable, hint?}]` for ACTIVE, INACTIVE and soft-deleted users, **excluding ONBOARDING**. Names only (no email or phone), bidi-stripped. `hint` is the primary team name, sent only when the name is duplicated. Memo 5 min. | — |
| 3 | POST `/pipeline/sync` | G · R | `{clientBuild:int, board?:{v:int≥-1}, mineH?:str≤64, project?:{id:uuid, rev:int≥0, hv:int≥0, ack?:{seq:int≥0, open?:bool, leaving?:bool, seen?:uuid[≤50]}}}` | §5.2 | project gone → `project.status`, never 404 |
| 4 | GET `/pipeline/projects` | G · R | `?view=archived\|deleted&cursor=<ts,id>&limit≤30` | `{items: Card[], nextCursor}`; `deleted` lists your own, or all for admins, within 30 days | — |
| 5 | POST `/pipeline/projects` | G · W | `{clientId:uuid, title, description?, phaseId?, startDate?, dueDate?, memberIds?:uuid[≤20] (deduped)}` | 201 `{card, replayed:false}` / 200 `{card, replayed:true}` | 400; 404 PHASE_NOT_FOUND; 409 PHASE_ARCHIVED, MEMBER_NOT_PICKABLE |
| 6 | GET `/pipeline/projects/:id` | G · R | `?around=<messageId>`; with no `around` and unread > 0, loads around the first unread | `{header, description, participants[≤200] (projection §3.5), me:{role, notify, lastReadSeq}, can:{archive, delete, restore, transferOwner, removeOthers}, messages[≤30, or 15+15 around], threadRev, headerRev, hasOlder, hasNewer, aroundMissing?}`. One statement. | 404 PROJECT_NOT_FOUND / PROJECT_DELETED; cross-project `around` → 404 |
| 7 | PATCH `/pipeline/projects/:id` | G · W | `{changes:{title?, description?, startDate?, dueDate?}, base:{same keys}}` | `{header}` | 409 EDIT_CONFLICT `{current}`, PROJECT_ARCHIVED; 400 DATE_ORDER |
| 8 | POST `/pipeline/projects/:id/move` | G · W | `{toPhaseId, afterId:uuid\|null, basePhaseId}` | `{card, placementAdjusted}` | 409 MOVE_CONFLICT `{current}`, PROJECT_ARCHIVED, PHASE_ARCHIVED |
| 9 | POST `…/archive`, `…/unarchive`, `…/restore` | G · W · +O (admin only if `*_by_admin`) | `{}` | `{card, phaseAdjusted}` (idempotent) | 403 NOT_OWNER_OR_ADMIN / REMOVED_BY_ADMIN; 409 RESTORE_WINDOW_PASSED |
| 10 | DELETE `/pipeline/projects/:id` | G · W · +O | `{confirmTitle}` | `{deleted:true}` (idempotent soft delete) | 403; 409 CONFIRM_MISMATCH |
| 11 | PUT `…/owner` | G · W · +O | `{userId}` (ACTIVE and pickable) | `{header}` | 403; 409 USER_NOT_PICKABLE |
| 12 | POST `…/members` | G · W | `{userIds:uuid[1..20]}` (deduped; ACTIVE and pickable) | `{participants, added[]}` (idempotent) | 409 MEMBER_LIMIT, PROJECT_ARCHIVED |
| 13 | DELETE `…/members/:userId` | G · W · removal rule (§4.6) | — | `{result:"demoted"\|"removed"\|"none"}` | 403 CANNOT_REMOVE_MEMBER; 409 OWNER_CANNOT_BE_REMOVED |
| 14 | PUT `…/follow` | G · W · self only | `{following:boolean}` | `{role, notify}` (idempotent) | — |
| 15 | GET `…/messages` | G · R | `?before=<seq>&limit≤50 (30)`, top-level only | `{messages, hasOlder}` | 404 |
| 16 | GET `/pipeline/messages/:mid/replies` | G · R | `?after=<seq>&limit≤50` | `{root, replies, hasMore}` | 404 (includes a soft-deleted project) |
| 17 | POST `…/messages` | G · W · M | `{clientId:uuid, body, parentId?:uuid}` | 201/200 `{message, root?, replayed, notified:uuid[], notNotified:[{id, reason:"inactive"\|"not_in_pilot"\|"unknown"}]}` | 409 PROJECT_ARCHIVED, MESSAGE_DELETED, IDEMPOTENCY_KEY_REUSED; 400 MENTION_LIMIT |
| 18 | PATCH `/pipeline/messages/:mid` | G · W · +Au | `{body}` | `{message, notNotified}` | 403 NOT_AUTHOR; 409 MESSAGE_DELETED, PROJECT_ARCHIVED |
| 19 | DELETE `/pipeline/messages/:mid` | G · W · +Au (**allowed on archived**) | — | `{message}` (tombstone, idempotent) | 403 NOT_AUTHOR; 404 on a deleted project |
| 20 | PUT `/pipeline/messages/:mid/reactions/:emoji` | G · W | `{on:boolean}`; emoji in the allowlist | `{messageId, reactions, rev}` (a no-op changes nothing) | 409 MESSAGE_DELETED, PROJECT_ARCHIVED |
| 21 | POST `/pipeline/projects/:id/read` | G · R | `{seq:int, leaving?:boolean}` | `{lastReadSeq}` | — (keepalive only: on leave or hidden) |

Every message-only route (16, 18, 19, 20) resolves the message through `JOIN pipeline_projects p ON p.id = m.project_id AND p.deleted_at IS NULL`. The project is always derived from the stored row; a body can never choose it.

#### 3.5 Validators and wire shapes

`packages/shared/src/validators/pipeline.ts` uses no lookbehind, because it also runs in HR.
- **Title:** `z.string().max(240).transform(stripBidi).pipe(safeString).pipe(z.string().min(1).max(120))`. The length bound comes **before** the quadratic transform.
- **Description and body:** `z.string().max(5000 | 4000).transform(normalizeText)`, where `normalizeText` applies NFC, strips C0 controls except `\n` and `\t`, strips bidi controls (U+202A–202E, U+2066–2069, U+200E/200F, U+061C), converts CRLF to `\n`, and trims. The body must be non-empty. These fields never use `safeString` and are rendered only as React text.
- **Dates:** `YYYY-MM-DD` with a real-calendar refine, and start ≤ due when both are set.
- **Id arrays:** `z.array(z.string().uuid()).max(20).transform(a => [...new Set(a)])`.
- **Emoji:** `z.enum(["thumbs_up","heart","laugh","party","eyes","check","pray","fire"])`.
- **Mentions:**
  - Parsed server-side from `@{<uuid>}` with a linear scan (fixed 36-character class), unique and capped at 20 (otherwise 400).
  - Filtered in SQL to ACTIVE and pickable users. Only delivered ids are stored in `mention_ids`; the rest come back in `notNotified`.

**Message wire shape**
```
{ id, clientId? (only on the viewer's own messages), projectId, seq, rev, parentId,
  authorId, authorName, body, mentions:[{id,name}], reactions:{emoji:[userId]},
  replyCount, lastReplyAt, editedAt, deletedAt, createdAt }
```
- `authorName` and `mentions[].name` come from the in-process directory memo at response time, with no query.

**Participant projection**
- Other participants: `{userId, role, isOwner, memberAddedById, createdAt}`.
- `notify`, `lastReadSeq` and `seenAt` are returned **only** in `me`.

---

### 4. Authorization model

1. **Token gate.** `PIPELINE_TOKEN_TYPES = ["hr"]`, a code constant and an allowlist.
   - `authenticate` alone would admit client tokens, including typeless client refresh tokens, because all portals share one secret.
   - Wrong type → 403.
   - Phase 2 adds `"employee"`; both token types carry the same `User.id`.
2. **Feature gate.** `pipeline.mode` ∈ `off|pilot|on`, and an absent row means off.
   - Pilot mode restricts access, directory `pickable`, member adds, mention delivery and every notification recipient to `pipeline.pilotUserIds`.
   - `on` requires P0 to be live.
3. **Active user.** HR login refuses ONBOARDING and INACTIVE users, and the access memo cuts off a deactivated user within 60 s. Every write statement also re-checks `status='ACTIVE' AND deleted_at IS NULL` for the actor in SQL.
   - Self-registration creates ACTIVE users, and the owner has decided to keep that, so "any user who can log into HR" includes anyone who self-registers.
   - **P0** closes only the takeover path: registration can no longer promote or overwrite an existing ONBOARDING row.
4. **Open access.** No per-project ACL.
   - Every handler loads the project with `deleted_at IS NULL`.
   - Archived projects are read-only: writes return 409 `PROJECT_ARCHIVED`. The exceptions are unarchive and an **author deleting their own message**, which is a redaction, not an edit.
   - Child resources derive `projectId` from the stored row.
5. **Owner/admin actions** (archive, unarchive, delete, restore, transfer owner, removing others).
   - Owner = `owner_id` from the `FOR UPDATE` row.
   - Admin = a fresh `EXISTS` query over `user_roles ⋈ roles` for `Super Admin`/`Admin` at action time. JWT `roles` are never used, and the `can.*` flags only hide or show buttons.
   - When a **non-owner admin** archives or deletes, `archived_by_admin` / `deleted_by_admin` is set. Unarchive or restore then requires an admin.
   - Restore works only while `deleted_at > now − 30 days`.
6. **Participant rules** (proposed and adopted).
   - **Roles:** `MEMBER` or `FOLLOWER`. The owner always holds a MEMBER row, and ownership itself is only `owner_id`.
   - **Add:** anyone may add members. An add creates or promotes rows to MEMBER, sets `member_added_by_id/at`, and **never changes `notify`**.
   - **Who may remove someone else:** the owner or an admin (anyone except the owner, who must transfer first), or the adder within 10 minutes (`role='MEMBER' AND member_added_by_id=$me AND member_added_at > now − 10 min`).
   - **Effect of removing someone else:**
     - If the person **never engaged** (`engaged_at IS NULL`), the row is deleted.
     - Otherwise they are **demoted** to FOLLOWER, keeping their `notify` and read state. They stay in a conversation they took part in and may unfollow themselves.
   - **Leave** (self) deletes your own row. **Follow/unfollow** is self-only and is the only way to change `notify` or a FOLLOWER row.
   - Remove and Leave refuse when `user_id = owner_id`.
   - Everyone keeps open access; posting again re-follows.
7. **Messages.** Edit and delete are author-only. Admin moderation is an open question (§14).
8. **Deactivated owner.** The project stays usable with an "Owner inactive" chip, and an admin transfers ownership. It is never reassigned automatically.
9. **What open access does not open.**
   - The directory exposes names and team hints only.
   - Other people's notifications, read state, mute state and `seen_at` are never exposed.
   - Admins get no implicit notifications.

---

### 5. Sync and polling protocol

#### 5.1 Cursors

- **`rev`** = `pipeline_projects.thread_rev`, bumped **inside** the transaction that makes the change, under that project's row lock.
  - An operation that restamps **k** message rows bumps `thread_rev` by k (`UPDATE … SET thread_rev = thread_rev + k RETURNING thread_rev`). It assigns `r−k+1 … r` in a fixed order, child first and root last.
  - k = 2 for sending or deleting a reply (the reply and its root). k = 1 for a top-level send, an edit, a reaction, or deleting a top-level message.
  - The row lock hands out values in commit order within a project, and `@@unique([projectId, rev])` gives a total order. A delta page may split a reply from its root; the client merge tolerates that.
- **`hv`** = `header_rev`, bumped by any change to the header, participants or owner.
- **`board v`** = `pipeline_board_state.seq`. It is bumped **after** the writing transaction commits, never inside one:
  - `UPDATE pipeline_board_state SET seq = seq + 1, updated_at = timezone('utc', now()) WHERE id = 1 RETURNING seq`, as its own autocommit statement. The lock is held only for that statement, inside Postgres.
  - Safety argument: a bump happens only after its writer committed. A reader that reads `v` and then rows sees every change whose bump is ≤ v. A change committed but not yet bumped may also appear, so the snapshot is at worst newer than its label, which costs one redundant download.
  - If the bump fails, an in-process `boardBumpPending` flag retries it on the next pipeline request. The boot self-check bumps once, which covers a crash between commit and bump.
  - Bumped by: create, a title or date edit, move, member-count change, owner change, archive, unarchive, delete, restore, and the phase script. Messages never bump it.
- **Regression safety:** the snapshot cache serves only when `cache.v === board_v`. The client adopts a snapshot whenever `v` differs **in either direction**, which covers a DB restore or a re-seeded row. The runbook still says to restart the API after any DB restore.
- **No cursor advances from a write response**, because your own message's `rev` can be newer than messages you have not seen.

#### 5.2 `POST /v1/pipeline/sync`

Request (≈150 B):
```json
{ "clientBuild": 1, "board": { "v": 41 }, "mineH": "3f9a…",
  "project": { "id": "…", "rev": 118, "hv": 7, "ack": { "seq": 57, "seen": ["…"] } } }
```
- `board` is sent only while the board is mounted; `v:-1` forces a snapshot.
- `ack` is sent only while the project view is visible (§5.5).

Response `data` when nothing changed (≈200 B):
```json
{ "v": 41, "board": null, "mineH": "3f9a…", "mine": null,
  "project": { "id": "…", "status": "ok", "rev": 118, "hv": 7, "header": null,
               "participants": null, "messages": [], "hasMore": false, "lastReadSeq": 57 },
  "pollMs": 10000, "mode": "on", "reload": false }
```

**Server steps** (one bulkhead slot, one connection; every statement autocommit, indexed and bounded):
- **R1: one read statement, one snapshot.** CTEs compute:
  - `board_v`;
  - the overlay: `pipeline_participants ⋈ pipeline_projects` for `$me`, live projects only, `GREATEST(last_message_seq − last_read_seq, 0)::int AS unread`, `ORDER BY project_id LIMIT 500`;
  - if `project` is present:
    - the head row (`thread_rev, header_rev, last_message_seq, move_gen, due_date, archived_at, deleted_at`);
    - the delta: messages with `rev > $rev ORDER BY rev LIMIT 51`, replies, tombstones and reaction changes included;
    - my participant row (`last_read_seq, seen_at, role, notify`);
    - the header plus projected participants (≤200), only when `header_rev <> $hv`.

  The returned cursor is the 50th row's `rev` when `hasMore`, otherwise the head `thread_rev` read in the **same statement**. Node computes the overlay hash and omits `mine` when it equals `mineH`. A missing or deleted head gives `status:"deleted"`; `archived_at` gives `status:"archived"`.
- **A1: optional ack statement** (§5.4). Issued only if any of these hold:
  - `ack.seq > me.lastReadSeq`;
  - `me.seenAt` is older than 30 s;
  - `seen` is non-empty;
  - `open` or `leaving` is set.
- **Board.** If `board` is present and `board_v !== board.v`, `getBoardSnapshot(board_v)` returns the cached snapshot when `cache.v === board_v`. Otherwise it runs a single-flight rebuild on its own slot: one rebuild per board change for the whole company.
- **Build check.** If `clientBuild < pipeline.minClientBuild`, the response carries `reload:true`.
- **Mode** (added 2026-10-01, GA; additive). Every response carries `mode` (`"pilot"` or `"on"`), like `pollMs`. A tab whose bootstrap gave it a different mode re-checks bootstrap (at most once per 2 minutes); the new mode re-keys the directory, so a pilot → on flip reaches a `/pipeline` tab that never loses focus.

#### 5.3 Board snapshot

Snapshot = `{v, phases[], cards[], perPhase:{[phaseId]:{shown, total, truncated}}}`. It is built in **one statement**, so the label equals the rows:

```sql
SELECT (SELECT seq FROM pipeline_board_state WHERE id = 1) AS v,
       (SELECT json_agg(ph ORDER BY ph.position, ph.id) FROM pipeline_phases ph WHERE ph.archived_at IS NULL) AS phases,
       (SELECT json_agg(c) FROM (
          SELECT ph.id AS phase_id, cards.*
            FROM pipeline_phases ph
            CROSS JOIN LATERAL (
              SELECT p.id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
                     ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                            WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                            ORDER BY pp.created_at LIMIT 3) AS preview,
                     count(*) OVER ()::int AS phase_total
                FROM pipeline_projects p
               WHERE p.phase_id = ph.id AND p.archived_at IS NULL AND p.deleted_at IS NULL
               ORDER BY p.rank COLLATE "C", p.id
               LIMIT 101) cards
           WHERE ph.archived_at IS NULL
           ORDER BY ph.position, ph.id) c) AS cards
```

- The window count runs before `LIMIT`, so `phase_total` is the full per-phase count.
- A phase with 101 rows sends 100 cards and is marked truncated.
- Each card is about 230 B; a typical board of 300 cards is ≈70 KB raw, rebuilt once per change. Whether compression is on is unverified; check the response headers in the pilot.
- A phase can be archived only with zero referencing rows, and unarchive/restore relocate cards (§6), so every live card sits in a live phase.

#### 5.4 Read state and notification clearing

- **Unread badge** = `last_message_seq − last_read_seq`, clamped at ≥ 0, shown as "9+" when large, for participants only.
- **Author's own post:** advances the author's marker only if they were caught up (`last_read_seq = seq − 1`).
- **Auto-followed mentioned users** start at `seq − 1`.
- **Edits, reactions and deletes** move `rev`, not `seq`, so they never create unread.
- **What the client acks:** `ack.seq` is the highest `seq` whose row intersected the viewport by at least 50% (IntersectionObserver). `seen` is the ids of *rendered* messages that mention me or reply to my message, and that intersected the viewport or were opened in the ReplySheet or via `?m=`.

**A1**, one autocommit statement:
```sql
WITH adv AS (
  UPDATE pipeline_participants pp
     SET last_read_seq = GREATEST(pp.last_read_seq, LEAST($seq, p.last_message_seq)),
         seen_at = CASE WHEN $leaving THEN NULL ELSE timezone('utc', now()) END,
         updated_at = timezone('utc', now())
    FROM pipeline_projects p
   WHERE p.id = pp.project_id AND pp.project_id = $pid AND pp.user_id = $me
  RETURNING pp.last_read_seq)
UPDATE notifications n SET read = true
 WHERE n.user_id = $me AND n.read = false
   AND ( ( n.id = ANY($projectIds::text[])
           AND ( n.metadata->>'seq' IS NULL
                 OR (n.metadata->>'seq')::int <= COALESCE((SELECT last_read_seq FROM adv), $seqCap) ) )
      OR n.id = ANY($seenIds::text[]) )
```

- **`$projectIds`** are primary keys computed by `plnId()`:
  - the grouped row `messages:<pid>:<me>`;
  - `added:<pid>:<me>`;
  - `moved:<pid>:<me>:<gen>` for the current `move_gen` and the 4 before it;
  - `due_soon:` and `overdue:` for the current `due_date`.
- **`$seenIds`** = `mention:<mid>:<me>` and `reply:<mid>` for each seen id.
- **`$seqCap`** = `LEAST(ack.seq, last_message_seq)`, used when the viewer has no participant row.
- **Cost:** bounded primary-key probes (≤ ~60 rows), with no scan and no new index.
- **Clearing rules:**
  - Mention and reply rows clear **only** when that message is actually seen (or clicked in the bell); never by the project-level ack.
  - "Added", "moved" and "due" rows clear when you view the project, at most one ack per 30 s unless you advance.
- **Divider:** the exact "N new" divider sits at `me.lastReadSeq`. No COUNT is ever run.

#### 5.5 Client scheduling and failure behaviour

**One `SyncEngine` per tab**, in `app/pipeline/layout.tsx`, keyed by user id. At most one request is in flight. The next tick is `pollMs × U(0.8, 1.2)`, with base values supplied by the server:

| Tab state | Interval |
|---|---|
| Project open, tab focused | 10 s |
| Project open, visible but not focused | 20 s |
| Board only, focused | 15 s |
| Board only, visible but not focused | 30 s |
| Visible, no input for 5 min | 30 s; the next interaction syncs immediately |
| `document.hidden` or offline | paused. On hide: keepalive `POST /read {leaving:true}` |

**Wake-ups**
- Becoming visible or regaining focus triggers an immediate sync if the last one was ≥ 3 s ago.
- Coming back online triggers a sync after **2 s plus up to 1 s of jitter**.
- After one of your own successful writes, the engine syncs at most once per 2 s.
- `hasMore` chains up to 3 immediate follow-ups; after that the engine reloads the thread.

**Response handling.** Never render "Too many requests", "An unexpected error occurred" or "Something went wrong".

| Response | Behaviour |
|---|---|
| 200 | Merge the data and reset the backoff. `reload:true` → one hard reload, at most once per 10 min, after the outbox flushes. |
| 429 `PIPELINE_RATE_LIMIT` | Pause for `retryAfterSec` (sent in the body) ±20%. Keep the data. After 2 minutes show a subtle pill: "Live updates paused for a moment". |
| 503, 5xx, HTML 502, network error | Back off 10 → 20 → 40 → 60 s (capped) with ±30% jitter. After 2 failures show "Reconnecting… · updated 40 s ago". **Cursors and data are kept.** |
| 400, 404 or any other unexpected 4xx on /sync | Back off 60 s, then at most one hard reload per 10 min after the outbox flushes. |
| 403 `PIPELINE_DISABLED` | Show "Pipeline is paused". **Not terminal:** re-check bootstrap every 3 min ± jitter while visible, and resume automatically. |
| 403 `PIPELINE_NOT_IN_PILOT`, `ACCOUNT_INACTIVE`, `FORBIDDEN` | Terminal: stop polling and show a friendly page with a manual Retry. |
| `project.status = deleted` / `archived` | "This project was deleted" / a read-only banner. Polling continues (background cadence when archived). |
| 401 | `apiFetch` refreshes once (P1). If the refresh is rejected → `/login?next=`; if it is transient → treated as a 5xx. |

**Only a successful response may claim emptiness.** A failed poll never clears anything.

#### 5.6 SSE later, with no data-model change

- Add `GET /pipeline/stream` as a fetch-stream sent with the Authorization header. Never `EventSource`, and never a token in the URL, which morgan would log.
- It sends **pokes only**, such as `{"v":43}` or `{"p":"…","rev":131}`, with a heartbeat every ≤ 25 s.
- Pokes come from an in-process emitter at the same post-commit points; Redis pub/sub would replace it if the API were ever clustered.
- A poke triggers the same `/sync`, and polling relaxes to 60 s as the safety net. A dropped stream (every deploy) degrades to normal polling.

---

### 6. Concurrency and idempotency

**Transaction shapes**
- **Autocommit single statements:** sync reads, the ack, the board bump, reads of detail and history, and directory and access memo misses.
- **Interactive transactions** (`pipelineWrite`): only operations that must lock a **single project row** and then run JS between statements. Each takes ≤ 4 statements.
- **Before the transaction opens:** parsing, mention extraction, directory-name lookups, snippet building and `plnId` computation.
- **Never inside a transaction:** a board bump, a memo miss or any global-client call.

**Global lock order** (every path takes a subsequence):
1. project row (`FOR UPDATE`);
2. message rows;
3. participant rows (`ORDER BY user_id`);
4. notification rows (`ORDER BY id`).

A post locks participant rows only for the author and mentioned users, and existing notification rows only for recipients. A viewer's ack locks their own participant row and then their notification rows, which is the same order. Mark-all-read locks one user's notification rows only. The 40P01 retry remains as a backstop.

| Operation | Statements (after BEGIN) | Retry safety |
|---|---|---|
| **Message send** | **S1:** `SELECT … FROM pipeline_projects p WHERE p.id=$pid FOR UPDATE`, plus scalar subqueries for (a) an existing message by `(author_id, client_id)`, (b) the parent row, (c) whether the actor is ACTIVE. **Decisions, in this order:** existing in the same project → return `replayed:true` with no writes, *whatever the current state*; existing in another project → 409 `IDEMPOTENCY_KEY_REUSED`; project missing or deleted → 404; archived → 409; actor inactive → 403; parent missing or in another project → 404; root deleted → 409 `MESSAGE_DELETED`. The root is `parent.parent_id ?? parent.id`. **S2** (data-modifying CTE): bump `last_message_seq` by 1 and `thread_rev` by k, set `last_message_at`; INSERT the message; for a reply, UPDATE the root's `reply_count`, `last_reply_at` and `rev = r`. **S3:** upsert participants via the mutation path below (author: FOLLOWER if new, `notify=true`, `engaged_at`, author read-marker rule; mentioned: FOLLOWER if new with `last_read_seq = seq − 1`, `engaged_at`; new rows skipped past the 200 cap and logged); bump `header_rev` if any row was inserted. **S4:** notifications (§7) in one statement. COMMIT. | Exactly once, notifications included. A retry before COMMIT does the work; a retry after COMMIT replays. |
| **Create project** | **S1:** look up `(created_by_id, client_id)` first; if found → replay. Then validate the phase (live, not archived), that the actor is ACTIVE, and that members are ACTIVE and pickable. `memberIds` is deduped and stripped of the creator. **S2:** INSERT the project (rank = `keyBetween(null, firstRankInPhase)`, so it goes to the top); participant rows with the owner's MEMBER row first and members `ON CONFLICT DO NOTHING` (`member_added_by_id/at` set); "added" notifications. COMMIT, then the **post-commit board bump**. On 23505 on the key: roll back, re-read, replay. | Exactly once |
| **Card move** | **S1:** lock the card. **S2:** read the target phase and neighbours: `a` = `afterId`'s rank if it is still live in the target phase, otherwise the last rank (`placementAdjusted=true`); `b` = the next rank `> a` COLLATE "C" excluding self. **JS:** if the current phase is neither `basePhaseId` nor `toPhaseId` → 409 `MOVE_CONFLICT {current}`; if the card is already in the target phase and already between a and b → no-op 200 (a retry); otherwise `rank = keyBetween(a, b)`, then the move-merge decision (§7.6). If the key is over 64 characters, **rebalance** (below). **S3:** UPDATE the card (phase, rank, `phase_changed_*`, `move_*`, `header_rev+1`) and the move notification upsert or net-zero delete, in one statement. COMMIT, then the board bump. | A retry after success is a no-op. Someone else reordering the phase is not a conflict. |
| **Rebalance** (rare) | Inside the move transaction: `SELECT id, rank FROM pipeline_projects WHERE phase_id=$p AND archived_at IS NULL AND deleted_at IS NULL ORDER BY id FOR UPDATE` (a consistent lock order, with fresh values once locked). Compute N keys from that read, ordered by `rank COLLATE "C", id`. Apply with `UPDATE … FROM (VALUES …) v WHERE p.id = v.id AND p.phase_id = $p`. | No lost reorders, no deadlock |
| **Concurrent drops into the same gap** | Ties are allowed (rank has no unique constraint) and sort by id; the next move resolves them. | cosmetic |
| **Field edits** | **S1:** lock the row and read it. **JS:** per field, conflict iff `current ≠ base AND current ≠ desired` → 409 `EDIT_CONFLICT {current}`; check the date order. **S2:** UPDATE with `header_rev+1`. COMMIT; board bump only if the title or dates changed. Due-alert markers re-arm automatically, because they compare against `due_date`. | idempotent |
| **Reactions** | **S1:** lock the project (derived from the message). **S2:** a conditional jsonb UPDATE: add with `jsonb_set(…, arr || to_jsonb($me))` when `NOT (arr ? $me)`, remove with `arr - $me`. Bump `thread_rev` and set `rev` **only if it changed**; a no-op returns the current state. | idempotent |
| **Participant mutation path** (add, remove, leave, follow/unfollow, auto-follow in send, owner transfer) | Lock the project, then the DML per §4.6, then `member_count = (SELECT count(*)::int FROM pipeline_participants WHERE project_id=$p AND role='MEMBER')`, then `header_rev + 1`. COMMIT; board bump if `member_count` or the owner changed. Member add: `INSERT … ON CONFLICT (project_id,user_id) DO UPDATE SET role='MEMBER', member_added_by_id=EXCLUDED.member_added_by_id, member_added_at=EXCLUDED.member_added_at WHERE pipeline_participants.role='FOLLOWER'` (never touches `notify`). "Added" notifications go only to newly created or promoted rows. Removal uses `deleteMany` / `updateMany` plus a count check, and never matches `user_id = owner_id`. Owner transfer, in the same transaction: set `owner_id`, and upsert the new owner's row as MEMBER with `notify=true`. | idempotent; counters exact under races |
| **Message edit** | **S1:** lock the project. **S2:** `UPDATE … WHERE id=$mid AND project_id=$pid AND author_id=$me AND deleted_at IS NULL`; zero rows → classify as 404, 403 or 409. `rev` k=1. Only **newly added** mentions are notified (diff against `mention_ids`; deterministic ids make a remove-then-re-add a no-op). The snippets in this message's notification rows are rewritten (§7.11). | last write wins (one author) |
| **Message delete** | Same guard, and allowed on archived projects. Blank `body`, `mention_ids` and `reactions`, and set `deleted_at`. For a reply, decrement the root's `reply_count`, k=2. Redact notification rows (§7.11). | idempotent |
| **Archive, unarchive, delete, restore, owner transfer** | Lock the row; fresh owner/admin check (§4.5); conditional UPDATE. Unarchive and restore: if the card's phase is archived, move it to the first live phase (`phaseAdjusted`) at the top rank. Delete also deletes the grouped rows (§7.11). COMMIT, then the board bump. | idempotent |

**No fire-and-forget writes** anywhere in the feature. That means no `dispatchNotification`, no `auditLog` and no `requirePermission` on pipeline routes.

---

### 7. Notifications

#### 7.1 Enum and routing

- **One permanent value:** `NotificationType.PIPELINE`.
- `NOTIFICATION_AUDIENCE.PIPELINE = []`, with a comment saying it is written only by `services/pipeline/notify.ts`. A stray `dispatchNotification` call writes nothing.
- **Discriminator:** `metadata.kind`.
- **Unchanged:** the row shape, `/hr/notifications` and `/admin/notifications`.

```json
{ "v": 1, "kind": "messages|mention|reply|added|moved|due_soon|overdue",
  "pid": "<projectId>", "mid": "<messageId>?", "rid": "<rootId>?", "seq": 57, "n": 3,
  "lastMid": "<messageId>?", "app": "hr", "path": "/pipeline/<pid>?m=<mid>&t=<rid>",
  "url": "https://hr.digitalsukoon.com/pipeline/<pid>?m=<mid>&t=<rid>" }
```
`url` is built server-side from `HR_APP_URL`.

#### 7.2 Deterministic ids

- All ids are `md5('pln:<kind>:' || parts joined by ':')::uuid::text`, produced by `plnId()` (TypeScript) or `plnIdSql()` (the SQL fragment builder). A parity test asserts both give the same text.
- They are UUID-shaped, so `markAsRead` and the existing routes work unchanged.

| kind | parts | on conflict |
|---|---|---|
| messages | pid, uid | upsert and re-arm (§7.4) |
| mention | mid, uid | do nothing |
| reply | mid (recipient = root author) | do nothing |
| added | pid, uid | re-arm only if the existing row's `created_at` is > 24 h old; otherwise do nothing |
| moved | pid, uid, gen | upsert with `read=false` and a bumped `created_at` |
| due_soon | pid, uid, due_date | do nothing |
| overdue | pid, uid, due_date | do nothing |

#### 7.3 Recipient predicate

One SQL fragment is used by **every** notification INSERT:
```
u.status = 'ACTIVE' AND u.deleted_at IS NULL
AND r.user_id IS DISTINCT FROM $actor            -- $actor NULL for the due cron
AND ($allow::text[] IS NULL OR r.user_id = ANY($allow::text[]))   -- pilot allowlist
```

- **Base set for grouped, moved and due rows:** participants with `notify = true`, joined to `users`, plus the fragment.
- **Direct rows:**
  - **mention:** the mentioned user, even if they unfollowed;
  - **reply:** the root author, even if they unfollowed or left, and never when they are the replier;
  - **added:** only the person added.

  All three pass through the fragment.
- **No admin lookup** exists anywhere in this path.
- Every recipient array is deduplicated before a multi-row upsert.

#### 7.4 Grouped "N new messages" (in place, race-safe)

Written in the post transaction (S4), after the participant upserts:

```sql
INSERT INTO notifications (id, user_id, type, title, message, read, metadata, created_at)
SELECT <plnIdSql('messages', $pid, r.user_id)>, r.user_id, 'PIPELINE'::"NotificationType",
       $prefix || '1 new message', $preview, false,
       jsonb_build_object('v',1,'kind','messages','pid',$pid,'n',1,'seq',$seq,'lastMid',$mid,
                          'app','hr','path',$path,'url',$url),
       timezone('utc', now())
  FROM (SELECT pp.user_id FROM pipeline_participants pp
          JOIN users u ON u.id = pp.user_id
         WHERE pp.project_id = $pid AND pp.notify
           AND <recipient fragment>
           AND NOT (pp.user_id = ANY($direct::text[]))          -- mention/reply recipients get their own row
           AND (pp.seen_at IS NULL OR pp.seen_at < timezone('utc', now()) - interval '45 seconds')
         ORDER BY pp.user_id) r
ON CONFLICT (id) DO UPDATE SET
  read = false, created_at = EXCLUDED.created_at, message = EXCLUDED.message,
  metadata = EXCLUDED.metadata || jsonb_build_object('n',
     CASE WHEN notifications.read THEN 1 ELSE COALESCE((notifications.metadata->>'n')::int,0) + 1 END),
  title = $prefix || (CASE WHEN notifications.read THEN 1
                      ELSE COALESCE((notifications.metadata->>'n')::int,0) + 1 END)::text || ' new messages';
```

- **Parameters:**
  - `$prefix` = `"“<title≤60>”: "`, by concatenation. `format()` is not used, because a `%` in a title would break it.
  - `$preview` = `notificationSnippet()` output (§7.9), for example "Priya: <snippet≤100>".
- **Semantics:**
  - The row is updated in place until read, then re-armed at `n = 1`.
  - A viewer whose `seen_at` is < 45 s old gets no bump. Leaving the tab nulls `seen_at` through the keepalive, so the 45 s window is only the fallback when that signal is lost.
  - If the bell marks the row read just before a bump, the upsert sees `read = true` and re-arms it. If the bump lands first, the user may acknowledge "4" having seen "3", which is benign.

#### 7.5 Mentions and replies

- Individual rows, `ON CONFLICT DO NOTHING`. Mention takes precedence over reply, so a person gets at most one entry per message, and those people are excluded from the grouped row.
- Both carry `seq`, `mid` and `rid`.
- **Auto-follow on mention:** a new row is FOLLOWER with `notify=true`. An existing row keeps its `notify`, so an explicit unfollow is kept, but gets `engaged_at`.
- **Text:**
  - "Priya mentioned you in “Diwali campaign”" / "“<snippet≤140>”";
  - "Priya replied to your message in “Diwali campaign”" / "“<snippet≤140>”".

#### 7.6 Phase moves: 2-minute merge

Decided in JS on the row locked `FOR UPDATE`:
- **Same generation** when the phase changed AND `move_actor_id = me` AND `now − move_last_at ≤ 2 min` AND `now − move_started_at ≤ 10 min`. Keep `move_gen` and `move_from_phase_id`; set `move_last_at`.
- **New generation** otherwise: `move_gen + 1`, `move_from_phase_id = old phase`, `move_started_at = move_last_at = now`, `move_actor_id = me`.

Notification rows:
- **Upsert:** `moved:<pid>:<uid>:<gen>` for the recipients.
- **Text:** "Aisha moved “Diwali campaign” to Review" / "From In Production → Review".
- **Net-zero move** (back to `move_from_phase_id` within the same generation): delete this generation's **unread** rows by id and clear `move_actor_id`.
- **Never notified:** a reorder within a phase.
- **Always recorded:** `phase_changed_at` and `phase_changed_by_id`, which the header shows.

#### 7.7 Added to a project

- "Rahul added you to “Diwali campaign”" / "Phase: Planning · due Sat 27 Sep".
- Goes only to newly created or promoted MEMBER rows, never to the creator.
- An add/remove/add loop within 24 h leaves one row, with `created_at` unchanged.

#### 7.8 Due tomorrow and overdue (IST, Sunday-only weekend)

New pure helpers in `packages/shared/src/utils/date.ts`:
- `dayOfWeekIST(key)`;
- `isWorkingDayIST(key)` (day `!== 0`);
- `nextWorkingDayIST(key)`;
- `istMinutesOfDay(d = new Date())` = `(d.getUTCHours()*60 + d.getUTCMinutes() + 330) % 1440`.

**`pipeline-due.cron.ts`**
- **Schedule:** a tick every 60 min; first run 17 min after boot. The overlap flag is claimed **synchronously before the first `await`**.
- **Sends only when:** `mode != off`, the schema check passed, `todayIST()` is a working day, and `570 ≤ istMinutesOfDay() < 1200` (09:30–20:00 IST).
- **Due soon:** `due_date ∈ (today, nextWorkingDay(today)]`, so a Saturday run covers Sunday and Monday. **Overdue:** `due_date < today`.
- **Both kinds:** skip archived, deleted and terminal-phase projects, and require `<kind>_notified_for IS DISTINCT FROM due_date`.
- **Write:** one statement per kind, batches of 200:
  ```sql
  WITH t AS (
    UPDATE pipeline_projects p SET due_soon_notified_for = p.due_date, updated_at = timezone('utc', now())
     WHERE p.id IN (SELECT p2.id FROM pipeline_projects p2
                     WHERE p2.archived_at IS NULL AND p2.deleted_at IS NULL
                       AND p2.due_date > $today AND p2.due_date <= $nextWorking
                       AND p2.due_soon_notified_for IS DISTINCT FROM p2.due_date
                     ORDER BY p2.id LIMIT 200 FOR UPDATE SKIP LOCKED)
       -- every predicate repeated so EvalPlanQual re-checks the LATEST row version:
       AND p.archived_at IS NULL AND p.deleted_at IS NULL
       AND p.due_date > $today AND p.due_date <= $nextWorking
       AND p.due_soon_notified_for IS DISTINCT FROM p.due_date
       AND p.phase_id NOT IN (SELECT id FROM pipeline_phases WHERE is_terminal)
    RETURNING p.id, p.title, p.due_date)
  INSERT INTO notifications (id, user_id, type, title, message, read, metadata, created_at)
  SELECT <plnIdSql('due_soon', t.id, pp.user_id, t.due_date)>, pp.user_id, 'PIPELINE', …
    FROM t JOIN pipeline_participants pp ON pp.project_id = t.id AND pp.notify
           JOIN users u ON u.id = pp.user_id
   WHERE <recipient fragment with $actor = NULL>
  ON CONFLICT (id) DO NOTHING;
  ```
- **Text (amended 2026-10-01 — stored text must stay true after it is written):**
  - "“Diwali campaign” is due Saturday (27 Sep)", or "… is due Monday (29 Sep)" when sent on a Saturday. Always the ABSOLUTE day, never "tomorrow": the row is read for up to 90 days and mobile shows it verbatim. (The email keeps "due tomorrow (Sat 27 Sep)": it is read near send time and is worded against the send day.)
  - "“Diwali campaign” is overdue — was due Sat 27 Sep, still in Review".
  - Every stored or emailed date carries its year when that is not the current IST year ("is due Friday (1 Jan 2027)", "was due Tue 30 Dec 2025").
  - A due-date change, or a move into a terminal phase, withdraws the superseded due-soon / overdue rows by primary key and clears the `*_notified_for` markers, so the bell alert re-arms if the date comes back. The re-armed due-soon email skips anyone already mailed about that (project, date). A participant row that is deleted (a leave, or removing someone never engaged) takes that user's due rows for the current date with it — later withdrawals reach current participants only.
- **Restart safety:** idempotent across restarts, and a tick with nothing to do costs one indexed probe.

#### 7.9 Text and snippets

`notificationSnippet(body, names, max)` is shared, and every title and message goes through it:
- mention tokens rendered as names from the directory memo;
- whitespace collapsed;
- bidi controls stripped;
- **grapheme-safe** truncation with `Intl.Segmenter` plus "…".

Titles are ≤ 120 characters and messages ≤ 200, so rows read as standalone text on mobile. A test asserts no `PIPELINE` row contains `@{` or a lone surrogate.

#### 7.10 Deep links in the clients

- **HR bell (P3):** for `type==='PIPELINE' && metadata.path?.startsWith('/pipeline/')`, a row click marks it read, closes the panel and calls `router.push(path)`. The detail view gains "Open project →".
- **Pipeline page, same-page link:** the page handles `?m`/`?t` changes in an effect keyed on their values (§9.6).
- **Internal bell (P4):** for `type==='PIPELINE'`:
  - skip the title and message heuristic;
  - render "Open in Employee Portal ↗" as `<a target="_blank" rel="noopener noreferrer">` with `onClick={e => e.stopPropagation()}`;
  - render it only when `new URL(metadata.url).origin` is in the **code constant** `["https://hr.digitalsukoon.com", "http://localhost:3002"]` and the pathname starts with `/pipeline/`. Not an env var, because `deploy.sh` rewrites `.env.local`.
- **No HR session:** P5's `?next=` returns the user to the project after login.
- **Mobile:** unchanged; rows read as text. An optional, owner-gated OTA update may later open an allowlisted `metadata.url` (milestone M8).

#### 7.11 Redaction on edit, delete and project deletion

All of this happens in the same transaction as the action.
- **Message delete** removes (read *or* unread):
  - the mention rows `mention:<mid>:<uid>` for every uid in the old `mention_ids`;
  - the reply row `reply:<mid>`.

  Grouped rows whose preview came from this message are rewritten: `UPDATE notifications SET message = '<Name> deleted a message' WHERE id = ANY(<messages:pid:uid for current participants, ≤200>) AND metadata->>'lastMid' = $mid`.
- **Message edit** rewrites `message` on the same mention, reply and grouped rows with the new snippet.
- **Project soft delete** deletes the grouped rows of current participants by primary key. Direct rows are handled by the purge.

#### 7.12 Retention and purge

Scheduled by **wall clock**, never at boot.
- **Scheduling:** at boot, compute the milliseconds to the next 04:00 IST with `istMinutesOfDay` and `setTimeout`. The job runs only if the IST minutes are in [210, 330) and `pipeline.trimLastRunIST ≠ todayIST()`. It sets the marker when finished, then schedules the next 04:00.
- **Trim:**
  ```sql
  DELETE FROM notifications n WHERE n.id IN (
      SELECT id FROM notifications WHERE type = 'PIPELINE'
         AND ((read AND created_at < timezone('utc', now()) - interval '30 days')
              OR created_at < timezone('utc', now()) - interval '90 days')
       LIMIT 2000 FOR UPDATE SKIP LOCKED)
    AND n.type = 'PIPELINE'
    AND ((n.read AND n.created_at < timezone('utc', now()) - interval '30 days')
         OR n.created_at < timezone('utc', now()) - interval '90 days')
  ```
  It loops until 0 rows or 20 iterations, with 500 ms pauses, each batch in its own transaction with `SET LOCAL statement_timeout='5s'`. A deleted grouped row is recreated by the next message.
- **Purge** (projects soft-deleted more than 30 days ago), up to 20 projects per run. Per project:
  1. Lock the project and re-check `deleted_at < now − 30 days`.
  2. Collect the affected user set: participants ∪ distinct message authors ∪ `unnest(mention_ids)`.
  3. Delete `type='PIPELINE' AND metadata->>'pid' = $pid` rows **per user** through the `(user_id, read)` index prefix.
  4. Delete replies, then roots, in chunks of 1,000; each chunk is its own transaction that re-checks the project lock.
  5. Delete the project row, which cascades its participants.
  Each chunk must take < 1 s, which requires `parent_id` to be indexed.

#### 7.13 Volume

- **Estimate:** 40 active projects × 8 participants × 25 messages a day. Grouped traffic is mostly in-place UPDATEs.
- **Direct rows per day:** about 200 mention and reply rows, about 640 move rows and about 50 due rows.
- **Steady state:** under about 60k `PIPELINE` rows.
- **Never notified:** archive, unarchive, delete, restore, a field edit, an owner change, a reaction.

---

### 8. Rate limiting and load budget

#### 8.1 Isolated buckets

- **Global limiter:** skips `/v1/pipeline/*`.
- **Pipeline instances:** each has its own MemoryStore and `windowMs: 60_000`. Keys come from `pipelineRateLimitKey`: users are keyed even when the token has expired, and IP keying is used only for unsigned tokens.
- **Handler response:** `{success:false, error:{code:"PIPELINE_RATE_LIMIT", message:"Live updates paused for a moment", retryAfterSec}}`.

| Bucket | Covers | Limit per user |
|---|---|---|
| Read | GET, `POST /sync`, `POST /read` | 120 / min |
| Write | every other method | 120 / min |
| Messages | `POST …/messages` (also counted in Write) | 40 / min |

- **Consequence:** pipeline traffic cannot 429 HR submit, Link History, accounts or login, and a user who exhausted the global bucket elsewhere can still use the pipeline.
- **Env knobs:** `PIPELINE_RATE_READ_MAX`, `PIPELINE_RATE_WRITE_MAX` and `PIPELINE_RATE_MSG_MAX`, for tests only (`vi.unstubAllEnvs()` in `afterAll`).
- **Restarts:** counters reset on every restart, which is acceptable for one process.
- **Client:** a 429 on any write is held and replayed after `retryAfterSec` (§9.4).

#### 8.2 Requests per user

| Scenario | Reads / min | Writes / 15 min |
|---|---|---|
| Typical: one focused project tab | ~7 | ~15 |
| Heavy: focused project, a board window and another project visible | ~13 | ~90 |
| Extreme: 5 visible windows, plus 30 project opens in a minute (detail + sync each) | ~21 plus a 60 burst | ~120 |
| **Limits** | **120 / min** (≥ 1.4× headroom even on the triage burst) | 120/min writes, 40/min messages |
| **Added to the global HR bucket** | **0.** P3 lowers the HR bell from 60 to 30 requests per 15 min per tab. | |

#### 8.3 DB pools and hold times

**Pools**
- **Main pool (10), unchanged:** analytics ≤ 2, so ≥ 8 remain for login, RBAC, HR submit, bells and crons.
- **Pipeline pool (3), separate:** all pipeline work, including memo misses and background jobs.
- **Postgres:** +3 backends. P9 confirms `max_connections` headroom and free RAM; the harness measures the second engine's RSS.

**Hold targets** (the harness must confirm them)

| Request | Statements | Hold p95 target |
|---|---|---|
| sync, board or project | 1 (R1) | ≤ 3 ms |
| sync with ack | 2 (R1 + A1) | ≤ 5 ms |
| board snapshot rebuild | 1, once per board change company-wide | 5–20 ms |
| project detail | 1 | ≤ 8 ms |
| post message (≤ 200 recipients) | 4 + BEGIN/COMMIT | ≤ 10 ms |
| move (+ merged notification) | 3–4 + BEGIN/COMMIT; board bump after | ≤ 8 ms |
| bootstrap, directory, access checks | 0 on a memo hit | — |

- **Locks:** interactive transactions lock one project row. Only same-project writers can wait, bounded by `lock_timeout` 1 s, which maps to 503 and a silent client retry. The global board row is locked only inside a sub-millisecond autocommit statement.
- **Worst case:** a plan flip holds the 3 pipeline connections for ≤ 2.5 s, and the pipeline answers 503. Nothing else is affected at the pool level.

#### 8.4 CPU

The 1 vCPU is shared with Postgres, nginx/TLS, four Next servers and co-tenants.
- **Per sync:** about 0.5–1 ms in Node (two HS256 verifies, Zod, JSON) plus about 1–3 ms in Postgres.
- **Company peak** (60 visible tabs, about 5 syncs/s): roughly 15–25 ms of CPU per second, 1.5–2.5% of the vCPU.
- **User text:** the only regex over it is the linear token scan.
- The harness measures end to end in a single CPU cgroup.

#### 8.5 Evening rush and restarts

- **Evening rush (17:30–21:30 IST):**
  - Pipeline tables are disjoint from `daily_reports` and `report_links`.
  - `pipeline.pollMs` (15 s memo) can stretch the cadence with no deploy.
  - The due cron is light; the trim runs at 04:00.
- **Restarts (≤ 15 a day):** limiters, memos, the snapshot cache and the bulkhead are disposable.
  - Clients see a few seconds of 502 and back off 10 s ±30%.
  - The boot bump makes each open board fetch one snapshot.
  - In-flight writes either committed (a retry replays) or did not (a retry performs them).

#### 8.6 Traps outside our control

- **Avatars:** `<img src="/uploads/…">` sends no Bearer token and lands in the anonymous `ip:<edge>` bucket that login shares. **v1 uses initials only.**
- **nginx and fail2ban:** a `limit_req zone=api` keyed on the edge IP, plus fail2ban's `nginx-limit-req` jail (bantime 3600), could firewall-ban a Cloudflare edge for an hour. **P9 blocks the pilot** until this is checked and remediated (§10).
- **CORS:** without `maxAge`, every poll pays a preflight, which doubles nginx-counted requests. **P12 (`maxAge: 600`) is required before the pilot.**
- **Logs:** morgan's 2xx `/sync` lines are skipped (P13).

---

### 9. Frontend (HR portal)

#### 9.1 Files

```
apps/hr/src/app/pipeline/layout.tsx       <PortalShell fitViewport><PipelineProvider key={user.id}>{children}</PipelineProvider></PortalShell>
apps/hr/src/app/pipeline/page.tsx         Board (?view=archived|deleted; reader inside <Suspense> with real-content fallback)
apps/hr/src/app/pipeline/[id]/page.tsx    Project (?m=<messageId>&t=<rootId>)
apps/hr/src/app/pipeline/error.tsx        pipeline error boundary (own copy, Reload; drafts untouched)
apps/hr/src/app/global-error.tsx          last-resort boundary
apps/hr/src/components/modal-portal.tsx   port of internal ModalPortal
apps/hr/src/components/pipeline/
  provider.tsx      bootstrap + directory (SWR, user-keyed) · store · SyncEngine · outbox
  store.ts          reducer: phases, cards, mine, projects{header, participants, messages, replies, cursors}, pendingOps
  sync-engine.ts    §5.5 scheduler
  outbox.ts         pending sends keyed pl:v1:<userId>:outbox, items carry authorId
  header/  PipelineHeader.tsx (title, actions, <NotificationBell/>)
  board/   Board.tsx · PhaseTabs.tsx · DropTray.tsx · PhaseColumn.tsx · ProjectCard.tsx · MoveSheet.tsx · NewProjectSheet.tsx · ProjectListView.tsx
  project/ ProjectHeader.tsx · DetailsPanel.tsx · MembersPanel.tsx · PeoplePicker.tsx
  thread/  Thread.tsx · MessageItem.tsx · MessageBody.tsx · ReactionBar.tsx · ReactionPicker.tsx · ReplySheet.tsx · Composer.tsx · MentionPopover.tsx
  ui/      Sheet.tsx · Toast.tsx · Skeleton.tsx · StatusPill.tsx · EmptyState.tsx · LoadError.tsx · Initials.tsx
  hooks/   use-visual-viewport.ts · use-idle.ts · use-seen-observer.ts
  pipeline.css      all classes prefixed .pl-
packages/shared/src/pipeline/  rank.ts (vendored fractional-indexing, CC0 — verify LICENSE; exports compareRank) · mentions.ts · due.ts · text.ts (normalizeText, stripBidi, notificationSnippet) · refresh.ts (classifier used by P1)
packages/shared/src/validators/pipeline.ts · packages/shared/src/types/pipeline.ts
```

- **Nav:** one `NAV_MAIN` entry in `hr-sidebar.tsx` (`/pipeline`, "Pipeline", lucide `SquareKanban`), shown only when `bootstrap.enabled && bootstrap.navVisible` (mode `on`). The orphaned `components/top-nav.tsx` is not touched.

#### 9.2 Shell and layout

- **`PortalShell` gains an opt-in `fitViewport` prop.** It swaps `min-h-screen` for a viewport-bounded height on the wrapper and `main`. The default is unchanged for the other 25 layouts.
- **No `Topstrip`.** Pipeline pages render their own `PipelineHeader` (56 px): the title, page actions and **`<NotificationBell/>`**. There is no `backdrop-blur`, so fixed children are not trapped.
- **Sizing:** `height: calc(var(--pl-vh, 100dvh) - var(--pl-top))`, where `--pl-top` is 56 px below `lg` (the HR mobile bar) and 0 at `lg`. Scrollers are `min-h-0 flex-1 overflow-y-auto overscroll-contain`. The board's horizontal scroller is its own `overflow-x-auto` with `min-w-0` ancestors.
- **`useVisualViewport` contract:** it listens to `visualViewport` `resize` and `scroll` and sets `--pl-vh` (height) and `--pl-vvtop` (offsetTop). Consumers:
  - the page;
  - every fixed sheet (`top: var(--pl-vvtop); height: var(--pl-vh)`);
  - the mention popover, positioned from `offsetTop + height`.
- **Phone project page (< lg):** a **portalled full-screen surface** at z-45, above the HR mobile bar (z-40). It has its own compact header (back, title, phase pill, bell, ⋯) and is sized by the contract, so the composer stays above the iOS keyboard. The composer is the last flex child, never `position:fixed` by itself.
- **Tablet/desktop project page:** conversation in the centre, a 340 px details and members column, and replies in a 400 px side panel.

#### 9.3 Data layer and identity scoping

- **SWR** is used only for request-once data: `['/pipeline/bootstrap', userId]` and `['/pipeline/directory', userId, mode]` (10-minute dedupe), and the archived and deleted lists (`useSWRInfinite`, limit 20). *Amended 2026-10-01 (GA):* bootstrap alone overrides the options below with `revalidateIfStale: true`, `revalidateOnFocus: true` and a 10-minute `focusThrottleInterval`, so a `pipeline.mode` flip reaches open tabs (at most one bootstrap request per 10 minutes per tab); the directory key includes the bootstrap mode, so pilot users' cached `pickable: false` entries are fetched again after GA; and every sync carries the mode, so an enabled `/pipeline` tab re-checks bootstrap when it differs. Options:
  ```ts
  export const PL_SWR = {
    revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false,
    keepPreviousData: true, errorRetryCount: 4,
    onErrorRetry: (err, _k, _c, revalidate, { retryCount }) => {
      const s = err?.status;                       // P1 adds status to ApiError
      if (s && s < 500 && s !== 0) return;         // never retry 400/401/403/404/409/429
      if (retryCount >= 4) return;
      setTimeout(() => revalidate({ retryCount }), Math.min(60_000, 5000 * 2 ** retryCount) * (0.8 + Math.random() * 0.4));
    },
  };
  ```
- **Live board and thread** live in the reducer store fed by the SyncEngine, not in SWR. No hook uses `refreshInterval`, and there is no global `SWRConfig`.
- **Identity:**
  - Every `localStorage` key is `pl:v1:<userId>:…` (outbox, drafts, remembered view), wrapped in try/catch.
  - All `pl:` keys are purged in `HrAuthProvider.logout`, in `apiFetch`'s session-expired branch (P1), and in `login()` when the incoming user id differs from the stored one.
  - Outbox items carry `authorId` and are discarded if it is not the current user.
  - `<PipelineProvider key={user.id}>` resets the store and cursors.
- **Merge safety:** the delta merge runs in try/catch. On any exception the engine reloads that project's state (route 6) instead of throwing.

#### 9.4 Optimistic updates

Pending ops are laid over server rows at render time and resolved on every merge. A pending send resolves by `(authorId = me, clientId)`, which the server returns on the viewer's own messages in the POST, detail, history and sync responses.

| Action | Immediate | Success | 409 | 429 | 503 / 5xx / network | other 4xx |
|---|---|---|---|---|---|---|
| **Send** | Row shows "Sending…", keyed by `clientId` (`crypto.randomUUID`, with a `getRandomValues` v4 fallback) | Replaced by the server row. `notNotified` → inline "Aisha wasn't notified — account inactive" | `PROJECT_ARCHIVED` → text kept in a **readOnly** composer with Copy and the banner; `MESSAGE_DELETED` → "Post in the main conversation instead"; `IDEMPOTENCY_KEY_REUSED` → mint a new key and resend once | Held; replay after `retryAfterSec`, one at a time in clientId order; "Sending is slowed down — retrying in 8 s" | Held; auto-retry with the **same** clientId (≤ 5, backoff). "Couldn't send — Tap to retry (it won't post twice)" only once a sync completed after the last attempt still lacks the clientId | 400 → text back in the composer with the reason. Nothing is dropped silently. |
| **Move** | Card moves locally | Server `{phaseId, rank}` merged | Restore the server card and toast "Rahul just moved this to Review" | Held and retried after `retryAfterSec` | Card stays where dropped, marked "Checking…"; one idempotent retry after 2 s; the next sync settles it. "Couldn't move" only if a sync shows the old phase | Restore |
| **Edit field** | New value shown | Merged | Sheet with both versions: "Keep theirs" / "Overwrite". The user's text is never lost | Auto-retry after `retryAfterSec` | "Not saved · Retry" | Restore with the reason |
| **Reaction** | Chip toggles | Reconciled with the returned `reactions` | Revert | Retry after `retryAfterSec` | Revert | Revert |

**Outbox replay:** entries under 5 minutes old replay automatically. Older ones render as "Unsent message from Tue 14:02 · Send / Discard". A 404 or 409 drops the entry and returns its text to a copyable composer.

#### 9.5 Board and drag-and-drop

- **Library:** `@dnd-kit/core` + `@dnd-kit/sortable` (MIT, ≈15–20 KB gzipped, loaded only on `/pipeline`). Check the lockfile entry (CI uses `npm ci`) and the HR build memory on the 2 GB box.
- **Card structure:**
  - An `<li><article>` whose title is a real `<button>` stretched over the card with `::after`. The ⋯ button (44×44, always visible) and the keyboard grip are **siblings**, never nested.
  - The text column is `min-w-0`, and the title uses `[overflow-wrap:anywhere]` with a two-line clamp. No `shrink-0` on any text.
  - A due chip (from `YYYY-MM-DD` against the browser-local today key): "Overdue" (icon plus text) or "Due tomorrow".
  - Owner initials plus up to 3 member initials and "+N", the unread badge (participants only) and an "Owner inactive" chip.
  - `-webkit-touch-callout:none; user-select:none; touch-action:manipulation`.
- **Phones (< 768 px):**
  - Filter chips (All · My projects · Following), a local search field, and a **sticky** horizontally scrollable phase-chip bar with counts. One phase's list is shown at a time.
  - **Long-press (250 ms, 6 px tolerance) drags.** While a drag is active, a **sticky, wrapping drop tray** replaces the chip bar and lists **every** phase as 44 px targets in 2–3 rows. Dropping on a tray target moves the card to the end of that phase; dropping inside the list reorders.
  - `navigator.vibrate?.(10)` on pick-up.
  - After any cross-phase move (drag or Move to…), a persistent toast reads "Moved to Review · View · Undo". Undo is a move back using `basePhaseId`. Focus moves to the next card, and aria-live announces the move.
- **Tablet and desktop:** 288 px columns with their own vertical scrollers; dragging across columns auto-scrolls.
- **Sensors:**
  - `MouseSensor{distance:6}`, so a click never starts a drag.
  - `TouchSensor{delay:250, tolerance:6}`.
  - `KeyboardSensor` on the grip, with keys `{start:['Space'], end:['Space'], cancel:['Escape']}`, so Enter still opens the card.
  - The `DragOverlay` is portalled to `document.body` at z-60. Board and thread containers carry no `anim-*` classes.
- **Non-drag paths:** "Move to…" in the ⋯ sheet (phases, top or bottom) and a phase `<select>` in the project header.
- **Announcements:** "Picked up “Diwali campaign” in Planning… moved to Review, position 2 of 5… dropped." Animations are off under `prefers-reduced-motion`.
- **Ordering:** cards sort client-side with the shared `compareRank`. Per-phase truncation shows "Showing 100 of 143 — archive finished ones to see the rest".

#### 9.6 Project page, thread and composer

- **Phone header:**
  - back button;
  - title (`min-w-0 flex-1 truncate`);
  - phase pill (`min-w-0 max-w-[45%] truncate`; the full name shows in its sheet; never `shrink-0`);
  - bell;
  - ⋯ (Details, Members, Follow, Archive/Delete when `can.*` allows).
- **Tabs:** Conversation | Details. Fields are edited with an explicit Save; `<input type="date">` gets `.pl-date` containment (`min-width:0; max-width:100%`, plus `appearance:none` under touch).
- **Initial position:** opens **around the first unread** message (route 6 default), with a "New messages" divider at `lastReadSeq`. A "↓ N new" pill appears when you are more than 120 px from the bottom.
- **Thread:**
  - "Load earlier" (30 at a time) preserves the position by measuring `scrollHeight` before and after.
  - **No `content-visibility`**; at most about 100 rows are rendered at once.
  - A polite aria-live region announces new messages only when you are not at the bottom.
  - Messages from one author within 5 minutes are grouped, with 28 px initials coloured by a hash of the user id.
  - A deleted message with no replies is hidden; one with replies shows "This message was deleted".
- **Seen tracking:** `use-seen-observer` (IntersectionObserver, threshold 0.5) produces the ack seq and the `seen` ids (§5.4).
- **Deep link:** the highlight (2 s), the around-load and the ReplySheet are driven by an effect keyed on the **current** `m` and `t` values, so a click from the bell for the project already open still works:
  - target loaded → scroll to it;
  - target not loaded → load around it;
  - target missing or deleted → load the latest page and toast "That message is no longer available".
- **`MessageBody`:**
  - a linear tokeniser produces React nodes for text, `@{uuid}` and `http(s)://…`;
  - a token whose id is in `message.mentions` renders as a chip with the server-provided name; any other token renders as grey plain text ("@Name" if the directory knows the id, otherwise "@…");
  - link text is rendered from the **parsed URL** (punycode host plus path), http(s) only, with `rel="noopener noreferrer nofollow"`, `target="_blank"`, trailing punctuation trimmed and `[overflow-wrap:anywhere]`;
  - names carry `unicode-bidi:isolate`;
  - `whitespace-pre-wrap`, and **no `dangerouslySetInnerHTML`**.
- **Actions:**
  - Every message has an always-rendered, visible, tabbable "More actions" button: React · Reply · Copy text · Copy link · Edit/Delete if yours.
  - Tapping the message also opens the row. No control is hover-only.
- **Reactions:**
  - Chips (44 px, `aria-pressed`) show the emoji and count, highlighted if yours.
  - The picker is a portalled 4×2 grid.
  - Long-press or the `title` attribute lists who reacted, using directory names.
- **Replies:** "3 replies · 5m" opens the ReplySheet, which is full-screen and portalled on phones and a side panel on desktop. It pushes `?t=` so browser and Android back close it, and it traps and restores focus.
- **Composer:**
  - An auto-growing textarea (1–6 lines) at 16 px with an `aria-label`, and a 44 px Send button.
  - **Enter sends only when** `matchMedia('(pointer:fine)').matches && navigator.maxTouchPoints === 0 && !e.shiftKey && !e.isComposing && e.keyCode !== 229`. Otherwise Enter inserts a newline.
  - Send is disabled only while the text is empty; any other blocker is shown in words.
  - A counter appears above 3,600 characters, and anything over 4,000 is an error. The text is never truncated.
  - **Drafts** are kept per project and per reply thread under `pl:v1:<userId>:draft:<pid>[:<rootId>]`, debounced 500 ms and stored in **tokenised form** (`@{id}`), so a restored draft keeps its mentions.
- **Mention picker:**
  - The trigger is found by scanning backwards from the caret, up to 30 characters, for an `@` at the start of the text or after whitespace. No regex lookbehind.
  - It filters the directory locally (pickable users only): name prefix first, then substring, participants first, at most 6 results, **zero requests per keystroke**.
  - A `hint` is shown for duplicate names.
  - Picks are stored as **positional ranges** `{start, end, userId}`, shifted on each edit and dropped if their text changes. Only those ranges serialise to `@{id}`, and pasted text is never tokenised.
  - It is portalled and `fixed` per the viewport contract: max height 40vh, 48 px rows, z-56.
  - ARIA `listbox` with `aria-activedescendant`. Keys: Up/Down, Enter or Tab to pick, Esc to close.

#### 9.7 Directory and names

- **`directory === undefined` (loading or failed)** is its own state:
  - authors and chips fall back to the server-provided `authorName` and `mentions[].name`;
  - the pickers say "Couldn't load people · Retry".
- **Genuinely absent:** "@former member" appears only when the directory **loaded** and the id is absent.
- **Retries:** 5xx and network errors are retried with capped backoff (`PL_SWR`). The first unknown id triggers one throttled revalidate (at most once per 2 min).

#### 9.8 Honest states

Only a **loaded** response may claim emptiness.

| State | Board | Project / sub-surfaces |
|---|---|---|
| Loading | skeleton columns or cards | skeleton bubbles; the ReplySheet, "Load earlier" and the archived and deleted lists each have their own skeleton |
| First load failed | auto-retry at 10, 20 and 40 s, then "Couldn't load the pipeline — your projects are safe. [Retry]" with the reason in words | same pattern per sub-surface ("Couldn't load replies · Retry", never an empty list under "3 replies") |
| Loaded, empty | "No projects yet — create the first one" | "No messages yet — start the conversation" |
| Empty because of a filter | built from filter, phase and search: "Nothing in Review for My projects — 4 in other phases" (links) | — |
| Polls failing after a load | data stays; "Reconnecting… · updated 40 s ago" | same |
| After wake from hidden or offline | "Updating…" or "Offline — updated 14:02" until the first sync lands | same |
| Truncated | per phase: "Showing 100 of N — archive finished ones to see the rest" | — |
| Paused / not in pilot / inactive | "Pipeline is paused" (auto-resumes) / "Pipeline isn't available for your account yet" / "Your account is inactive" | same; **unsent composer text stays visible and copyable** |
| Deleted / archived | — | "This project was deleted" / the read-only banner "Archived by Priya · 12 Sep"; the text stays copyable |

#### 9.9 Error boundaries and deploy skew

- **Error boundaries:** `pipeline/error.tsx` and `global-error.tsx` show "Something on this page failed to load. Your drafts are saved. [Reload]", never a raw message.
- **ChunkLoadError** (every deploy wipes `.next`): reload once, guarded by a sessionStorage flag.
- **Protocol version:** `PIPELINE_CLIENT_BUILD` is an integer constant sent as `clientBuild`. It is bumped whenever the sync protocol changes incompatibly, and the server enforces it with `pipeline.minClientBuild`.

#### 9.10 iOS and mobile checklist

- **Inputs:** 16 px on every focusable control (already global in HR).
- **Regex:** no lookbehind in source or in the shipped bundle (P8).
- **Overlays:** all portalled, on a z-scale of page header 20, mobile bar 40, phone project surface 45, sheets 50, mention popover 56, toasts 57, drag overlay 60.
- **Touch:** no hover-only controls; 44 px minimum targets.
- **Layout:** `dvh` plus the visualViewport contract. No `shrink-0` on unbounded text, and any `min-w-0` parent also clips. Long URLs wrap.
- **Devices:** real-device checks on an iPhone, including **Desktop Site mode**, and on Android Chrome, covering: reply from a deep link, the @-picker with the keyboard open, the PeoplePicker search, drag with the drop tray, and date fields.

---

### 10. Prerequisite hardening

Each item is its own small PR, deployed 11:00–16:00 IST on a working day unless marked otherwise.

| # | Fix | Why the feature needs it | Blast radius and verification |
|---|---|---|---|
| **P0** (required before GA) | `registerEmployee` never promotes or overwrites an existing row. An existing email or phone in **any** status, ONBOARDING included, gets the same 409 `ALREADY_EXISTS` that active rows get today. Pending hires are activated only through the admin flow. New sign-ups stay **ACTIVE** (owner decision, 2026-09-26). Bound `registerEmployeeSchema.name` before `safeString`: `z.string().max(240).pipe(safeString).pipe(z.string().min(2).max(120))`. *Recommended in the same PR:* correct the login-page copy that promises approval (`login/page.tsx:847, 955`). | The promotion path lets anyone take over an admin-created pending hire by registering with their email. With open access, that person could then act in the pipeline under the hire's name. | Register path only; login and submit are untouched. Tests: registering with an existing ONBOARDING email → 409, and the row, its roles and its password hash are byte-unchanged; a new registration is still ACTIVE and can log in. |
| **P1** (required before pilot) | HR `apiFetch`: (a) cap the 401 retry at one (`_retried`); (b) add `status` and `retryAfterSec` (from the body) to every `ApiError`; (c) three-way refresh: **ok**; **rejected** (the refresh endpoint answered 400/401 with JSON) → clear tokens and `pl:` keys, redirect to `/login?next=<path+query>` (P5 allowlist); **transient** (fetch threw, ≥ 500, 429, non-JSON) → keep tokens and throw a retryable `ApiError` (status 0 or 503). The classifier lives in `packages/shared/src/pipeline/refresh.ts` so apps/api vitest can test it. | An uncapped loop burns buckets and rotates tokens. The poller must tell 429, 403 and 5xx apart. Today a transient refresh failure logs the user out. | Every HR page. Success paths unchanged; new fields additive. Mocked-fetch tests per branch; full `npm run build`. |
| **P2** (ships in the feature PR) | Router-local `pipelineJson` (64 kb) and the pipeline error middleware with `classifyDbError`. *Recommended alongside:* the global `errorHandler` maps `entity.too.large` → 413 and `entity.parse.failed` → 400. | Oversized or malformed bodies and raw-SQL errors must never show "An unexpected error occurred". | The pipeline part is new code; the global part only turns today's 500s into 4xx. |
| **P3** (required before any `PIPELINE` row exists) | HR bell: fetch the list **only while the panel is open**, with `keepPreviousData`; a **skeleton** while `data === undefined && !error`; "Couldn't load notifications · Retry" on error; "No notifications yet" only for a loaded `[]`; deep link from `metadata.path` for `PIPELINE` rows. | Actionable rows, honest states, and 30 fewer global-bucket requests per 15 min per tab. | HR Topstrip and PipelineHeader. Playwright: loading, error and empty states; a seeded `PIPELINE` row navigates. |
| **P4** (required before any `PIPELINE` row exists) | Internal bell: skip the title heuristic for `PIPELINE`; render an origin-checked `metadata.url` anchor (code-constant allowlist, `stopPropagation`); the same loading, error and empty rules as P3. | Deep link; no false "Review & Approve"; honest states. | Internal TopNav rendering only. |
| **P5** (required before pilot) | Login return path: `HrAuthProvider` redirects to `/login?next=<pathname+search>`, read from `window.location` (no `useSearchParams`, which breaks static builds). Login reads `new URLSearchParams(window.location.search).get('next')` inside the submit handler and pushes it only if it starts with `/pipeline`, not `//`, and contains no `\`; otherwise `/dashboard`. | An internal-bell deep link for a user without an HR session would otherwise lose the project. | The first page everyone hits. Tiny diff, tests, full `npm run build`. |
| **P6** (feature) | `utils/bulkhead.ts` factory, plus the `pipelineDb` URL builder with unit tests (encoding `%20`/`%3D`, strips existing params). | Pipeline isolation. | New files only. |
| **P7** (tests) | `generateHrToken()` (type `"hr"`); unique emails in `createTestUser` (counter suffix); pipeline tables in `TRUNCATE_SQL` (`pipeline_messages, pipeline_participants, pipeline_projects, pipeline_phases, pipeline_board_state`); `invalidatePipelineCaches()` and `resetPipelineBulkheadForTests()` in `beforeEach`; `PIPELINE_DB_CONNECTIONS=1` in the vitest env. | Isolation; no millisecond-email P2002 flakes. | Tests only. |
| **P8** (CI) | Greps that fail the build: `\(\?<[=!]` in `apps/hr/src`, `packages/shared/src` and `mobile/src`, **and in `apps/hr/.next/static/chunks` after `npm run build`**; the `@dashmani/db` prisma import in `apps/api/src/services/pipeline/**` except `db.ts`; `localeCompare` on rank fields. A concurrency job: its own DB `dashmani_pipeline_cc`, `db:push` into it, its own vitest config with `pool:'forks', singleFork:true`, `PIPELINE_DB_CONNECTIONS=3`. | Lookbehind crashes older iOS; pool-math and ordering rules; the main suite's `connection_limit=1` cannot show interleaving. | CI only. Prove each grep fails on a planted violation. |
| **P9** (box, read-only; **blocks the pilot**) | `nginx -T`: `limit_req`, `limit_conn`, buffering and timeouts on the API block. `fail2ban-client status` and `status nginx-limit-req`, current bans, the jail log source. `SHOW max_connections`, free RAM, API RSS. Evening baseline: 429 and 502 per 15 min, P2024 lines, `pg_stat_activity` at peak, **per-edge requests/s including OPTIONS**. **Remediation before the pilot:** if the jail is live, disable it or `ignoreip` Cloudflare's published ranges; **never enable `real_ip` while that jail is active**; size any applied `limit_req` burst for the post-pipeline rate. | An edge-IP throttle or ban would reproduce the 2026-09-18 class, or worse. The baseline is the "no regression" yardstick. | None until remediation, which is a reviewed box change. |
| **P10** (sandbox) | What Prisma 5.22 does when it reads a `notifications` row whose enum value the generated client does not know. | The rollback plan (§12). | No code. |
| P11 (recommended, independent) | Linear `safeString`: an `indexOf` scan that reproduces the regex output byte for byte. | Platform-wide main-thread-hang class. The pipeline does not depend on it. | 32 validators. Property test against the old regex; 1 MB in < 50 ms. |
| **P12** (**required before pilot**) | `cors({ …, maxAge: 600 })`. | Halves pipeline round trips and nginx-counted requests. | Preflight caching for all portals; security-neutral. Verify the `Access-Control-Max-Age` header on prod. |
| P13 (feature PR) | morgan `skip` for 2xx `POST /v1/pipeline/sync`. | Several hundred thousand log lines a day. | Logging only. |
| P14 (recommended) | `CREATE INDEX CONCURRENTLY notifications_user_id_created_at_idx ON notifications (user_id, created_at DESC)` **built by hand first**, outside a transaction, then declared as `@@index([userId, createdAt])` in a **later** schema PR, so the diff shows nothing. | The bell list query grows with pipeline rows. | Index only. Never in a transaction, never from a datamodel diff. |

**Forbidden for this feature:**
- the `dispatchNotification`, `requirePermission`, `auditLog` and `withHeavyQuerySlot` helpers;
- the `/admin/link-preview` endpoint and `/uploads` avatars;
- the Task/TaskComment IDOR and unbounded-comment pattern;
- the Overview activity feed;
- a global `SWRConfig`;
- the global `prisma` client inside `services/pipeline`.

**Phase 2 prerequisite (not v1):** port HR's defensive `apiFetch`/`ApiError` (including P1) to the internal portal and ungate its 16 px floor.

---

### 11. Testing strategy

**Main DB-backed suite** (`apps/api/tests/pipeline/*.test.ts`). Run it from `apps/api` with `connection_limit=1`, as CI does, against a database nothing else is using.

**Setup**
- P7 helpers.
- `seedPipelinePhases()` in `beforeEach`.
- Tests delete their own `system_settings` keys.
- Always pass explicit unique emails.

**Gates** (template: `overview-standalone.test.ts`)
- HR token → 200; `employee` token → 403 in v1; client **access** token → 403; client **refresh** token → 403 on `bootstrap` and `sync`; no token → 401; expired token → 401.
- Inactive or soft-deleted user → 403 `ACCOUNT_INACTIVE` after invalidation.
- Mode off → 403 everywhere except `bootstrap`, which returns `{enabled:false}`.
- Pilot mode with a non-listed user → 403.
- Settings read failure (stubbed) → 503 `PIPELINE_BUSY`, never 403.
- Missing schema (stubbed self-check) → 403 `PIPELINE_DISABLED`.

**Registration (P0)**
- Registering with an existing admin-created ONBOARDING email → 409 `ALREADY_EXISTS`; the row, its roles and its password hash are byte-unchanged.
- A new registration is still ACTIVE and can log in (owner decision).
- Duplicate registration of an ACTIVE account → 409, as today.

**Authorization**
- A non-participant can view, move, edit, add members, post and react.
- Archive, delete, restore and transfer are 403 for others.
- Admin status comes **from the DB**, not the JWT.
- An admin delete → owner restore 403 → admin restore 200.
- Restore after 30 days → 409.
- Removal matrix:
  - owner/admin demotes an engaged member and deletes a never-engaged one;
  - the adder can undo within 10 minutes only for rows they added;
  - mention-then-remove by the mentioner → 403;
  - nobody but the user changes a FOLLOWER row;
  - add never flips `notify`;
  - remove or leave of the owner → 409.
- Owner transfer: afterwards the old owner can be removed and the new owner cannot.
- A message from project A under project B's URL → 404.
- Routes 16/18/19/20 on a soft-deleted project → 404; on an archived project → 409, except an author tombstone → 200.
- `?around=` with a message from another project → 404.
- Participant projection: other participants lack `notify`, `lastReadSeq` and `seenAt` on route 6 and on sync.

**Cursors**
- A post committed between two syncs always appears.
- A reply send and a reply delete each give two distinct revs.
- A delta with limit 2 across 5 changes returns all 5 exactly once over 3 calls.
- A board bump that fails after commit is retried on the next request.
- The boot bump invalidates snapshots.
- Server seq set below a client's v → the next sync returns a snapshot.
- The snapshot label equals its rows.
- Per-phase cap and totals are correct.
- A card in an archived phase is relocated on unarchive and restore.

**Idempotency**
- Same `clientId` twice → one row plus `replayed:true`.
- Same key in another project → 409.
- Post → archive → retry the same key → 200 replayed.
- Duplicate create → one project.
- Create with `memberIds:[me, a, a]` → 2 participants and `memberCount` 2.
- Add `userIds:[b, b]` → one row and one "added" notification.
- Reaction `{on:true}` twice → one entry and one rev bump.
- A move retried after success → no-op 200.
- A same-phase reorder with a new `afterId` → performed.

**Conflicts**
- A stale move whose current phase is neither base nor target → 409.
- A reorder by someone else plus my move → 200.
- Edits to different fields both succeed; the same field → 409; due < start → 400.

**Error classification** (through real raw statements)
- `SET LOCAL lock_timeout='1ms'` against a row held by a second connection → 503.
- `pg_sleep(3)` under a 1,500 ms statement timeout → 503.
- A raw duplicate insert → 409 or replay by constraint name.
- A raw 40P01 → one retry.
- Stubbed P2024 and P2028 → 503.
- **None of these returns 500.**

**Notifications**
- Grouped:
  - 3 messages → one row with `n=3`;
  - read, then a new message → `n=1` unread;
  - active readers suppressed;
  - `{leaving:true}` nulls `seen_at`, so the next message is not suppressed.
- Mentions:
  - a mention gets its own row, is excluded from the grouped row, and auto-follows at `seq−1`;
  - an explicit unfollow is kept;
  - an undelivered mention comes back in `notNotified`.
- Replies: the reply row goes to the root author, never to someone replying to their own root.
- Recipients exclude, **on every path including due**:
  - the actor;
  - inactive and soft-deleted users;
  - `notify=false` users (grouped, move and due rows only);
  - non-pilot users in pilot mode;
  - every non-participant admin.
- Move merge (`vi.setSystemTime`): same actor within 2 min, another actor, over 2 min, the 10-minute cap, a net-zero move deleting the row, a same-phase reorder sending nothing.
- Due cron (injected today and time):
  - Monday–Friday;
  - Saturday covers Sunday and Monday;
  - Sunday is a no-op;
  - 09:29 IST is a no-op, 09:30 sends, 20:00 is a no-op;
  - a re-run inserts nothing;
  - a changed due date re-arms;
  - **due-soon then overdue for the same date gives two distinct rows**;
  - terminal and archived projects are excluded;
  - a concurrent PATCH of `due_date` mid-cron does not stamp the wrong date;
  - the overlap flag is claimed before the first `await`.
- Ids: `plnId`/`plnIdSql` parity.
- Redaction: after a message delete, no notification row (read or unread) for any user contains the deleted text; after an edit, snippets are updated.
- Snippets: no `@{` and no lone surrogate in any `PIPELINE` row.
- A stray `dispatchNotification({type:'PIPELINE'})` writes nothing.
- **`/hr/notifications` and `/admin/notifications` keep exactly their key set** (a snapshot of the keys).

**Ack clearing**
- PK-list clearing works without a participant row: a non-participant with a reply row clears it through `seen`.
- The project-level ack never clears mention or reply rows.
- An admin with 5,000 unread GENERAL rows: each ack touches ≤ 60 rows (EXPLAIN shows no scan).

**Participants and counters**
- A concurrent add + remove race → `member_count` equals the real count.
- Every participant change bumps `hv`.
- At 200 participants a new user can still post (no row is added) and mentions are still delivered.

**Main-thread safety**
- A 1 MB `<`-only title or body → 400 in under 50 ms.
- Body over 4,000 characters → 400; 65 KB body → 413 JSON; malformed JSON → 400.
- Bidi-laden input is stripped.

**Bucket isolation** (`vi.stubEnv` + dynamic `import('../src/app')` + `vi.unstubAllEnvs()` in `afterAll`)
- Pipeline read max 3 → the 4th sync gets 429 with `retryAfterSec`, **while `POST /hr/reports`, `GET /hr/reports` and HR login still return 200**.
- Global `RATE_LIMIT_MAX=3` with 10 pipeline calls → all 200.
- `/V1/Pipeline/sync` is counted by the pipeline bucket.
- 100 syncs with an **expired** token from one IP → all 401, never 429.

**Retention and purge**
- Trim scheduling honours the 03:30–05:30 IST window and the marker, and never runs at boot.
- A trim racing a re-armed grouped row does not delete it.
- **Purge with ≥ 5,000 messages:** each chunk takes < 1 s; replies go before roots; the project's `PIPELINE` rows for all affected users are gone.

**Protocol**
- `clientBuild` below the minimum → `reload:true`.
- The v1 request fixture replays against the current build (additive-only contract).

**Canaries** (copy `submit-still-works.test.ts`), run with the pipeline router, limiters, `pipelineDb` and jobs loaded after heavy pipeline activity: internal login, HR login, HR submit persists, `GET /hr/reports`, `/hr/reports/today`, `GET /accounts`.

**Concurrency suite** (`apps/api/tests-concurrency/pipeline/`; own config, singleFork, own DB, `PIPELINE_DB_CONNECTIONS=3`; `raceAssert` shape)
- 30 parallel posts in one project → seq 1..30 with no gaps, unique revs, exact `last_message_seq`.
- **Skip-freedom proof:** a poller runs `/sync` every 20 ms while 200 posts, edits, reactions and reply deletes race across 3 projects. Every final message state is observed exactly once. Repeat 20 times.
- 8 parallel moves of one card with the same base phase → 1 success, and the rest idempotent 200s or 409s, with no 500.
- 12 cards dropped into one gap → all succeed, with a total order after the next move.
- **A forced rebalance (keys seeded at 63 characters) while 5 moves run in the same phase** → the final phase and order match the last committed move, with no deadlock.
- 10 parallel adds of the same user → one row and one notification.
- 10 identical reaction PUTs → one entry.
- Fan-out vs. ack vs. mark-all-read interleaved 500 times → never two unread grouped rows for one (user, project), never an unread grouped row for a fully-read project, no 40P01 after the retry.
- 8 parallel duplicate `clientId` posts → one message.
- A post-commit board-bump failure (injected) → the next request heals it.

**Load harness** (`scripts/load/pipeline-load.ts`)
- **Environment:**
  - It refuses any non-localhost `DATABASE_URL` and uses the `dashmani_load` database.
  - **Postgres, nginx with TLS and the API** (started with the prod tsx loader command line) run in **one** 1-CPU cgroup (a compose file with `cpuset: "0"` on every service, or a 1-vCPU VM), with 2 GB memory.
  - A background CPU and IO load of 20–30% stands in for co-tenants.
  - Prod settings: `connection_limit=10`, `DB_STATEMENT_TIMEOUT_MS=60000`, `NODE_ENV=production`, the pipeline pool at 3.
- **Data and users:** 115 users, 300 projects, 60k messages, **120 distinct HR tokens**.
  - Plus a **heavy-user case** for the §2 overlay bound: 2,000 extra archived projects, and one user who takes part in all of them plus 300 live ones (2,300 lifetime participations).
- **Load:** 20 minutes at the real cadence mix (60% board, 40% project), about 1 message/s org-wide plus reactions and moves. At the same time:
  - evening-rush HR submits of up to **450 links**;
  - logins and Link History;
  - `/hr/notifications/count` every 30 s per user;
  - a **synthetic cron workload** at prod-like cadence: a batch-upsert loop, a large JSON parse, a sequential write loop;
  - one `next build` (`--max-old-space-size=900`) mid-run;
  - a 30-client post-deploy herd plus a mid-run `kill -INT` and restart;
  - a triage burst of 30 messages plus 40 project opens in one minute for one user.
- **Pass criteria:**
  - **0 × 429 and 0 × 5xx on non-pipeline routes**;
  - **zero user-visible 429s** in the triage burst;
  - 0 P2024/P2028 on the main pool;
  - pipeline connections ≤ 3 (sampled every second from `pg_stat_activity`);
  - sync p95 < 30 ms; post p95 < 100 ms;
  - for the heavy user, the R1 statement's hold p95 stays within the §8.3 target (≤ 3 ms). If it does not, apply the §2 "not taken now" fix before the pilot;
  - login, HR-submit p95 and the **HR first-submit error rate** within 10% of a pipeline-disabled baseline run;
  - event-loop delay p99 < 50 ms (`monitorEventLoopDelay` under `PIPELINE_LOADTEST=1`);
  - **API RSS delta from `pipelineDb` ≤ 100 MB**, otherwise switch to the main-pool fallback (§3.2);
  - zero duplicate messages or notifications after the restart.
- **When:** before the pilot, and after any change to hot SQL.

**Frontend**
- **Pure modules** run through the apps/api vitest suite via `packages/shared`: `rank.ts`/`compareRank`, `mentions.ts`, `due.ts`, `text.ts` (normalise, bidi, snippet), `refresh.ts`, and the sync-engine state machine and backoff.
- **Playwright** against a local stack on a separate database, at 390×844, 768×1024 and 1280×800:
  - `document.scrollingElement.scrollHeight === innerHeight` on the board and project pages;
  - no horizontal overflow, measured with `Range.getBoundingClientRect` (the `truncate` trap);
  - every input computes to 16 px;
  - drag, the drop tray and Move-to all work, and the drag overlay is not clipped;
  - mention picker (including two same-named users), reply sheet with back navigation;
  - offline, 429, 403-paused (auto-resume) and deleted states via route mocks;
  - two users on one browser: A's unsent message is never posted as B, and B sees no A draft;
  - bell loading, error and empty states;
  - axe clean;
  - fixtures with a 40-character phase name and a 60-character unbroken title;
  - zero console errors.
- Never run `npm run build` while dev servers are up.

---

### 12. Rollout

**The DDL cycle (applies to PR-A and to *any* later PR that touches `pipeline_*` models or `NotificationType`)**

1. Generate feature-only DDL. Never a blanket `db:push`, because prod carries the hand-built `link_metrics_emp_url_fetched_ok_v2_idx`:
   ```bash
   cd packages/db && set -o pipefail
   git show origin/main:packages/db/prisma/schema.prisma > /tmp/base.prisma
   npx prisma migrate diff --from-schema-datamodel /tmp/base.prisma \
     --to-schema-datamodel prisma/schema.prisma --script > /tmp/pipeline.sql
   grep -nE 'DROP|ALTER TABLE "(users|notifications)"|ON "(users|notifications|report_links|daily_reports|social_accounts|link_metrics|link_metrics_latest)"' /tmp/pipeline.sql   # must print nothing
   ```
2. Hand-edit the script:
   - `ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PIPELINE'` (allowed in a transaction on PG ≥ 12; unused until commit);
   - `IF NOT EXISTS` on the creates;
   - wrap everything in `BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s'; … COMMIT;`;
   - append the seeds.

   The FKs to `users` take a brief SHARE ROW EXCLUSIVE lock, which blocks writes to `users` but not reads such as login. The tables are empty, so validation is instant, and a lock not granted within 3 s aborts; retry later.
3. **Apply on prod before merging**, on a weekday between 11:00–12:30 or 14:30–16:00 IST:
   1. back up with the `scripts/backup.sh` extraction and pipefail (not `pre-deploy-backup.sh`);
   2. `psql -v ON_ERROR_STOP=1 -f /tmp/pipeline.sql`;
   3. verify with `\d pipeline_*`, 7 phases, the board row and `SELECT unnest(enum_range(NULL::"NotificationType"))`;
   4. on the box, **inspect only** `prisma migrate diff --from-url $PROD --to-schema-datamodel prisma/schema.prisma --script`: the remaining drift must be exactly the known manual index (plus P14 if already built) and is **never applied**.
4. **Merge in the same window.** No prod `db:push` from any branch between applying and merging.
5. After the deploy, grep the logs for `PrismaClientValidationError|does not exist|P2024` and confirm the boot self-check passed.

**Sequence**
1. **Prerequisites**, each merged 11:00–16:00 IST on a working day, never 09:00–10:00 (login rush) or 17:30–00:30 (submit rush): P1, P3, P4, P5, P7, P8 and P12, plus the recommended P11, P13 and P14. **P0** is merged before GA. Verify health and the canaries after each.
2. **P9** box checks and remediation, and the **P10** sandbox check.
3. **PR-A: schema only.** Models, virtual back-relations, `PIPELINE`, `NOTIFICATION_AUDIENCE.PIPELINE = []`, the TRUNCATE list. Follow the DDL cycle.
4. **PR-B1: API core, dark.**
   - Contents: `pipelineDb`, bulkhead, limiters, `pipelineJson`, error middleware, gates, memos, boot self-check, all routes (no notification writes), board bump, morgan skip.
   - `pipeline.mode` is absent, which means **off**.
   - After deploy: `bootstrap` returns `{enabled:false}` for an HR token and 403 for a client token; the canaries pass; logs are clean; API RSS is recorded.
5. **PR-B2: notifications and jobs, dark.** `notify.ts`, redaction, ack PK clearing, the due cron and the wall-clock trim/purge. Requires P3 and P4 live. With mode off, no rows are written and the jobs no-op.
6. **PR-C: HR frontend.** The nav is hidden unless `navVisible`. Run the full `npm run build`, the bundle lookbehind grep, the lockfile check and watch HR build memory.
7. **Load harness and concurrency suite** pass (§11).
8. **Pilot** (5–10 named users, owner first, ≥ 5 working days including evenings):
   - `scripts/pipeline-flag.ts --mode=pilot --add=<emails>` (dry run by default; `--apply --confirm-prod`) upserts `system_settings`. It takes effect within 15 s.
   - **Monitor:** an hourly `[pipeline] stats` log line (syncs, sync p95, writes, 429 read/write/message, 503 busy, bulkhead waits and max queue, conflicts, notification rows written, slow syncs > 200 ms, pending board bumps); platform-wide P2024 = 0; global 429 and 502 not above the P9 baseline; HR-submit p95 within 10%; growth of `notifications WHERE type='PIPELINE'`; API RSS.
   - Run the real-iPhone checklist.
9. **GA:** requires P0 live. Set `pipeline.mode='on'`; a reload shows the nav at once. An already-open tab shows it at its first focus or page change at least 10 minutes after that tab's last bootstrap request (bootstrap revalidates on mount and on focus, bounded by the 10-minute dedupe and a focus throttle that starts when the hook mounts — amended 2026-10-01; before that it was fetched once per tab), so verify GA with a reload. A `/pipeline` tab holding a cached "not enabled" answer shows "Loading" while it re-checks on mount, then re-checks every ~3 minutes; an enabled one re-checks when a sync reports a different mode.
10. **Kill switches (no deploy):**
    - `mode=off` takes effect within 15 s: routes return 403 `PIPELINE_DISABLED`, clients show "paused" and re-check every 3 minutes, and jobs no-op.
    - `pipeline.pollMs` can be raised to 120 s.
    - `pipeline.minClientBuild` forces stale tabs to reload.
11. **Rollback:**
    - Prefer the kill switch. Reverting PR-B or PR-C is safe, because the tables simply go unused.
    - **Never revert PR-A.** Enum values cannot be dropped, and a client generated without `PIPELINE` may fail on those rows (P10 confirms the behaviour).
    - To abandon the feature: turn it off, revert the code, run `UPDATE notifications SET type='GENERAL' WHERE type='PIPELINE'` or delete those rows, optionally drop the `pipeline_*` tables, and keep `PIPELINE` in the enum forever.
12. **Runbook addition:** after any DB restore, restart the API. The snapshot equality rule self-heals anyway.

---

### 13. Risks and mitigations

| # | Risk | Mitigation | Residual |
|---|---|---|---|
| 1 | Pipeline polling 429s HR submit or Link History | Separate buckets; the global limiter skips with the same predicate; expired tokens keyed by user; visibility-gated single-request ticks; 429 held and retried silently; isolation tests | A 429 can hit only the pipeline, recovers in ≤ 60 s, and is silent |
| 2 | P2024 degrades login | Dedicated 3-connection `pipelineDb` outside the main 10; bulkhead; 2.5 s statement and 1 s lock timeouts; memoised gates; no `requirePermission`; single-flight snapshot | Postgres CPU is shared; the harness proves headroom |
| 3 | Second engine inflates API RSS toward the 800M cap | Harness gate (≤ 100 MB); fallback to the main pool with a 2-slot cap | — |
| 4 | Self-registered strangers get open access | Owner accepted this (self-registration stays instant). P0 closes the account-takeover path before GA; pilot allowlist until then | Accepted by owner |
| 5 | fail2ban or nginx bans a Cloudflare edge | P9 blocks the pilot; remediation rules; P12 halves request counts | Unknown until checked |
| 6 | A poller skips a message | Commit-ordered `thread_rev` under the project lock; unique revs; same-statement cursor; the k-rule; skip-freedom proof | — |
| 7 | Board staleness after a lost bump or a DB restore | Pending-bump retry; boot bump; equality-based cache and client adoption | — |
| 8 | Duplicate messages or projects after a 502 or restart | Body `clientId` with composite uniques; key lookup first; replay; outbox reuses the key | — |
| 9 | Order corrupted by concurrent drags | Server ranks under the card lock; phase-based conflict rule; locked rebalance | Cosmetic ties until the next move |
| 10 | Notification spam or growth | Grouped in place; active-reader suppression plus leaving signal; move merge; 24 h added re-arm; deterministic ids; daily trim | Direct rows live ≤ 90 days |
| 11 | Leak to admins, non-participants or former recipients | Own fan-out; `PIPELINE: []`; one recipient predicate; redaction on delete and edit; purge per user; nothing in Overview | Snippets of a soft-deleted project survive until its purge (≤ 30 days) |
| 12 | Internal bell mis-links pipeline rows | P4 before the first row; code-constant origin allowlist | — |
| 13 | Enum irreversibility breaks bells on rollback | Schema PR never reverted; P10; the `SET type='GENERAL'` escape hatch | Permanent enum value |
| 14 | Code deployed before the DDL, or a later PR skips DDL | DDL cycle for every pipeline schema PR; boot self-check pauses the feature instead of 500s | — |
| 15 | Blanket `db:push` drops the manual `link_metrics` index | Feature-only diff; prod diff inspected only | — |
| 16 | Main-thread freeze | Length bound before any transform; no `safeString` on bodies; 64 kb parser; linear tokenisers; no link previews; P11 | — |
| 17 | Raw-SQL errors become 500s | `classifyDbError` plus raw-statement tests | — |
| 18 | Touch drag unusable on phones | Drop tray; long-press sensor; always-visible Move to…; toast with Undo; real-device checks | Needs an iPhone pass |
| 19 | iOS keyboard hides the composer | `visualViewport` contract on the page, sheets and popover; phone surface | Device check |
| 20 | Lost typing, cross-user replay on shared devices | User-scoped outbox and drafts; purge on logout or switch; 5-minute auto-replay cap; tokenised drafts; conflict sheet | Private mode may disable storage (the send still works) |
| 21 | Deep link lost behind login | P5 `?next=`; P1 carries it on forced logout | — |
| 22 | Board grows past usefulness | Per-phase 100-card cap with disclosure; archive; §14 Q6 | Needs an owner policy |
| 23 | Deploy skew between old tabs and a new API | `clientBuild` / `minClientBuild`; additive-only `/sync`; error boundaries; ChunkLoadError reload | — |
| 24 | 40P01 in tests or prod | No fire-and-forget; fixed lock order; one retry; separate concurrency job | — |
| 25 | New dependency inflates the HR build on the 2 GB box | Only `@dnd-kit` (≈15–20 KB); ranking vendored; full local build before merge | — |
| 26 | Disk growth from messages (≈11 GB free) | Growth bounded by human typing; purge; §14 Q10 | — |
| 27 | Single-process assumptions (memos, snapshot cache, limiters, bump flag) | Correctness lives in the DB; caches disposable; boot bump; documented for any future cluster mode | — |

---

### 14. Open questions for the owner

1. **Unfollow and removal semantics.** Proposed and implemented:
   - an unfollowing member stays a member but is muted;
   - an @mention still notifies someone who unfollowed but does not re-follow them;
   - posting or replying re-follows them;
   - removing someone who never engaged removes them completely; removing someone who took part leaves them as a follower who may unfollow.

   OK?
2. **Holidays.** Should due and overdue alerts also skip company holidays, or stay Sunday-only?
3. **Overdue cadence.** Once per due date (proposed) or daily while overdue? Is the 09:30–20:00 IST send window OK?
4. **Moderation.** Besides authors, may the owner or Admins delete other people's messages? Proposed: not in v1.
5. **Delete.** Soft delete with a 30-day restore window, then a permanent purge. An admin's removal can only be undone by an admin. OK? Should delete require archiving first?
6. **Finished projects.** Stay on the board until archived (proposed), or auto-archive N days after reaching a terminal phase? This matters for the 100-card-per-phase cap on Done.
7. **Phases.** Brief → Planning → In Production → Review → Approved → Live → Done, with Done the only terminal phase. Correct?
8. **Phase moves in the thread.** Show them only in the header (proposed), or also as system lines in the conversation?
9. **Reactions.** Is the fixed palette of 8 (👍 ❤️ 😂 🎉 👀 ✅ 🙏 🔥) OK?
10. **Retention.** Delete pipeline notifications 30 days after they are read (90 days maximum): OK? Should messages of projects archived for more than 12 months ever be purged?
11. **Pilot.** Which 5–10 people, and who may flip the switch (the runbook script now; an internal admin toggle later)?
12. **Self-registration (P0): decided 2026-09-26.** Registration stays instant, and P0 closes only the takeover path. Optionally, review the current ACTIVE accounts once for unknown ones.
13. **Mobile.** After GA, should an OTA update make a tap on a pipeline notification open the project in the browser? The rows stay text-only and backward compatible either way.


---

## Part 3: Rollout milestones

Each milestone ships and can be verified on its own. The order is fixed: prerequisites, then schema, then API, notifications, frontend, load proof, pilot and GA.

### M0a — P0: close the self-registration account takeover

**Scope.** Change `registerEmployee` in hr-auth.service.ts so it never promotes or overwrites an existing row. An existing email or phone in any status, ONBOARDING included, gets the same 409 `ALREADY_EXISTS` that active rows get today. New sign-ups stay ACTIVE, per the owner decision of 2026-09-26. Bound `registerEmployeeSchema.name` before `safeString`. Recommended: correct the login-page copy that promises approval. Add regression tests.

**Why it is safe to ship alone.** It changes only the public register path and is independent of the pipeline. Login, submit and every other route are untouched. Pending hires are still activated through the existing admin flow.

**Verification.** API tests:
- registering with an existing admin-created ONBOARDING email returns 409, and the row, roles and password hash are byte-unchanged;
- a new registration is ACTIVE and can log in;
- a duplicate ACTIVE registration returns 409.

Run the full suite from apps/api. After deploy, a registration attempt with a pending hire's email is refused.

### M0b — HR client hardening (P1 + P5)

**Scope.** HR apiFetch: cap the 401 retry at one; add status and retryAfterSec to ApiError; classify refresh outcomes as ok, rejected or transient (the classifier lives in packages/shared/src/pipeline/refresh.ts); the rejected branch redirects to /login?next= and purges `pl:` keys. HrAuthProvider and the login page get a return path read from window.location with a /pipeline-only allowlist, and no useSearchParams.

**Why it is safe to ship alone.** Success paths are unchanged and the new ApiError fields are additive. The only behaviour changes are that a second consecutive 401 goes to login instead of looping, and that a transient refresh failure keeps the user signed in. No pipeline code is needed.

**Verification.** Vitest on the shared refresh classifier covers each branch: network throw, 502 HTML, 429 and 5xx keep the tokens; a JSON 401 clears them. Locally in Playwright: an expired token refreshes; an offline or 502 refresh does not sign the user out; a bad refresh lands on /login?next= and returns after login. tsc and full `npm run build` pass. Post-deploy HR login smoke test.

### M0c — Bell hardening (P3 + P4)

**Scope.** HR bell: fetch the list only while the panel is open (keepPreviousData); show a skeleton while loading and 'Couldn't load · Retry' on error; show 'No notifications yet' only for a loaded []; PIPELINE rows deep-link via metadata.path. Internal bell: PIPELINE rows skip the title heuristic; add an origin-checked metadata.url new-tab anchor (code-constant allowlist, stopPropagation); same loading, error and empty rules.

**Why it is safe to ship alone.** No PIPELINE rows exist yet, and every other row renders as before. The HR bell's request volume drops by half. This must be live before any PIPELINE row is ever written.

**Verification.** Full build. Playwright on both portals: skeleton on open, error state on a mocked 5xx, empty text only for a loaded []. A PIPELINE row seeded in a local DB navigates in HR and opens a new tab from internal. Request count per 15 min per HR tab drops from 60 to 30.

### M0d — Platform guards (P12 + P7 + P8 + P13 prep)

**Scope.** Set `cors({maxAge:600})`. Test infrastructure: generateHrToken, unique createTestUser emails, the PIPELINE_DB_CONNECTIONS env var. CI greps: lookbehind in src and in the built HR bundle, the prisma-import ban for services/pipeline, and a localeCompare-on-rank ban. Add a skeleton concurrency CI job with its own database, db:push, and a singleFork config.

**Why it is safe to ship alone.** CORS preflight caching is security-neutral and affects every portal only by reducing preflights. The rest touches CI and tests only.

**Verification.** Access-Control-Max-Age: 600 is present on prod OPTIONS responses. CI is green. Each grep fails on a violation planted in a throwaway branch. The concurrency job runs an empty suite green.

### M0e — Box and sandbox checks (P9 + P10), no deploy

**Scope.** Read-only checks on the box: `nginx -T` for limit_req, limit_conn, buffering and timeouts; fail2ban status, jails, bans and log source; SHOW max_connections; free RAM and API RSS; an evening baseline of 429/502 per 15 min, P2024 lines, pg_stat_activity peak and per-edge requests per second including OPTIONS. Remediation if needed: disable the nginx-limit-req jail or ignoreip Cloudflare's ranges, and size any applied limit_req burst. Never enable real_ip while the jail is live. Also a sandbox check of how Prisma 5.22 handles an unknown enum value.

**Why it is safe to ship alone.** The checks are read-only. Any remediation is a separately reviewed box change that only makes existing traffic safer.

**Verification.** Outputs recorded in .planning. Baseline numbers stored as the no-regression yardstick. If the jail was live, the remediation is confirmed with fail2ban-client status. The P10 result is written into the rollback runbook.

### M1 — Schema and DDL (PR-A)

**Scope.** Adds the pipeline_* models, the parentId index, the virtual User back-relations, NotificationType PIPELINE, NOTIFICATION_AUDIENCE.PIPELINE = [] and the TRUNCATE list entries. A feature-only DDL script is applied on prod before merge, following the DDL cycle, and seeds the board row and 7 phases.

**Why it is safe to ship alone.** The tables and the enum value are unused, and the deploy only regenerates the Prisma client. No existing table gets DDL, and the FK locks on users are bounded by a 3 s lock_timeout.

**Verification.** The widened DDL grep prints nothing. After applying on prod, check \d pipeline_*, 7 phases, the board row and the enum listing. The prod migrate diff (inspection only) shows just the known manual index. Merge happens in the same window. After deploy, the logs show no PrismaClientValidationError, 'does not exist' or P2024, and the canaries pass.

### M2 — API core, dark (PR-B1)

**Scope.** Adds the pipelineDb client and URL builder, the bulkhead, pipeline limiters with expired-token-safe keys, pipelineJson, classifyDbError and the error middleware, the G0/G gates with settings and access memos (a failed settings read returns 503), and the boot self-check. Routes 1–21 are in, with no notification writes. Also: the sync R1/A1 statements, snapshot cache, post-commit board bump with pending retry and boot bump, and the morgan skip.

**Why it is safe to ship alone.** With no pipeline.mode row the feature is off: bootstrap returns {enabled:false} and every other route returns 403. The pipeline has its own buckets and its own pool, so no other route's limits or connections change.

**Verification.** The full suite, including gates, cursors, idempotency, conflicts, error classification with raw statements, participant counters, bucket isolation and canaries, passes from apps/api at connection_limit=1. After deploy: bootstrap returns {enabled:false} for an HR token and 403 for a client token; login, HR submit, Link History and accounts canaries pass; logs are clean; the API RSS delta is recorded; pipeline connections are visible in pg_stat_activity and stay at most 3.

### M3 — Notifications and background jobs, dark (PR-B2)

**Scope.** Adds notify.ts with the plnId/plnIdSql helpers, the shared recipient predicate, grouped, mention, reply, added and moved rows, snippets and redaction. Also the ack primary-key clearing, the due cron (IST minutes, SKIP LOCKED, kind-scoped ids) and the wall-clock trim and purge jobs. Requires M0c to be live.

**Why it is safe to ship alone.** With mode off, no PIPELINE row is written. The jobs check the mode and schema and do nothing; the trim only ever touches PIPELINE rows, and none exist yet. The existing notification endpoints are unchanged.

**Verification.** Notification tests pass: recipients on every path, move merge, the due matrix including due-soon then overdue, redaction leaving no deleted text, snippets, the plnId parity test, and the key-set snapshot of /hr/notifications and /admin/notifications. The purge test with at least 5,000 messages keeps each chunk under 1 s. After deploy, the logs show the trim scheduled for the next 04:00 IST and the due cron doing nothing.

### M4 — HR frontend (PR-C)

**Scope.** Adds the /pipeline and /pipeline/[id] pages, PipelineProvider, the store, SyncEngine and user-scoped outbox, and PipelineHeader, which mounts the bell. Also PortalShell's opt-in fitViewport prop, the dnd-kit board with the phone drop tray and toasts, the thread and composer (visualViewport contract, positional mentions, tokenised drafts), error boundaries, the clientBuild constant, and a nav item gated on navVisible.

**Why it is safe to ship alone.** The nav stays hidden until mode is on. With the API off, the pages show 'Pipeline is paused' and re-check on their own. The other 25 HR layouts are unchanged because fitViewport is opt-in.

**Verification.** Full `npm run build` passes, as do the post-build bundle lookbehind grep and the lockfile entry for @dnd-kit, and the HR build stays within memory. Playwright at 390, 768 and 1280 against a local stack: no document or horizontal overflow, 16 px inputs, drag, drop tray and Move-to work, mention picker and same-name case, reply sheet back navigation, offline, 429, paused and deleted states, the two-users-one-browser case, and axe clean with zero console errors.

### M5 — Load and concurrency proof (no deploy)

**Scope.** Runs the load harness with Postgres, nginx+TLS and the API (via the tsx loader) in one 1-CPU cgroup, plus background CPU load, a synthetic cron workload, submits of up to 450 links, a mid-run next build, a restart herd and the triage burst. Runs the concurrency suite 20 times.

**Why it is safe to ship alone.** Local or lab only; nothing deploys.

**Verification.** Pass criteria: 0 × 429 and 0 × 5xx on non-pipeline routes; zero user-visible 429s in the triage burst; 0 P2024 or P2028 on the main pool; pipeline connections at most 3; sync p95 under 30 ms and post p95 under 100 ms; login, HR submit p95 and first-submit error rate within 10% of the pipeline-disabled baseline; event-loop p99 under 50 ms; pipelineDb RSS delta at most 100 MB (otherwise switch to the main-pool fallback and re-run); no duplicates after restart; the skip-freedom proof passes all 20 runs.

### M6 — Pilot

**Scope.** Run `scripts/pipeline-flag.ts --mode=pilot --add=<emails>` (dry run by default, then --apply --confirm-prod) for 5–10 named users, owner first, for at least 5 working days including evenings. Watch the hourly [pipeline] stats line.

**Why it is safe to ship alone.** A settings flip that takes effect within 15 s with no deploy. Only allowlisted users can open or be notified. mode=off reverts within 15 s. Requires M0b, M0c, M0d, the M0e remediation and M5 to pass.

**Verification.** Platform-wide P2024 stays at 0. Global 429 and 502 stay at or below the M0e baseline. HR submit p95 stays within 10% of baseline. Pipeline 503s are rare and silent. PIPELINE row growth matches the estimate. API RSS is stable. The real-iPhone checklist passes (including Desktop Site mode) and so does Android Chrome. A kill-switch drill (off, then pilot) shows 'paused' and then an automatic resume.

### M7 — General availability

**Scope.** Set pipeline.mode = 'on' after P0 (M0a) is live. The nav appears at once on a reload, and in an open tab at its first focus or page change at least 10 minutes after that tab's last bootstrap request (§12 step 9) — verify with a reload. Roll back with `--mode=off`, never `--mode=pilot` (see `scripts/pipeline-flag.ts`).

**Why it is safe to ship alone.** A settings flip; the kill switch and pollMs stretch remain available with no deploy.

**Verification.** The nav is visible to every active HR user. First-week monitoring shows the same criteria as the pilot at company scale. No PIPELINE row reaches a non-participant admin (spot-check SQL). The retention trim runs at 04:00 IST and the logs record the rows it deleted.

### M8 (optional, owner-gated) — Mobile deep link via OTA

**Scope.** A JS-only expo-updates change to notifications.tsx and admin-notifications.tsx: for type === 'PIPELINE' with an allowlisted metadata.url, a tap opens WebBrowser.openBrowserAsync(url); otherwise the row behaves exactly as today.

**Why it is safe to ship alone.** Deploys via EAS Update only (mobile/ is skipped by deploy.sh). Builds that never fetch the update keep the text-only behaviour, and the row shape and endpoints are unchanged.

**Verification.** Tested on an internal EAS channel on iOS and Android: tapping a PIPELINE row opens the project and the login return path works; other rows are unchanged; an old build with no update still renders every row.

---

## Part 4: Decision log and review log

### 4.1 Where the three drafts disagreed, and what was chosen

This list was recorded when the drafts were merged. The adversarial review later changed some of these choices. Where an entry is marked **superseded**, Part 2 is authoritative.

1. Cursors: split counters (a global pipeline_board_state.seq for card-level writes, taken LAST before commit, plus a per-project thread_rev and header_rev), chosen over Draft 3's single global seq and in-process write gate, so a busy thread never serialises org-wide writes. **Superseded in part:** the board counter is now bumped in its own statement *after* the writing transaction commits (Part 2 §5.1), not inside it.
2. Board sync: a version-gated full snapshot (Draft 1), not per-card deltas (Draft 2). Board changes are rare, one shared rebuild per change is cheap, and it needs no tombstones or purge horizons.
3. Notification fan-out: synchronous inside the write transaction (Drafts 1/3), not a transactional outbox (Draft 2). Recipients are capped at 200 and written with one INSERT…SELECT; an outbox adds a table, a worker and latency for no gain at this scale.
4. Fan-out form: a short interactive transaction of at most 9 bounded statements (about 5-10 ms hold), not Draft 1's single 60-line CTE. The locks are the same and it is far easier to test; the CTE stays as a measured optimisation. **Superseded:** the final design uses at most 4 statements per interactive transaction (Part 2 §6).
5. Grouped-row identity: a deterministic md5(...)::uuid primary key with ON CONFLICT DO UPDATE (Draft 1), not text-prefixed ids (Draft 3) or a participant pointer plus generation (Draft 2). It is race-safe, needs no new column on notifications, and is UUID-shaped in case any client ever validates ids (verified: no server-side uuid check today).
6. Hot-path serialisation: Prisma raw rows plus success()/res.json, not Postgres-built JSON string-splicing (Draft 1). Timestamps keep their 'Z', the envelope helper stays, and the cost is negligible.
7. Card ordering: fractional-index string ranks (the algorithm vendored into packages/shared, CC0) with the upper neighbour computed server-side as the next rank above 'a' under COLLATE "C", and no unique constraint. Integer gaps with multi-row renumbering (Draft 3) were rejected.
8. Move conflicts: return 409 only when the card's current phase is neither basePhaseId nor the target (Draft 3), rather than position_version CAS (Draft 1), so retries are idempotent and someone else reordering within a phase is not a conflict.
9. Field edits: per-field compare-and-set against base values, conflicting only when current ≠ base and current ≠ desired (Drafts 2/3), rather than one content_version (Draft 1), so edits to different fields never falsely conflict.
10. Reactions: a jsonb map on the message row (Draft 1), not a reactions table (Drafts 2/3). One-row reads and writes, no extra append-only table, bounded by users × 8.
11. Rate limits: 1-minute windows (read 90, write 60, messages 20 per user) so a 429 clears within 60 s, rather than 15-minute buckets. The global limiter skips pipeline paths using the same lowercase predicate. **Superseded:** the final limits are read 120, write 120 and messages 40 per user per minute (Part 2 §8.1).
12. Bulkhead: one pipeline bulkhead of 3 slots with write priority. Draft 1's 2 slots would leave its own crons contending, and Draft 3's separate read and write gates add a serialising write mutex. **Superseded in part:** the bulkhead now runs on a dedicated 3-connection pipeline pool, separate from the main pool of 10 (Part 2 §3.2).
13. Mentions: @{uuid} tokens in the body (Drafts 1/2), not offset ranges (Draft 3). Tokens survive edits and need no range validation.
14. Reply to a reply: normalise to the root (Draft 2) instead of returning 409 (Draft 1).
15. Project delete: soft delete, purge after 30 days, restorable by the owner or an admin (Drafts 2/3), not an immediate hard delete (Draft 1). Open access makes a mistaken delete likely enough that it should be recoverable.
16. Activity table (Draft 2) and phase-move lines in the thread (Draft 3) are rejected for v1. The header shows the last phase change; this is recorded as an open question.
17. Author's own read marker: advance it only when the author was already caught up (Draft 2), not with GREATEST (Draft 1), which would silently mark other people's unread messages as read.
18. Draft 3's zero-query idle fast path is rejected. The overlay costs about 2 ms per poll (about 2% of one connection at peak), and the fast path is wrong once there are external writers or more than one process.
19. Draft 3's active-reader suppression of grouped notifications is adopted, using pipeline_participants.seen_at refreshed by viewing syncs.
20. Phone board: Draft 3's phase-chip bar, one phase list at a time and drop-on-chip, not 85vw scroll-snap columns (Draft 1).
21. Live state: a small reducer store fed by the sync engine (Draft 3). SWR is kept only for request-once data, because SWR optimistic rollback would revert rows the poller had just merged.
22. NOTIFICATION_AUDIENCE entry for PIPELINE: [] (Draft 3), not ["RECIPIENT"], so a stray dispatchNotification call writes nothing.
23. Token allowlist: a code constant ['hr'] (Drafts 1/2), not a system_settings value (Draft 3). A security gate should only change through reviewed code, and phase 2 needs a frontend PR anyway.
24. Disabled state: bootstrap returns 200 {enabled:false} and every other route returns a terminal 403 PIPELINE_DISABLED (Drafts 1/2), not 503 (Draft 3), which would invite retry loops. **Superseded:** `PIPELINE_DISABLED` is no longer terminal. Clients re-check `bootstrap` every 3 minutes and resume on their own, and a failed settings read returns 503, not 403 (Part 2 §3.2 and §5.5).
25. Login deep link: `?next=` accepted only for paths under /pipeline (merged from Drafts 2/3), to keep the login-page change minimal.
26. Archived and deleted projects are views on /pipeline (?view=), not a third route, to respect the owner's two-route decision.
27. Phase-move merge: the 2-minute same-actor window plus a 10-minute hard cap (Draft 2); a net-zero move deletes the still-unread row.
28. Unfollow: sets notify=false and keeps the role (a member stays in My projects). A direct @mention still notifies but does not flip notify back; posting or replying re-follows. This is listed as an owner question.
29. Due-alert idempotency: marker columns on the project row (Draft 1), not a claim table (Draft 2).
30. Concurrency tests: a separate CI step with connection_limit=5 on its own database (Draft 2). The main suite's connection_limit=1 cannot show real interleaving. **Superseded:** the concurrency job uses `PIPELINE_DB_CONNECTIONS=3` on its own database (Part 2 §10, P8).
31. safeString fix: a strongly recommended independent PR, not a blocker. Pipeline titles are pre-bounded to 240 characters before the transform, and message bodies never run through safeString.
32. Ranking library: vendor the CC0 fractional-indexing algorithm (about 100 lines) rather than adding the ESM-only npm package, which packages/shared (TypeScript source consumed by tsx and Next) would have to import.

### 4.2 Adversarial review: 64 issues, all verified and fixed

Reviewer lenses: rate limits and database load; security and isolation; data integrity and deploy safety; phone UX and failure states. The fixes are already part of Part 2.

| # | Issue | Resolution |
|---|---|---|
| 1 | Pipeline takes 3 of the shared 10 connections (5 left, not the documented 8); crons are unbulkheaded; memo misses and error-path re-reads run outside the bulkhead. | Pipeline now has its own PrismaClient, `pipelineDb`, outside the main 10: connection_limit 3, pool_timeout 2 s, statement_timeout 2.5 s, lock_timeout 1 s. Every pipeline DB access uses it, including memo misses, error-path re-reads and background jobs. The main pool's ≥8-free rule is untouched. The load harness gates the RSS delta (≤100 MB); if it fails, the fallback runs the pipeline on the main pool with a 2-slot cap. |
| 2 | Interactive transactions hold row locks across JS hops, including the global pipeline_board_state lock, so any event-loop stall makes concurrent board writes hit lock_timeout. | /sync is now one autocommit read statement plus an optional autocommit ack. The board-seq bump is out of every transaction: it is a post-commit autocommit statement with an in-process pending retry and a bump at boot. The remaining interactive transactions lock only one project row and take ≤4 statements. Rejected: rewriting every write as a single data-modifying CTE. With the global lock gone it adds complexity for no gain, and it is unsafe for reads that must follow a lock wait under READ COMMITTED. |
| 3 | fail2ban's nginx-limit-req jail could firewall-ban a Cloudflare edge IP for an hour; preflights double nginx-counted requests; P12 was only recommended. | P9 now blocks the pilot. It checks fail2ban status, jails and current bans, runs `nginx -T` for limit_req/limit_conn, and records per-edge requests per second including OPTIONS. Remediation rules: disable the jail or ignoreip the Cloudflare ranges, and never apply real_ip while the jail is live. P12 (`cors maxAge 600`) is now REQUIRED before the pilot. |
| 4 | The load harness cannot reproduce prod contention: only the API is CPU-limited, crons are effectively off, the tsx loader is absent, and submits are 100 links. | The harness now runs Postgres, nginx+TLS and the API (via the prod tsx loader) in ONE 1-CPU cgroup. It adds 20–30% background CPU, a synthetic cron workload, submits of up to 450 links and a mid-run `next build`. Pass criteria now include the P2028 count and the HR first-submit error rate. |
| 5 | The reply self-FK (parent_id) has no index, so every purge chunk full-scans the table on each cascade trigger and times out. | `@@index([parentId])` added in PR-A. The purge deletes replies before roots, in chunks. A purge test with ≥5,000 messages asserts each chunk takes <1 s. |
| 6 | The '04:00 IST daily trim' had no scheduling mechanism; the repo precedent is boot-relative, so the trim would run after every deploy. | Trim and purge are scheduled by wall clock: the next 04:00 IST computed with istMinutesOfDay, run only inside 03:30–05:30 IST, guarded by a `pipeline.trimLastRunIST` marker, and never run at boot. |
| 7 | The ack's notifications UPDATE scans every unread row of the user every 10 s, even when nothing advanced (admins hold thousands of unread GENERAL rows). | Clearing is now a primary-key list: deterministic ids for grouped, added, moved (last 5 generations) and due rows, plus explicit seen mention/reply ids. It is issued only when the read marker advances, seen_at is stale, or seen ids are present. No scan and no new index. |
| 8 | A failed settings read fails closed to PIPELINE_DISABLED, which the client treats as terminal, so a transient DB blip shows a permanent 'paused'. | A failed settings read now returns 503 PIPELINE_BUSY, which the client retries silently. PIPELINE_DISABLED is returned only after a successful read shows off or no row. The client treats DISABLED as non-terminal: it re-checks bootstrap every ~3 min and resumes automatically. |
| 9 | Expired-token requests are keyed on the Cloudflare edge IP in the pipeline limiter, so they can get 429 before the 401 that would trigger a refresh. | The pipeline limiter keys any signature-valid token by user, verified with ignoreExpiration, so the request reaches `authenticate`, gets its 401 and triggers a refresh. Only unsigned or garbage tokens fall back to IP keying. |
| 10 | Legitimate bursts reach the 20/min message limit, and a 429 on send is bounced back to the composer as an error. | Limits are now read 120/min, write 120/min, messages 40/min. A 429 on any write is held in the outbox or op queue and replayed one at a time after retryAfterSec. Harness scenario: 30 messages plus 40 project opens in one minute must show zero user-visible 429s. |
| 11 | A transient refresh failure (network error, 5xx HTML, 429) wipes tokens and logs the user out of the whole HR portal. | P1 makes the refresh outcome three-way: ok, rejected, or transient. Only a JSON 400/401 from the refresh endpoint clears tokens; a transient outcome throws a retryable ApiError. The SyncEngine's online-event wake-up is delayed 2 s plus jitter. Mocked-fetch tests cover each branch. |
| 12 | Stale tabs run old SyncEngine code against a newer API; /sync has no protocol version and 4xx responses are undefined. | Every /sync carries `clientBuild`; below `pipeline.minClientBuild` the server returns `{reload:true}`. Any other unexpected 4xx on /sync gets a 60 s backoff plus at most one reload per 10 min, after the outbox flushes. /sync changes are additive-only, locked by a v1 fixture contract test. |
| 13 | Public HR self-registration creates ACTIVE users and promotes or overwrites admin-created ONBOARDING rows, so anyone on the internet gets open pipeline access, and pending hires can be taken over. | New prerequisite P0, a GA blocker that needs owner confirmation. Register creates ONBOARDING (as the UI already promises), never promotes or overwrites an existing row, and returns an opaque 201. The name is length-bounded before sanitising, names are truncated to 60 chars server-side, and there are regression tests. The pilot (explicit allowlist) may proceed before P0. The proposed EXISTS(user_roles) check was dropped: self-registered users already hold the Employee role, so it adds nothing. **Superseded** by the owner decision of 2026-09-26: registration stays instant, and P0 closes only the takeover path. |
| 14 | Member removal deletes the whole participant row (destroying other people's follow, mute and read state); the 10-minute undo can be triggered through a mention; an add overrides a mute; add/remove loops can spam. | Removing someone else demotes MEMBER→FOLLOWER and keeps notify and read state. The row is deleted only if the person never engaged. Only the user can change their own FOLLOWER row. The undo rule keys on member_added_by_id/at, which only the add route sets. An add never touches notify, and the 'added' row re-arms only after 24 h. |
| 15 | Deleted or edited message text survives in grouped, mention and reply rows for up to 90 days (mobile included); an archived project blocks author deletes; project deletion leaves snippets behind. | Grouped rows carry lastMid. A delete removes the mention/reply rows, read or unread, and rewrites grouped previews to 'X deleted a message'. An edit rewrites the snippets. Author deletes are allowed on archived projects. A soft delete removes grouped rows; the purge deletes the project's PIPELINE rows for every affected user. A test asserts no bell row contains the deleted text. |
| 16 | The outbox, drafts and SWR cache are not user-scoped, so on a shared browser a pending send can post as the next user and drafts leak between users. | Storage keys are `pl:v1:<userId>:…` and outbox items carry authorId (never replayed for another user). All `pl:` keys are purged on logout, on session expiry and on user switch. SWR keys include the userId, and PipelineProvider is keyed by user id. A Playwright test covers the two-user flow. |
| 17 | The due cron and the reply/added paths skip parts of the owner's recipient rule (pilot allowlist, ACTIVE, not-the-actor). | One shared SQL recipient predicate (ACTIVE, not deleted, not the actor, pilot allowlist) is applied to every notification INSERT; the due cron passes a NULL actor. Tests cover each path. |
| 18 | The owner can undo an admin's moderation archive or delete with restore/unarchive. | archived_by_admin / deleted_by_admin are set under the row lock when a non-owner admin acts; unarchive/restore then require a fresh DB admin check. Test: admin delete → owner restore 403 → admin restore 200. |
| 19 | The participants payload had no projection and could expose other people's seen_at, last_read_seq and notify. | Other participants are projected explicitly as {userId, role, isOwner, memberAddedById, createdAt}. notify, lastReadSeq and seenAt appear only in `me`. A contract test covers route 6 and sync. |
| 20 | Mapping `@Full Name` strings to ids mis-targets users who share a name, and silently turns plain text into mentions. | The composer tracks picks as positional ranges and serialises only those to @{id}. The directory adds a team hint when a name is duplicated, shown in the picker, chip tooltip and author labels. A same-name test checks only the picked user is notified. |
| 21 | Unicode bidi control characters survive in bodies, titles and names, so link text and names can be spoofed. | normalizeText, the title validator, directory names and notification text strip U+202A–202E, U+2066–2069, U+200E/200F and U+061C. Link text is rendered from the parsed URL (punycode host + path), and names use unicode-bidi:isolate. Unit test included. |
| 22 | Tests do not cover typeless client refresh tokens, message-only routes on deleted or archived projects, or ?around= across projects. | Tests added. PIPELINE_TOKEN_TYPES carries an allowlist-only comment. Message lookups join pipeline_projects with deleted_at IS NULL, and a cross-project ?around= returns 404. |
| 23 | Ownership is stored twice (owner_id and a participant row with role OWNER), and the two can diverge. | role ∈ {MEMBER, FOLLOWER} only; owner-ness is derived solely from owner_id. The owner always holds a MEMBER row; transfer upserts the new owner's row. Remove and Leave refuse when user_id = owner_id. Test included. |
| 24 | The error mapping keys on ORM codes, but most hot writes are raw SQL, whose errors arrive as P2010 or UnknownRequestError and become 500s. | classifyDbError derives the SQLSTATE from P2010 meta.code, from the ORM code map, and by scanning the message. 55P03, 57014, P2024 and P2028 map to 503. 40P01/40001 get one retry. 23505 branches on the constraint name. Raw-statement tests force each class. |
| 25 | Only member add maintains member_count, header_rev and the board; remove, leave, follow, auto-follow and owner transfer leave the counters stale. | There is now one participant-mutation path for all of these. It locks the project, runs the DML, recounts member_count, bumps header_rev, and bumps the board if the count or owner changed. A race test asserts member_count equals the real count. |
| 26 | Deleting a reply restamps two message rows (tombstone and root), which violates unique(project_id, rev) if thread_rev moves by 1; the 'never splits a group' claim is false. | Generic rule: an operation that restamps k message rows bumps thread_rev by k and assigns r-k+1…r, child first. It applies to reply send and reply delete. The §5.1 wording is corrected: pages may split a reply from its root. Test added. |
| 27 | due_soon and overdue alerts share one deterministic id formula, so the overdue alert is silently dropped by ON CONFLICT DO NOTHING. | The kind is part of every id (pln:<kind>:…). All ids go through one plnId/plnIdSql helper that always applies ::uuid::text, with a SQL-vs-TS parity test. A test checks due-soon then overdue for the same date gives two rows. |
| 28 | Deleted message text persists in notification rows of every recipient. | Handled by the same redaction mechanism as the other deleted-text finding: lastMid on grouped rows, read-or-unread deletion of direct rows, rewritten previews, and a per-user purge. |
| 29 | Duplicate ids in memberIds or userIds cause P2002 or SQLSTATE 21000 in multi-row upserts, and the creator listed as a member fails create. | Validators dedupe arrays; create strips the owner/creator from members; notify.ts dedupes every recipient array before a multi-row upsert. Tests cover both routes. |
| 30 | No DDL step exists for later PRs that change pipeline models; the safety grep misses CREATE INDEX on hot tables; a blanket prod db:push in the window could drop the new tables. | The DDL cycle is mandatory for any PR touching pipeline_* or NotificationType, including a prod migrate-diff inspection before merge. A boot self-check pauses the feature on missing schema instead of returning 500s. The grep is widened to hot tables. P14 is built CONCURRENTLY first and declared in a later PR. The DDL is applied and PR-A merged in the same window, with no prod db:push in between. |
| 31 | Rank rebalance reads without locks, so concurrent drags can lose reorders, mis-place moved cards and deadlock. | Rebalance locks the phase's live rows ORDER BY id FOR UPDATE, recomputes from that locked read, and re-checks phase_id in the UPDATE. Concurrency test seeds 63-char keys. |
| 32 | The queue pattern (`WHERE id IN (SELECT … LIMIT n)`) re-checks only id, so due alerts, trims and purges can act on rows that changed meanwhile. | The due cron and trim use FOR UPDATE SKIP LOCKED in the subquery and repeat every eligibility predicate in the outer WHERE. The purge locks and re-checks the project per chunk. Restore enforces the 30-day window in SQL. |
| 33 | How IST time of day is computed is unspecified, so on the UTC box the send and trim windows would shift by 5.5 h. | istMinutesOfDay() added to packages/shared. The due cron is gated on 570 ≤ m < 1200; the trim is scheduled from it. vi.setSystemTime tests cover the boundary minutes. |
| 34 | The board counter can go backwards (DB restore, missing row), so the cache and open tabs serve a stale board. | The cached snapshot is served only when cache.v equals board_v exactly. Clients adopt the server snapshot whenever v differs in either direction. Runbook: restart the API after any DB restore. Regression test added. |
| 35 | Ack clearing depends on the participant row being updated, so non-participants and removed root authors are never cleared, and the wording overstated when rows clear. | Clearing is a PK list independent of the participant update. Seen ids clear mention/reply rows for anyone. Removal demotes rather than deletes. The wording now states the 30 s bound. |
| 36 | The idempotency-key lookup runs after the state checks, so a retry after the project is archived or the root deleted gets 409/404 and the user later re-posts a duplicate. | The key lookup is the first decision after the lock (send) and before phase validation (create). The P2002 re-read compares project_id before replaying. Test: post, archive, retry → 200 replayed. |
| 37 | Snapshot truncation drops whole phases by uuid; unarchive can revive a card into an archived phase; clients may compare ranks with localeCompare; phase order has no tiebreak. | Ordering is (position, id), then rank COLLATE "C", then id. The cap is per phase (100) with per-phase totals. Unarchive/restore relocate to the first live phase and report phaseAdjusted. A phase can be archived only with zero referencing rows. A shared compareRank exists, and a CI grep bans localeCompare on ranks. |
| 38 | A global `prisma` call inside a pipeline transaction breaks the pool arithmetic and deadlocks at connection_limit=1; concurrency-suite files would run in parallel. | Pipeline code imports only pipelineDb (a CI grep bans the `@dashmani/db` prisma import in services/pipeline except db.ts). Callbacks receive only tx, and memos resolve before a slot is taken. The concurrency suite uses pool forks with singleFork, its own DB and its own db:push. |
| 39 | What happens when auto-follow would exceed the 200-participant cap is undefined, and a throw would block posting. | The cap applies only to explicit adds. Auto-follow past it is skipped and logged; the message still posts and the direct mention/reply row is still delivered. Test added. |
| 40 | The ack clears mention and reply rows for replies the user never saw, and the first page may not contain the read position. | Mention/reply rows clear only through explicit seen ids: viewport intersection, a bell click, ?m= or the ReplySheet. The project opens around the first unread message. The ack seq is the highest seq whose row intersected the viewport. |
| 41 | apiFetch's redirect drops ?next= and logs the user out on a transient refresh failure. | P1: three-way refresh; the redirect carries ?next= validated by the P5 allowlist; the same branch purges `pl:*` keys; mocked-fetch tests. |
| 42 | Expired-token pipeline requests are keyed on the edge IP and get 429 before 401. | Same resolution as the pipeline limiter keying: signature-valid tokens are keyed by user with ignoreExpiration. Test: 100 expired-token syncs from one IP return 401, never 429. |
| 43 | The outbox and drafts are unscoped and replayed on reopen, possibly days later, and retry forever on 404/409. | Keys are user-namespaced and purged on logout or user switch. Only entries <5 min old auto-replay; older ones show 'Unsent message from 14:02 · Send / Discard'. A 404/409 drops the entry and returns the text to a copyable composer. |
| 44 | A pending message cannot be matched to its server copy arriving via sync, so a slow or lost POST shows duplicates or a false 'Couldn't send'. | clientId is returned on the viewer's own messages in the POST, detail, history and sync responses. Pending ops resolve by (authorId = me, clientId) on every merge. 'Couldn't send' shows only once a sync completed after the attempt still lacks that clientId. |
| 45 | Send 409s have no defined outcome, a 429 on a write is treated as permanent, and a move that fails with 5xx is reported as failed although it may have committed. | Each send 409 code has a defined outcome. A 429 on any write is held and retried. A move 5xx leaves the card in place as 'Checking…' and settles via the idempotent retry or the next sync. An archived project shows a readOnly composer with Copy. |
| 46 | The page-height formula ignores the 66 px Topstrip, and the Topstrip is the only place the bell mounts. | Pipeline pages render their own PipelineHeader, which mounts NotificationBell, and omit Topstrip. PortalShell gains an opt-in fitViewport prop (default unchanged). Heights come from --pl-vh/--pl-top. Playwright asserts no document scroll. |
| 47 | The dvh height contradicts the visualViewport keyboard handling, and the fixed sheets and mention popover were not covered. | One useVisualViewport contract (--pl-vh, --pl-vvtop), listening to resize and scroll, is consumed by the page, every fixed sheet and the popover. The phone project page is a portalled full-screen surface. Real-iPhone checks included. |
| 48 | Drop-on-chip works only for chips already on screen, and after a cross-phase move the card vanishes from the only visible list with no feedback. | While dragging on a phone, a sticky, wrapping drop tray lists every phase. After a cross-phase move a persistent toast reads 'Moved to Review · View · Undo', focus moves to the next card, and an aria-live announcement fires. |
| 49 | A failed or stale directory load renders '@unknown', blank initials and empty pickers as if they were fact. | Loading and failed directory states are distinct from a genuinely absent user. 5xx is retried with capped backoff, and an unknown id triggers one throttled revalidate. Messages carry authorName and mentions[{id,name}] from the server-side directory memo. |
| 50 | The HR app has no React error boundary, and ChunkLoadErrors follow every deploy. | pipeline/error.tsx and global-error.tsx with their own copy and a Reload action; a ChunkLoadError reloads once (sessionStorage guard); the delta merge is wrapped with a fallback reload of that project's state. |
| 51 | Bells that fetch the list only while open flash, or keep, a false 'No notifications yet'. | P3/P4: a skeleton while loading, 'Couldn't load notifications · Retry' on error, and the empty text only for a loaded []; keepPreviousData. |
| 52 | Phone overflows: a URL-like card title, a long phase-name pill in the header, and an 8×44 px reaction row wider than 375 px. | min-w-0 text column with overflow-wrap:anywhere; the pill is min-w-0 max-w-[45%] truncate; the reaction palette is a portalled 4×2 grid. Fixtures use a 40-char phase name and a 60-char unbroken title. |
| 53 | The nested interactive card hides the ⋯ menu and grip from screen readers, and message actions cannot be reached by keyboard. | The card is an li/article with a stretched title button and ⋯/grip as siblings. Every message has an always-rendered, visible 'More actions' button. axe runs in Playwright. |
| 54 | The Enter-to-send rule is wrong for iPhones in Desktop Site mode and for Safari IME users. | Enter sends only when pointer:fine matches AND navigator.maxTouchPoints === 0, and never while isComposing or keyCode === 229. |
| 55 | Restored drafts lose their mentions, and undelivered mentions look delivered. | Drafts are stored tokenised. The POST returns notified[] and notNotified[{id, reason}]. Undelivered tokens render as grey text with a 'wasn't notified' note. |
| 56 | Notification snippets can contain raw @{uuid} tokens and split emoji or Devanagari clusters, permanently on installed mobile builds. | One notificationSnippet() renders tokens as names, collapses whitespace, strips bidi controls and truncates grapheme-safely with Intl.Segmenter. A test forbids '@{' and lone surrogates in any PIPELINE row. |
| 57 | Pipeline rows are dead ends on mobile although an OTA update is possible. | Added as an optional, owner-gated milestone after GA: tap opens an allowlisted metadata.url in the browser. The v1 baseline stays text-only and backward compatible, as decided. |
| 58 | An HR-origin allowlist supplied as a NEXT_PUBLIC env var would be wiped by deploy.sh, and the anchor sits inside a clickable row. | The allowlist is a code constant (https://hr.digitalsukoon.com and http://localhost:3002), and the anchor calls stopPropagation. |
| 59 | Clicking a notification for the project already open does nothing visible. | Highlight, around-load and ReplySheet are driven by an effect keyed on the current m and t. A missing or deleted target loads the latest page and shows 'That message is no longer available'. |
| 60 | Messages posted within ~45 s after a user leaves the tab never produce a bell entry. | On visibilitychange→hidden or pagehide, a keepalive POST /read {leaving:true} nulls seen_at. The 45 s window remains only as the bounded residual if that signal is lost. |
| 61 | The lookbehind CI guard scans source directories, not the shipped bundle (dnd-kit, vendored code). | P8 adds a post-build grep of apps/hr/.next/static/chunks. |
| 62 | Reading `next` with useSearchParams on static pages breaks `next build`. | P5 and HrAuthProvider read window.location instead; the /pipeline ?view= reader sits in a Suspense boundary whose fallback renders real content. |
| 63 | Several sub-surfaces can show an empty or current-looking state that is not true. | Empty copy is filter-aware; on wake the page shows 'Offline — updated 14:02' or 'Updating…'. Each sub-surface has its own skeleton, failed and empty states. First loads auto-retry at 10/20/40 s. Unsent text stays visible and copyable in terminal states. |
| 64 | content-visibility:auto collapses skipped rows and corrupts every scroll measurement in the thread. | content-visibility removed (the thread renders ≤~100 rows); the ack is based on IntersectionObserver. |
