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

## Ship a real build

- **iOS Simulator / device build**: requires Xcode — `npx expo run:ios`
- **App Store / TestFlight without a local Xcode**: `npx eas build --platform ios` (EAS cloud build; needs an Expo account + Apple Developer account)

## Structure

```
src/
  lib/api.ts       — API client, token refresh, IST date helpers
  lib/auth.tsx     — AuthProvider (SecureStore session)
  lib/theme.ts     — brand colors (yellow #F5D547 / purple #5B4BF5 / ink)
  components/ui.tsx — Card, Button, Field, Chips, StatusPill, useApi …
  app/             — expo-router screens (tabs + stack)
```

Notes:
- `mobile/` is deliberately **not** an npm workspace (kept out of `package.json` workspaces) so server deploys and `turbo build` are unaffected. Run `npm install` inside `mobile/` itself.
- Dates sent to the API use **IST** (`todayIST()`), matching the server convention.
- Point `API_URL` in `src/lib/api.ts` at `http://<your-mac-ip>:4000/v1` to develop against a local API.
