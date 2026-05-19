# Unreleased Changes

## Added

- **Per-stage editorial locks on Pipeline issues.** Each `issue.stages.{id}` now carries a `locked` flag; locked stages refuse regeneration (text generate, image / video enqueue, refine, extract-scenes / extract-pages, audio extract / render, episode-video fresh start, cover-concepts commit). UI exposes a lock toggle on every Pipeline Issue tab and renders a per-stage Lock indicator on the TabPills strip, so users can freeze a finalized comic script while still iterating storyboards.
- **Per-field arc locks on series.** `series.locked.arcFields` is an opt-in sub-map (`{ logline, summary, themes, protagonistArc, shape }`); locked fields are preserved verbatim through `commitSeasonsWithRemap` so arc regenerate + auto-resolve only rewrite the unlocked fields. Inline lock icons on the Arc Canvas read view toggle each field.

## Changed

- `/claim` slash command now hard-requires an isolated worktree with absolute paths, a single-Bash-invocation flow, and a `pwd` verification checkpoint — eliminates the failure mode where the claim branch was checked out in the main repo and blocked further parallel claims.
- Removed the CLAUDE.md "Worktrees" section that prohibited TUI worktrees; it conflicted with `/claim`'s explicit worktree requirement.

## Fixed

## Removed
