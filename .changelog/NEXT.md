### Fixed

- Scheduled tasks defaulting to enabled for existing apps when new task types are added — `isTaskTypeEnabledForApp` now defaults to disabled (opt-in) instead of enabled (opt-out)
- Autonomous job scheduler using UTC instead of local timezone for scheduled times — daily briefing at 4:30 AM local was firing at 4:30 AM UTC. Now uses `nextLocalTime()` to compute exact UTC target from local scheduled time
- Codex agent output flooding UI with full prompt/config dump from stderr — filtered to only show tool execution lines and errors
- On-demand tasks silently dropped when pipeline preconditions fail (e.g., REVIEW.md already exists) — on-demand tasks now skip precondition checks since the user explicitly requested them
- Pipeline stage 2+ tasks stuck in queue forever — follow-up tasks were missing `id` and `status: 'pending'` fields when created with `raw: true`, making them invisible to the task evaluator
- Pipeline tasks not marked completed after agent finishes — `app-improve-*` task IDs were misidentified as user tasks (expected `sys-` prefix), causing `updateTask` to look in the wrong file
- Pipeline stage 2 tasks blocked by app cooldown — pipeline continuations now bypass the 30-minute app review cooldown
- Pipeline artifacts (e.g., REVIEW.md) not cleaned up after final stage — automated cleanup now deletes `fileNotExists` precondition files when pipeline completes
- Self-update failing with "exit code null" at npm-install step — PM2 watch restarted the server during `git checkout` (which changes `server/` files), breaking the stdout pipe to the update script. SIGPIPE killed the script before `|| true` could handle it, leaving the update incomplete. Added `trap '' PIPE` to ignore SIGPIPE so the script runs to completion.
- Improved update error messages to show signal name (e.g., "killed by SIGPIPE") instead of opaque "exit code null"
- Setup falsely reporting "Setup Complete!" when native PostgreSQL is selected but not installed — now auto-runs `db.sh setup-native` to install and configure PostgreSQL via Homebrew, and exits with error if setup fails instead of silently continuing

### Added

- Toggle to enable/disable all automations for an app on the Automation tab
- "Process Now" button on pending task cards to force-spawn a specific task, bypassing cooldowns and evaluation intervals
