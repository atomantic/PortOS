# Unreleased Changes

## Added

- **Daily budgets for the Chief of Staff's domains** — each domain (Brain auto-classify, Memory auto-extract, CoS auto-run, Messages auto-send) can now carry a daily cap on how many automatic actions it takes and how many minutes of work it does. When a domain reaches its cap it pauses that automatic work for the rest of the day and resumes after the counters reset at midnight; the Chief of Staff config panel shows each domain's usage so far today. Caps are off by default (blank means unlimited), so nothing changes until you set one. This rounds out the per-domain guardrails alongside the off / dry-run / execute controls.
- **Scheduled "Claim Issue" task** — a new built-in CoS schedule (CoS → Schedule → Claim Issue) that runs the `/claim --issues` flow on a cadence: it picks the next open GitHub issue, creates its own `claim/issue-<num>` worktree, implements the fix, opens a PR that closes the issue, runs the configured reviewers, merges, and cleans up. Configurable per app via an **Issue Author Filter** — claim only issues filed by the repository owner (default) or any open issue regardless of author. Off by default; enable and pick a provider/model per app like the other improvement tasks.

## Changed

- Code quality: extracted the duplicated cron-expression validation in `cosJobRoutes.js` (job create/update) into a single `validateCronExpression()` helper, and unified the two slightly-divergent error messages.
- Code quality: replaced inline `8000` / `8` / `4` / `20 * 1024 * 1024` literals in the image-generation routes with named constants (`MAX_PROMPT_LENGTH`, `MAX_LORAS`, `MAX_REFERENCE_IMAGES`, `MAX_IMAGE_UPLOAD_BYTES`); the `referenceImageN` upload field list now derives from `MAX_REFERENCE_IMAGES` so it can't drift.
- Code quality: replaced the local `safeReadJson` reimplementation in `apps.js` with the shared `readJSONFile` helper from `fileUtils.js`, and named the repeated `1500` ms inter-action throttle in `agentActionExecutor.js` as `INTER_ACTION_DELAY_MS`.

## Fixed

- **[issue-978] Apps no longer get stuck reading "in review" after a no-op idle check** — when the Chief of Staff's idle review picked an app but had nothing to actually do (no claimable plan item, no new commits or PRs to watch), the app could stay marked as under review until a restart or cleanup pass cleared it. Idle checks that find no work now release the app right away while still spacing out how often it's rechecked.

- **[issue-984] Chief of Staff daily action cap holds firm when several jobs come due at once** — scheduled jobs that fired in the same instant could each slip past a small daily action cap before the others were counted, letting the cap be exceeded by one. The cap is now enforced the moment each job is admitted, so simultaneously-due jobs can no longer overshoot it.

- **[issue-968] A PM2 hiccup no longer makes running apps look offline** — when PortOS briefly can't read process state, affected apps now show "status unavailable" instead of being silently reported as stopped. The Apps list and detail pages replace the (misleading) Start button with a refresh-to-retry control, the dashboard counts these separately, the system health page flags the degraded read, and CyberCity no longer rains on apps whose status simply couldn't be read.
