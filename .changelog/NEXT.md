# Unreleased Changes

## Fixed

- [issue-2669] Sharing, Messages, and Calendar screens no longer show two stacked error toasts when a share/subscribe/export/save/sync action fails — the custom-catch callers now pass `{ silent: true }` so only their own toast fires, not the shared `request()` helper's default one too. Swept the Messages/calendar/sharing feature area (both ConfigTabs, InboxTab, ReviewTab, ShareToButton, and the Sharing page) and threaded a backward-compatible `options` arg into the affected API wrappers (`evaluateMessages`, `enableGmailApi`, `getGoogleAuthUrl`, `create/updateMessageAccount`, `create/updateCalendarAccount`, `updateSubcalendars`, `saveGoogleAuthCredentials`, `start/runGoogleAutoConfig`, `confirmDailyReviewEvent`).
- Creative Director projects that use the Antigravity provider no longer get stuck on "Planning." The agent now reliably receives its instructions instead of launching and sitting idle at an empty prompt (it waits for Antigravity's input box to be ready before sending, the same way the Claude provider does), so planning actually runs to completion.
- A Creative Director project no longer wedges in "Planning" when its agent is interrupted or crashes mid-run. The stuck run is now cleaned up as soon as the dead agent is detected, so the project can retry on its own instead of waiting for the next server restart.
- The Creative Director "Runs" tab now shows why a run failed (e.g. "interrupted by restart") instead of leaving failed runs blank with no explanation.

## Character Sheet

- `[issue-2673]` **Your Character level is now your age.** The Character's level is reframed as life experience — `level = floor(age in years)`, derived on read from your canonical birth date instead of being ground out of XP thresholds (JIRA tickets + CoS tasks). XP survives as a cumulative stat but no longer drives level, and the CyberCity HUD badge now shows the age-based level with a progress bar toward your next birthday (a friendly "set birth date" prompt when no birth date is set yet). Existing character records keep loading unchanged, and the derived level is excluded from cross-machine sync so peers never fight over a stale value.
