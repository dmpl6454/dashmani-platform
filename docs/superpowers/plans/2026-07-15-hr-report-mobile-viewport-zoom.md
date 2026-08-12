# HR `/report` Mobile Viewport Zoom/Shift Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the HR `/report` page from zooming-and-cutting the UI on certain mobile phones (Safari + Chrome/iOS) and from shifting the whole layout right during paste — including the case where "Request Desktop Site" is on and the bug persists.

**Architecture:** Live reproduction at 390px on production PROVED the page has ZERO CSS layout overflow (idle AND after paste with link cards rendered) — the existing `overflow-x:hidden` + `max-w-full min-w-0` + 16px-font-floor defenses all work. The bug is therefore NOT a layout-width bug; it is **iOS Safari visual-viewport behavior governed by an incomplete `<meta viewport>`**. The served meta is `width=device-width, initial-scale=1` with NO scale/interactive-widget controls. The fix hardens the viewport meta (the one iOS-specific knob left permissive) and adds targeted CSS defense-in-depth, then is VERIFIED ON A REAL iOS DEVICE (mandatory — Chromium/Playwright cannot emulate WebKit's focus-zoom/visual-viewport, so automated measurement alone cannot confirm the fix).

**Tech Stack:** Next.js App Router (`apps/hr`), the `viewport`/`metadata` exports in `layout.tsx`, Tailwind, `globals.css`.

---

## Evidence gathered (Phase 1 — DO NOT re-litigate; this is the proven baseline)

Reproduced live on `https://hr.digitalsukoon.com/report` at 390×844 via Playwright, logged in:

1. **Idle state:** `document.documentElement.scrollWidth === clientWidth (385)`, **0 elements** wider than viewport. No overflow.
2. **After Smart-Paste of 3 links → 3 link cards rendered:** STILL `scrollWidth === 385`, **0 offenders**. The metric grid, selects, URL inputs all fit. Layout defenses work.
3. **All 23 inputs/textareas/selects compute to `font-size: 16px`** (the iOS auto-zoom threshold is correctly met — the PR #83/#85 font-floor fix is intact).
4. **Served viewport meta:** `width=device-width, initial-scale=1` — **no `maximum-scale`, no `interactive-widget`, no `viewport-fit`.**
5. Only one `position:fixed` element (mobile topbar), correctly 385px wide, `left:0 right:385`.

**Conclusion:** The three symptoms (zoom+cut on focus; shift-right on paste; persists under Request-Desktop-Site) are unified by the viewport meta being incomplete for iOS:
- **Desktop-Site persistence:** iOS Safari in Desktop-Site mode IGNORES `width=device-width` and lays out at a fixed ~980px, downscaling to fit. With no scale lock, the page renders wide + pannable. This is *why toggling Desktop Site does not help* — the saving meta is the one that mode ignores.
- **Focus zoom + paste shift:** without `interactive-widget=resizes-content`, the on-screen keyboard/focus can pan the *visual* viewport (layout stays 385, so no measurable overflow) — pushing content right, appearing cut under the fixed topbar. Paste changes focus/scroll → triggers the pan.

**Confidence:** HIGH the viewport meta is the governing factor. The exact WebKit interaction cannot be 100% confirmed off real iOS hardware — hence the mandatory device-verification gate (Task 4). This plan hardens the highest-probability cause with layered, low-risk, reversible changes and verifies on-device before declaring done.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/hr/src/app/layout.tsx` | Root `viewport` export → the `<meta viewport>` iOS reads | **Modify** — harden the viewport descriptor |
| `apps/hr/src/app/globals.css` | Global overflow + font defenses | **Modify** — add `svh`/visual-viewport-safe defense + confirm 100% Display-Zoom resilience |
| (verification only) | Real-iOS device check | **Task 4** — no file |

**No `db:push`, no API change, frontend-only.** Applies to the HR portal only (the reported surface). The other portals are out of scope unless the same symptom is reported.

---

## Task 1: Harden the viewport meta (the root-cause fix)

**Files:**
- Modify: `apps/hr/src/app/layout.tsx` (the `viewport` export, ~line 5)

Next's `viewport` export renders the `<meta name="viewport">`. The current descriptor omits the iOS-critical fields. We add:
- `maximumScale: 1` + `userScalable: false` → **locks the scale**, so neither focus-zoom nor Desktop-Site's downscale can leave the page in a zoomed/panned state. (Trade-off: disables pinch-zoom. Acceptable and standard for a form-entry app where the zoom is the *bug*; the 16px font floor already prevents the accessibility problem that `user-scalable=no` historically caused.)
- `interactiveWidget: "resizes-content"` → tells iOS/Android to RESIZE the layout when the keyboard appears instead of panning the visual viewport — directly addresses the "shift right on focus/paste."
- `viewportFit: "cover"` → correct edge-to-edge behavior on notched devices (prevents a residual inset that can read as "cut").

- [ ] **Step 1: Read the current viewport export**

Run: `sed -n '1,13p' apps/hr/src/app/layout.tsx`
Expected: shows `export const viewport: Viewport = { width: "device-width", initialScale: 1 };`

- [ ] **Step 2: Replace the viewport export**

In `apps/hr/src/app/layout.tsx`, replace the `viewport` export with:

```typescript
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // ── iOS visual-viewport hardening (2026-07-15) ──────────────────────────────
  // ROOT CAUSE of the /report zoom+cut+shift bug: the old meta lacked scale + keyboard
  // controls, so on iOS Safari (a) focusing/pasting could PAN the visual viewport (shift
  // right, content cut under the fixed topbar), and (b) "Request Desktop Site" — which
  // ignores width=device-width and lays out at ~980px — had no scale lock to fall back
  // on, so the bug PERSISTED in Desktop-Site mode. Verified live: the page has ZERO CSS
  // layout overflow, so this is purely a viewport-scale/keyboard-behavior fix.
  maximumScale: 1, // lock scale — focus-zoom and Desktop-Site downscale can't strand the page zoomed
  userScalable: false, // no manual pinch-zoom; the 16px input font-floor already prevents the a11y regression
  interactiveWidget: "resizes-content", // keyboard RESIZES layout instead of panning the visual viewport (kills the shift-right)
  viewportFit: "cover", // correct notch/safe-area behavior (prevents a residual inset reading as "cut")
};
```

- [ ] **Step 3: Verify the served meta contains the new fields**

Run local dev (`npm run dev -w @dashmani/hr`), then:
Run: `curl -s http://localhost:3002/login | grep -oE '<meta name="viewport"[^>]*>'`
Expected: content includes `maximum-scale=1`, `user-scalable=no`, `interactive-widget=resizes-content`, `viewport-fit=cover`.

- [ ] **Step 4: Commit**

```bash
git add apps/hr/src/app/layout.tsx
git commit -m "fix(hr): harden /report viewport meta — lock scale + resize-on-keyboard (iOS zoom/shift bug)"
```

---

## Task 2: CSS defense-in-depth for the visual-viewport + safe-area

**Files:**
- Modify: `apps/hr/src/app/globals.css`

Even with the meta fixed, add layered protection so a residual pan/inset can't re-surface: use dynamic viewport units and honor safe-area insets. This is belt-and-suspenders — the meta is the fix; this ensures a future regression in one layer doesn't reopen the bug.

- [ ] **Step 1: Add safe-area + dynamic-viewport hardening after the existing overflow guard**

In `apps/hr/src/app/globals.css`, AFTER the existing `html, body { overflow-x: hidden; max-width: 100vw; }` block, add:

```css
/* iOS visual-viewport defense-in-depth (2026-07-15, pairs with the layout.tsx meta).
   Root cause was the viewport meta; these are layered guards so a residual pan/inset
   on notched iOS can't re-surface the "cut UI" symptom. */
html, body {
  /* honor the notch/safe-area so fixed elements (mobile topbar) never sit under a
     system inset that reads as "content cut off". viewport-fit=cover (set in the meta)
     enables env(safe-area-inset-*). */
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
}
/* The page root uses min-h-screen (100vh) in several places; on iOS the keyboard/URL bar
   make 100vh taller than the visible area → content can be pushed under the keyboard and
   the page pans. Prefer the small dynamic viewport height where supported. Non-iOS and
   older browsers fall back to 100vh unchanged. */
@supports (height: 100svh) {
  .min-h-screen { min-height: 100svh; }
}
```

- [ ] **Step 2: Verify no regression at desktop + mobile widths (local)**

With dev running, fetch the CSS and confirm it's valid + present:
Run: `curl -s http://localhost:3002/report 2>/dev/null | grep -oE 'safe-area-inset|100svh' | head` (or inspect the built CSS chunk)
Expected: the new rules are present; page still renders (no CSS parse error — the dev server would 500 the stylesheet otherwise; see the "unstyled HTML = stale .next cache" note in CLAUDE.md if the page looks unstyled — that's a cache artifact, not this change).

- [ ] **Step 3: Commit**

```bash
git add apps/hr/src/app/globals.css
git commit -m "fix(hr): safe-area + svh defense-in-depth for /report mobile viewport"
```

---

## Task 3: Automated regression check (Playwright, layout-overflow guard)

**Files:**
- Create: `apps/hr` has no e2e harness today; add a lightweight standalone Playwright check script under `scripts/` OR document a manual Playwright-MCP recipe. (Since the repo has no HR e2e setup, this task is a REPEATABLE MANUAL recipe, not a new test framework — YAGNI.)

⚠️ **Honest scope:** Playwright/Chromium CANNOT reproduce the iOS visual-viewport zoom (that's why Task 4 exists). This automated check only guards the thing we CAN measure — that no future change reintroduces a real CSS layout overflow (the class of bug PRs #83/#85 fixed). It is a regression tripwire, not a confirmation of the iOS fix.

- [ ] **Step 1: Document the overflow-regression recipe**

Add to the plan's verification notes / a `scripts/check-report-overflow.md` the exact Playwright-MCP steps used in Phase 1: resize 390×844 → log in → `/report` → paste 3 links → Add & Auto-Sort → assert `document.documentElement.scrollWidth <= clientWidth + 1` and `offenderCount === 0`. This is the exact measurement that proved the baseline; re-run it after any `/report` layout change.

- [ ] **Step 2: Run the recipe against the fix (local or prod)**

Expected: `overflowsBy: 0`, `offenderCount: 0` — same clean baseline as before (the meta/CSS changes must NOT introduce a layout overflow). If offenders appear, STOP — the CSS change regressed layout.

- [ ] **Step 3: Commit (docs only)**

```bash
git add scripts/check-report-overflow.md
git commit -m "docs(hr): repeatable overflow-regression check for /report"
```

---

## Task 4: MANDATORY real-iOS device verification (the actual confirmation)

**Files:** none — this is the gate that confirms the fix, because no emulator can.

⚠️ **This task is non-optional and non-automatable.** The entire root-cause analysis concluded the bug is WebKit visual-viewport behavior. Chromium/Playwright proved the layout is clean but CANNOT exercise iOS focus-zoom / Desktop-Site 980px layout / keyboard pan. Only a real iPhone confirms the fix.

- [ ] **Step 1: Deploy to prod** (merge to main → auto-deploy; `curl https://api.digitalsukoon.com/v1/health` sanity).

- [ ] **Step 2: On a real iPhone (Safari), reproduce the ORIGINAL bug is GONE**
  - Open `hr.digitalsukoon.com/report`, log in.
  - Tap a URL input → confirm the page does NOT zoom and does NOT pan/shift right.
  - Paste multiple links → Add & Auto-Sort → confirm the UI stays centered and fully visible (metric fields, Auto-Sort, per-link trash all reachable).
  - Tap a number metric field → confirm no zoom, no shift.

- [ ] **Step 3: Reproduce the Desktop-Site case specifically**
  - Safari → aA menu → **Request Desktop Website** → reload `/report`.
  - Confirm the page now renders mobile-appropriately (no tiny 980px-downscaled zoom, no horizontal pan). This is the symptom the user explicitly called out as previously unfixable.

- [ ] **Step 4: Repeat on iOS Chrome** (Chrome on iOS uses WebKit, so it shares the behavior; confirm parity).

- [ ] **Step 5: If ANY symptom remains** → STOP, do NOT layer more guesses. Return to systematic-debugging Phase 1 with the new device evidence (e.g. capture the actual `window.visualViewport.scale`/`.offsetLeft` on the device via a remote-debug session). The next hypothesis would be a device-specific Display-Zoom / Larger-Text accessibility setting, which needs a different fix (rem-based sizing). Do not attempt fix #2 without that evidence.

- [ ] **Step 6: Document the confirmed outcome** in `CLAUDE.md` (the HR `/report` mobile section) and a memory: what device(s) verified, that the viewport-meta hardening resolved it, and that `user-scalable=no` is intentional (paired with the 16px font floor).

---

## Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (HR `/report` mobile section)

- [ ] **Step 1: Append the root cause + fix**

Add to the HR `/report` notes: the 2026-07-15 finding that the zoom/shift/desktop-site bug was NOT a layout overflow (proven zero-overflow live) but an incomplete viewport meta; the fix added `maximumScale:1 + userScalable:false + interactiveWidget:"resizes-content" + viewportFit:"cover"`; ⚠️ do NOT remove `interactiveWidget` (reopens keyboard-pan) or re-add pinch-zoom without re-checking iOS focus-zoom; the 16px input font-floor MUST stay (it's what makes `user-scalable=no` safe).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: /report mobile zoom root cause was viewport meta, not layout overflow"
```

---

## Self-Review Notes

- **Root cause is evidence-based, not guessed:** live reproduction proved zero layout overflow idle AND post-paste, ruling out the "wide element" theories; isolated to the viewport meta (the one permissive iOS knob) which uniquely explains all three symptoms incl. Desktop-Site persistence.
- **The fix is layered + reversible:** viewport meta (primary) + CSS safe-area/svh (defense). Each is a small, independent, revertible change.
- **Honest confidence:** HIGH on cause, but the fix MUST be confirmed on real iOS (Task 4) because the failing layer is un-emulatable — the plan does not claim success from automated checks alone.
- **Scope discipline:** HR portal only; no backend; no `db:push`; kept SEPARATE from the DeepSeek migration plan.
- **`user-scalable=no` trade-off acknowledged:** disables pinch-zoom, justified for a form app where the zoom IS the bug, and safe because inputs are 16px (no a11y focus-zoom regression).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-hr-report-mobile-viewport-zoom.md`. Two execution options:

**1. Subagent-Driven** — fresh subagent per task, review between.
**2. Inline Execution** — execute here with checkpoints.

⚠️ Whichever is chosen, **Task 4 (real-iOS verification) cannot be delegated to a subagent or automated** — it requires you (or someone with an iPhone) to confirm on a physical device before the fix is declared done.

Which approach?