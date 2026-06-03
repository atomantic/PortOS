# Unreleased Changes

## Added

- **`/claim --issues`** — the claim workflow can now pull its work queue from GitHub issues instead of PLAN.md, auto-picking the oldest open issue filed by the repo owner and filing any major code-review findings as new issues. Developer tooling only — no app-facing change.

## Changed

- **[issue-720] Shared popover positioning** — the theme switcher and collection pickers now share one placement engine, so their pop-up menus stay anchored to their button and on-screen consistently. Internal maintenance change with no behavior difference.

## Fixed

- **[issue-717] No stray React warnings when you navigate away mid-action** — buttons that run an async task (save, generate, sync) no longer log an "update on an unmounted component" warning if you leave the page before the task finishes.
- **[issue-719] Steadier media galleries during live note/star sync** — incoming annotation broadcasts that match what a view already shows no longer trigger a needless re-render of the media cards.

## Removed
