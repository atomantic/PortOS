### Fixed

- Scheduled tasks defaulting to enabled for existing apps when new task types are added — `isTaskTypeEnabledForApp` now defaults to disabled (opt-in) instead of enabled (opt-out)
- Autonomous job scheduler using UTC instead of local timezone for scheduled times — daily briefing at 4:30 AM local was firing at 4:30 AM UTC. Now uses `nextLocalTime()` to compute exact UTC target from local scheduled time
- Codex agent output flooding UI with full prompt/config dump from stderr — filtered to only show tool execution lines and errors
- On-demand tasks silently dropped when pipeline preconditions fail (e.g., REVIEW.md already exists) — on-demand tasks now skip precondition checks since the user explicitly requested them
- Self-update failing with "exit code null" at npm-install step — PM2 watch restarted the server during `git checkout` (which changes `server/` files), breaking the stdout pipe to the update script. SIGPIPE killed the script before `|| true` could handle it, leaving the update incomplete. Added `trap '' PIPE` to ignore SIGPIPE so the script runs to completion.
- Improved update error messages to show signal name (e.g., "killed by SIGPIPE") instead of opaque "exit code null"

### Added

- Toggle to enable/disable all automations for an app on the Automation tab
