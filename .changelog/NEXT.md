# Unreleased Changes

## Added

- **Daily budgets for the Chief of Staff's domains** — each domain (Brain auto-classify, Memory auto-extract, CoS auto-run, Messages auto-send) can now carry a daily cap on how many automatic actions it takes and how many minutes of work it does. When a domain reaches its cap it pauses that automatic work for the rest of the day and resumes after the counters reset at midnight; the Chief of Staff config panel shows each domain's usage so far today. Caps are off by default (blank means unlimited), so nothing changes until you set one. This rounds out the per-domain guardrails alongside the off / dry-run / execute controls.

## Changed

- Code quality: extracted the duplicated cron-expression validation in `cosJobRoutes.js` (job create/update) into a single `validateCronExpression()` helper, and unified the two slightly-divergent error messages.
- Code quality: replaced inline `8000` / `8` / `4` / `20 * 1024 * 1024` literals in the image-generation routes with named constants (`MAX_PROMPT_LENGTH`, `MAX_LORAS`, `MAX_REFERENCE_IMAGES`, `MAX_IMAGE_UPLOAD_BYTES`); the `referenceImageN` upload field list now derives from `MAX_REFERENCE_IMAGES` so it can't drift.
- Code quality: replaced the local `safeReadJson` reimplementation in `apps.js` with the shared `readJSONFile` helper from `fileUtils.js`, and named the repeated `1500` ms inter-action throttle in `agentActionExecutor.js` as `INTER_ACTION_DELAY_MS`.

## Fixed

- **[issue-968] A PM2 hiccup no longer makes running apps look offline** — when PortOS briefly can't read process state, affected apps now show "status unavailable" instead of being silently reported as stopped. The Apps list and detail pages replace the (misleading) Start button with a refresh-to-retry control, the dashboard counts these separately, the system health page flags the degraded read, and CyberCity no longer rains on apps whose status simply couldn't be read.
