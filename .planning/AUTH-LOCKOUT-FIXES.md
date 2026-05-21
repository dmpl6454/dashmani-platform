# Auth Lockout Prevention — Fix Register

**Created:** 2026-05-18
**Updated:** 2026-05-21 — HR portal regression closed (commit `d82d0f3`); backfill run on prod, 2 collisions remain (see bottom).
**Status:** ✅ Implemented in code. ✅ Backfill run on prod 2026-05-21. ⚠️ 2 collision pairs need manual resolution.

## Context

Reports of users who were "showing as registered but unable to sign in" — most
recently on the HR portal. End-to-end audit revealed **five independent
lockout traps**. This doc captures each trap, the fix, and how we prove it
won't happen again.

## The five lockout traps

### 1. Email case-sensitivity (all three portals)

`User.email`, `Client.email`, `AdminInvite.email`, `ClientInvite.email` are
all Postgres `String @unique`. Postgres unique constraints are
case-**sensitive**. A user who registered as `Foo@x.com` and later tries
`foo@x.com` gets `INVALID_CREDENTIALS` from a silent `findUnique` miss — no
"account exists" signal, no recovery hint.

**Fix:** introduced `normalizedEmail` Zod transformer in
[packages/shared/src/utils/sanitize.ts](packages/shared/src/utils/sanitize.ts)
that `.trim().toLowerCase()` before validating. Applied to every auth
validator (`loginSchema`, `clientLoginSchema`, `registerEmployeeSchema`,
`createEmployeeSchema`, `createClientSchema`, `createInviteSchema`). Also
applied defensively at every service entry point that doesn't go through
Zod (`auth.service.login`, `auth.service.forgotPassword`,
`hr-auth.service.{loginWithPassword,requestOtp,verifyOtp,registerEmployee}`,
`client-auth.service.{clientLogin,clientForgotPassword,createInvite,
createClient}`, `employee.service.createEmployee`, admin
`/admin/users/create` and `/admin/users/invite` routes).

For HR's `identifier` field (which accepts email OR phone), `normalizeIdentifier()`
lowercases only if the value contains `@`.

**Important supplement (2026-05-21):** normalizing the *input* is not enough by
itself — the **DB query** must also be case-insensitive, because pre-existing
rows may still hold mixed-case emails until the backfill runs (and even after,
new rows from any non-validated code path could re-introduce them). All three
auth services now query with Prisma `mode: "insensitive"` on the email branch:

```ts
// Internal: auth.service.ts (login, forgotPassword)
where: { email: { equals: normalizedEmailValue, mode: "insensitive" }, deletedAt: null }

// HR: hr-auth.service.ts (loginWithPassword, requestOtp, verifyOtp)
where: {
  deletedAt: null,
  OR: isEmail
    ? [{ email: { equals: normalized, mode: "insensitive" } }]
    : [{ phone: normalized }],
}

// Client: client-auth.service.ts — same pattern
```

This caught Diksha's HR-portal regression on 2026-05-21: she was stored as
`Diksha@digitalsukoon.com` (capital D), the form lowercased her input to
`diksha@…`, and `hr-auth.service.ts` was still doing an exact `{ email: normalized }`
match — silent miss → `INVALID_CREDENTIALS`. Fix landed in commit `d82d0f3`.

### 2. Pre-existing mixed-case rows in prod DB

Even after fixing #1, rows written before the fix still contain mixed-case
emails. Login would still fail for those users.

**Fix:** [packages/db/prisma/normalize-emails.ts](packages/db/prisma/normalize-emails.ts) —
one-time backfill. Lowercases every email in `users`, `clients`,
`admin_invites`, `client_invites`. Detects collisions (two rows that
normalize to the same email) and reports them without writing — admin
resolves by hand. Safe to re-run.

Run on prod after deploy:
```bash
ssh linode
cd /opt/dashmani-platform/packages/db
npx tsx prisma/normalize-emails.ts
```

### 3. HR self-register vs admin-invite collision

HR portal lets employees self-register at `POST /v1/hr/auth/register` —
which creates a `User` row with `status: "ONBOARDING"`. If an admin then
tries to invite that same email via `POST /v1/admin/users/invite`, the
endpoint returns 409 CONFLICT and the user is stuck:

- They can't log in (status is `ONBOARDING`).
- Admin can't invite them (409).
- Admin *can* approve them via `/admin/users/pending` — but only if the
  admin knows to check that screen, which is hidden behind a dashboard tile
  that only renders when count > 0.

**Fix:** [apps/api/src/routes/admin-features.routes.ts](apps/api/src/routes/admin-features.routes.ts)
`POST /v1/admin/users/invite` — if the email collides with an existing
`ONBOARDING` row, the endpoint now **promotes that existing row to ACTIVE**
with the requested roles/designation, and returns
`approvedExistingUserId`. The "invite" intent maps cleanly to "approve"
when the user is already there. No more 409 dead-end.

### 4. Soft-deleted user blocks re-invitation

If a user is soft-deleted (`deletedAt` set), their unique `email` still
occupies the constraint. Admin cannot invite a new account at that email
and gets 409 with no actionable error.

**Status:** documented but NOT yet code-fixed. Workaround for now: if this
occurs, manually `UPDATE users SET email = email || '.deleted-' ||
EXTRACT(EPOCH FROM deleted_at)::int WHERE deleted_at IS NOT NULL;` on prod
to free the email. Future improvement: bake this rename into the soft-delete
service so the email is freed automatically. Tracked as TODO.

### 5. Forgot-password ineffective for ONBOARDING users

Before this round of fixes, `POST /v1/auth/forgot-password` would happily
issue a reset link to any registered user — including ONBOARDING ones.
The user would reset their password, still get `403 PENDING_APPROVAL` on
login, and assume the system was broken. The reset succeeded; the lockout
remained.

**Fix:** [apps/api/src/services/auth.service.ts](apps/api/src/services/auth.service.ts)
`forgotPassword` now checks `user.status` first. For non-ACTIVE accounts,
it sends an *explanation* email ("your account is awaiting admin
approval — a password reset won't help") instead of a reset link. The
response is still the same opaque "if-exists" envelope so we don't leak
account existence to attackers.

## Verification matrix

| Portal | Path | Was the bug present? | Fixed? |
|---|---|---|---|
| Internal | `/login` (email + password) | Case sensitivity | ✅ #1 + #2 |
| Internal | `/login` forgot-password modal | ONBOARDING user got useless reset link | ✅ #5 |
| Internal | `/admin-signup?token=` | Invite normalize, case sensitivity | ✅ #1 |
| Internal | `/employees/pending` | ONBOARDING approval flow | Already worked, surfaced by #3 |
| HR | `/login` (sign in) | Case sensitivity, ONBOARDING lockout | ✅ #1 + #3 + #5 |
| HR | `/login` (create account) | Allowed; created ONBOARDING; admin couldn't re-invite | ✅ #3 |
| HR | `/login` forgot-password modal | Newly wired; defends against #1 + #5 |
| HR | `/reset-password?token=` | Newly added |
| Client | `/login` (email + password) | Case sensitivity | ✅ #1 + #2 |
| Client | `/login` forgot-password modal | Newly wired |
| Client | `/reset-password?token=` | Newly added |
| Client | `/signup?token=` (invite accept) | Invite email already normalized at issue time | ✅ #1 |

## What CANNOT happen anymore (provable)

- **"Registered but the system says wrong password"** when the user typed
  the right password with different case → fixed by #1 + #2.
- **"Self-registered HR employee, admin can't invite or activate them"**
  → fixed by #3 (invite endpoint promotes the row to ACTIVE).
- **"Reset password emailed, link worked, still can't log in"** for
  ONBOARDING users → fixed by #5 (explanation email sent instead).

## What still requires admin awareness

- ONBOARDING users still need an admin to approve them at
  `/employees/pending`. The dashboard surfaces a tile when count > 0.
  Admin in-portal notifications fire on every self-registration via
  `notifyAdmins()` in `notification.service.ts`. **If SMTP is misconfigured
  on prod, admins still get the in-portal notification — they just don't
  get an email.** Confirm `SMTP_PASS` in `apps/api/.env` if you expect emails.

## Deploy steps for this fix

1. `git push origin main` → CI deploys in ~3 min as usual.
2. `ssh linode && cd /opt/dashmani-platform/packages/db && npx tsx prisma/normalize-emails.ts`
   — backfills existing mixed-case emails. Idempotent.
3. Verify in prod logs that the script reported `collisions=0` for all four
   tables. If any collisions report, resolve by hand (decide which row to
   keep, delete the other).
4. Spot-check: try logging in to each portal with a known account using
   intentionally mixed-case email — should succeed.

## Files touched

- `packages/shared/src/utils/sanitize.ts` — `normalizedEmail` schema added.
- `packages/shared/src/validators/{auth,hr,client,employee}.ts` — adopt `normalizedEmail`.
- `packages/db/prisma/normalize-emails.ts` — NEW one-time backfill.
- `apps/api/src/services/auth.service.ts` — normalize in `login` + `forgotPassword`; pending-status branch.
- `apps/api/src/services/hr-auth.service.ts` — `normalizeIdentifier` helper; applied to all five auth fns.
- `apps/api/src/services/client-auth.service.ts` — normalize in all five auth fns.
- `apps/api/src/services/employee.service.ts` — normalize in `createEmployee`.
- `apps/api/src/routes/admin-features.routes.ts` — normalize + auto-promote `ONBOARDING` row on invite.

## 2026-05-21 prod backfill result

After `d82d0f3` deployed, ran `npx tsx prisma/normalize-emails.ts` on Linode:

```
[users] normalized=4, already_ok=77, collisions=2
[clients] normalized=0, already_ok=3, collisions=0
[admin_invites] normalized=0, already_ok=0, collisions=0
[client_invites] normalized=0, already_ok=0, collisions=0
```

4 user rows were silently lowercased (now safe). 2 collision pairs remain — these are
real duplicate accounts where both the lowercase and uppercase versions exist as
separate rows. The case-insensitive DB query means **both users CAN now log in**, but
the duplicate rows should be cleaned up:

| Pair | Keep (used) | Archive (empty/typo) |
|---|---|---|
| Priyanshu | `0be2dec3-94cd-4731-b04c-66d9aff9c7c1` — `PRIYANSHU@DIGITALSUKOON.COM`, name "Priyanshu Sinha", has attendance + 4 refresh tokens, created 2026-04-06 | `989aaac8-1fc1-459d-8154-d894445b4f43` — `priyanshu@digitalsukoon.com`, name "Piryanshu" (typo), 0 reports, 0 attendance, created 2026-04-05 |
| Prashant Shukla | `40d99c27-d3eb-4d65-b039-c282e3e80958` — `prashantshukla9242@gmail.com` (lower), ACTIVE, 1 daily report, created 2026-05-20 | `36ffee7b-98a5-4641-8bef-46720256745d` — `PRASHANTSHUKLA9242@GMAIL.COM` (upper), already soft-deleted 2026-05-21 |

Recommended resolution (next session):

```sql
-- For Priyanshu: rename the empty/typo row to free the lowercase slot, then re-run backfill.
UPDATE users SET email = email || '.archived' WHERE id = '989aaac8-1fc1-459d-8154-d894445b4f43';

-- For Prashant: the upper-case row is already soft-deleted but its email is still occupying
-- the unique. Free it the same way (mentioned in trap #4 above).
UPDATE users SET email = email || '.deleted-' || EXTRACT(EPOCH FROM deleted_at)::int
  WHERE id = '36ffee7b-98a5-4641-8bef-46720256745d';

-- Re-run: cd /opt/dashmani-platform/packages/db && npx tsx prisma/normalize-emails.ts
-- Expected: collisions=0
```

Do NOT run those SQL statements without explicit user approval — they alter live user data.
