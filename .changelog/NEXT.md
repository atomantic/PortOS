# Unreleased Changes

## Added

- PR reviewer now scans for malicious content (prompt injection, data exfiltration, supply chain attacks) and verifies GOALS.md alignment before approving
- PR reviewer verifies CI/CD passes and auto-merges clean PRs with squash + branch cleanup
- Global Pause toggle with info tooltip on task schedule UI — replaces ambiguous "Enabled" toggle
- Shared `loadSlashdoFile` utility in fileUtils.js for loading slashdo commands with `!cat` include resolution
- Multi-stage task pipeline system — chain sequential agent stages where each stage gates the next
- PR reviewer now runs as a 2-stage pipeline: security scan (read-only) → code review + merge
- Pipeline stage badge on agent cards showing current stage progress
- `getStagePrompt()` export in taskSchedule for resolving pipeline stage-specific prompts
- Pipeline UI: collapsed row shows purple "2-stage" badge, expanded view shows stage flow visualization
- Pipeline UI: tabbed prompt viewer shows each stage's full prompt with stage name tabs
- Code reviewer pipeline tasks (`code-reviewer-a`, `code-reviewer-b`) — 2-stage pipeline where stage 1 reviews the codebase and writes REVIEW.md, stage 2 triages and implements recommendations
- Per-stage provider/model support for multi-stage pipelines — each stage can use a different AI provider (e.g., Gemini reviews, Claude Opus implements)
- REVIEW.md and REJECTED.md added to allowed app documents
- MortalLoom export now includes goals, reads actual custom drink/nicotine presets, and parallelizes all I/O
- MeatSpace Settings tab with import/export functionality
- Browser download support via CDP `Browser.setDownloadBehavior` — downloads now land in `data/browser-downloads/`
- Downloads section on Browser page showing file list with size and date
- `/api/browser/downloads` endpoint for listing downloaded files
- Genome markers: summary dashboard with tappable status filter pills, "Attention Needed" section surfacing concerns first, category quick-jump dropdown, categories collapsed by default for mobile
- Genome markers: friendlier card UX with "What this means for you" framing, status-colored backgrounds, and renamed labels (Details, Your Notes, Learn More)
- Voice capture for Brain — microphone button on inbox uses Web Speech API to transcribe speech into thoughts
- Legacy Portrait export format — comprehensive human-readable Markdown document consolidating identity docs, traits, chronotype, taste profile, genome, longevity, goals, autobiography, and social presence
- Autobiography prompt chains — LLM-generated follow-up questions after saving a story, enabling deeper exploration of life themes with linked story chains
- RSS/Atom feed ingestion — subscribe to feeds, fetch/parse articles, read/mark-read from Brain > Feeds tab

## Changed

- MeatSpace Import tab renamed to Settings — consolidates import and export in one place
- Pipeline stages now display per-stage provider/model in Schedule tab UI
- Fixed `metadata.provider` field mapping so scheduled task provider overrides are correctly passed to the agent spawner
- PR reviewer prompt no longer requires global `slash-do` install — review checklist is inlined from bundled submodule
- Removed duplicate pr-reviewer skill template from data.sample (single source of truth in taskSchedule.js)

## Fixed

- Digital twin sync now uses deep union merge for longevity/chronotype files, preserving genomic marker data across instances
- Character avatar image now synced between instances alongside character metadata
- Snapshot sync status no longer shows false "behind" when remote doesn't report checksums
- Agent worktree branches now cleaned up even when worktree directory is already gone (fixes lingering branches after server restarts)
- Instance names like "null", "void", "NaN", "undefined" are now accepted as valid hostnames
- Peer renames no longer revert when remote peer re-announces (handleAnnounce now preserves user-set names)
- Self instance card now shows sync status for all categories (Goals, Character, Digital Twin, Meatspace), not just Brain and Memory
- CoS task evaluation now blocks tasks that exceeded max spawn limit before reaching spawn logic
- Metadata count fields (totalSpawnCount, failureCount, orphanRetryCount) use Number() coercion to prevent string comparison bugs
- jira-status-report task now runs in PortOS context (not the app's directory) and uses the correct PortOS API endpoint
- jira-status-report agents no longer attempt to commit, push, or modify files (readOnly metadata flag)
- readOnly tasks skip unnecessary git pull, JIRA branch creation, and worktree setup
- Flaky test suite stabilized by increasing vitest timeout from 5s to 10s (parallel execution pressure caused intermittent timeouts)
- Added `PORTOS_API_URL` constant to `ports.js` for dynamic API URL resolution in task prompts

## Removed
