## Changed

- Code quality: extracted the duplicated cron-expression validation in `cosJobRoutes.js` (job create/update) into a single `validateCronExpression()` helper, and unified the two slightly-divergent error messages.
- Code quality: replaced inline `8000` / `8` / `4` / `20 * 1024 * 1024` literals in the image-generation routes with named constants (`MAX_PROMPT_LENGTH`, `MAX_LORAS`, `MAX_REFERENCE_IMAGES`, `MAX_IMAGE_UPLOAD_BYTES`); the `referenceImageN` upload field list now derives from `MAX_REFERENCE_IMAGES` so it can't drift.
- Code quality: replaced the local `safeReadJson` reimplementation in `apps.js` with the shared `readJSONFile` helper from `fileUtils.js`, and named the repeated `1500` ms inter-action throttle in `agentActionExecutor.js` as `INTER_ACTION_DELAY_MS`.
