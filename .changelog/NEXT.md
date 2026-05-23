# Unreleased Changes

## Added

- `/work <task>` Claude Code slash command (`.claude/commands/work.md`) — slugifies the task, spins up a fresh git worktree under `.claude/worktrees/<slug>/` branched off local `main` (NOT current HEAD), `cd`s into it, carries out the work without disturbing the originating checkout's uncommitted edits / branch / HEAD, and on completion always chains `/simplify` → `/do:review --with codex,gemini` → `/do:pr --review-with copilot` so codex + gemini findings are addressed locally *before* the PR opens (otherwise Copilot kicks in immediately on unreviewed code and burns review cycles). Branch / dir collision auto-suffixes with `-2`, `-3`, etc. `.claude/worktrees/` is already gitignored.
- **Fork-aware update flow.** The PortOS update tab now detects whether the local clone's `origin` remote points at upstream `atomantic/PortOS` or at a personal fork (`server/lib/gitRemote.js` parses SCP-style + HTTPS + ssh:// remote URLs, case-insensitive owner/repo match). When running from a fork the Update tab swaps the "Update Now" button for three explicit choices: **Sync Fork & Update** (runs `gh repo sync <owner>/<fork> --source atomantic/PortOS --branch main` then proceeds with the local update — fast-forward only, so it refuses to clobber divergent fork commits), **Sync Fork Only** (sync without applying), and **Update from Fork As-Is** (skip sync, pull from your fork's origin — useful if you already merged upstream into your fork via your own workflow). The server `/api/update/execute` endpoint now gates fork runs behind either a fresh `lastForkSync` record (≤10 min, same fullName) or an explicit `acknowledgeFork: true` to avoid the silent "I clicked Update and nothing happened" failure mode when a fork's main is behind upstream. The release-check still polls `atomantic/PortOS` so fork users continue to see upstream version notifications. `POST /api/update/sync-fork` exposes the gh-sync action; a 409 with `FORK_DIVERGED` is returned when the fork's main has commits not on upstream, with guidance pointing the user at PRs / feature branches / the explicit `--force` escape hatch they can run from a terminal. `update.sh` / `update.ps1` now log the active origin URL so users can confirm in the update log which repo they actually pulled from.

## Changed

## Fixed

- Providers (`/ai`) and Prompts (`/prompts`) pages now render the same Settings sub-nav tabbed header as the other settings pages, so users can hop between Backup / Database / General / MortalLoom / Prompts / Providers / Sharing / Telegram / Voice without going back to the sidebar. Extracted a shared `SettingsTabsHeader` component used by `Settings.jsx`, `AIProviders.jsx`, and `PromptManager.jsx`.

## Removed
