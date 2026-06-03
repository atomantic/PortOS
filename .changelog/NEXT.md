# Unreleased Changes

## Added

- **`/claim --issues`** — the claim workflow can now pull its work queue from GitHub issues instead of PLAN.md, auto-picking the oldest open issue filed by the repo owner and filing any major code-review findings as new issues. Developer tooling only — no app-facing change.

## Changed

## Fixed

- **[issue-717] No stray React warnings when you navigate away mid-action** — buttons that run an async task (save, generate, sync) no longer log an "update on an unmounted component" warning if you leave the page before the task finishes.

## Removed
