# Dashmani Employee App (iOS / Android)

React Native (Expo) mobile app for the Dashmani HR portal — the full employee feature set from `hr.digitalsukoon.com`, talking to the production API at `https://api.digitalsukoon.com/v1`.

## Features

| Tab | What's in it |
|---|---|
| **Home** | Greeting + avatar, today's report status, monthly attendance, leave balance, upcoming holidays, unread-notifications badge |
| **Daily Report** | Submit/update daily links — smart paste (multi-link extraction), account assignment, notes, server-side draft auto-save (3s debounce), duplicate-skip explanation after submit |
| **Tasks** | Assigned tasks with status filter, task detail, status updates (Todo → In Progress → In Review → Done), comments |
| **Leave** | Balance cards (Casual/Sick/Earned/Unpaid), request history, apply for Leave / WFH / Comp-Off |
| **More** | Profile (view + edit contact info), Attendance detail, Salary slips (full earnings/deductions breakdown), Leaderboard, Team dashboard, Holidays, Expense claims, Extra hours, Incentives, Performance reviews, Notifications, Complaints, Bug reports, Change password |

Auth: password login (`POST /hr/auth/login`), tokens in **SecureStore**, automatic single-flight token refresh (mirrors the web portal's parallel-401 fix — refresh tokens are single-use).

## Run it (no Xcode needed)

```bash
cd mobile
npm install
npx expo start
```

Then install **Expo Go** from the App Store on your iPhone and scan the QR code (phone and Mac must be on the same Wi-Fi). For a different network use `npx expo start --tunnel`.

## Ship to TestFlight (no Mac needed — EAS cloud build)

One-time, from ANY machine with Node 20+:

```bash
git clone https://github.com/dmpl6454/dashmani-platform.git
cd dashmani-platform/mobile
npm install
npx eas-cli login        # your Expo account (free — sign up at expo.dev)
npx eas-cli build --platform ios --profile production
```

The build command will ask to log in with your **Apple Developer** account
once and then auto-manages certificates & provisioning profiles. The build
runs in Expo's cloud (~15 min).

When it finishes:

```bash
npx eas-cli submit --platform ios --latest
```

…uploads the build to **App Store Connect → TestFlight**. Install the
TestFlight app on your iPhone, add yourself as an internal tester, and the
Dashmani app installs like a real app (DM icon, splash, the works).

Ship updates later with the same two commands — `autoIncrement` bumps the
build number for you. For JS-only changes you can use `eas update` instead
(over-the-air, no review).

## Structure

```
src/
  lib/api.ts       — API client, token refresh, IST date helpers
  lib/auth.tsx     — AuthProvider (SecureStore session)
  lib/theme.ts     — brand palette (logo pink/orange, light+dark schemes, NO purple)
  components/ui.tsx — Card, Button, Field, Chips, StatusPill, useApi …
  app/             — expo-router screens (tabs + stack)
```

Notes:
- `mobile/` is deliberately **not** an npm workspace (kept out of `package.json` workspaces) so server deploys and `turbo build` are unaffected. Run `npm install` inside `mobile/` itself.
- Dates sent to the API use **IST** (`todayIST()`), matching the server convention.
- Point `API_URL` in `src/lib/api.ts` at `http://<your-mac-ip>:4000/v1` to develop against a local API.
