# Release v2.123.0 - Mindful Owl

Released: 2026-11-18

## Highlights

- **Audio Meditation in Brain**: Brain now includes guided audio meditation sessions alongside your journal, notes, and personal knowledge workspace.
- **GPT-6.2 Model & Pricing Support**: Existing Codex providers and catalog refreshes now offer GPT-6.2 models with verified comparison pricing and benchmark results.
- **Sharper Music Video Library & Catalog**: Music Video projects can be filtered by completion status and searched across all pages, while deleting a project preserves focus and reading position and open catalog views refresh after peer updates.
- **Resilient Backups & Restores**: Database backups reject incomplete dumps before retention, bound preparation probes and restore drains, enforce deadlines on snapshot download extraction, and surface degraded scheduled runs as failed.
- **Accurate Takeout, Calendar & Spotify Sync**: Gmail Takeout imports preserve distinct threads and attach replies to live mailboxes, YouTube Takeout retains exact watch times, Google Calendar sync drains pending writes before account removal, and Spotify sync drains recent playback before advancing its cursor.

## Added

- **Audio Meditation in Brain**: Added audio meditation support directly in Brain.
- **GPT-6.2 Provider & Benchmark Support**: Added GPT-6.2 models to Codex provider catalogs along with verified comparison pricing, effort benchmarks, and benchmark task comparisons.
- **Music Video Completion Filter**: Added filtering by completion status on the Music Video projects list.

## Changed

- **Music Video Search & Catalog**: Searched music-video project names before pagination, reconciled music video filters after catalog commits, and refreshed open catalog views after peer writes.
- **Creative Director & Universe Builder**: Kept Creative Director plan badges and budgets in sync, validated Universe Builder renders per prompt, and matched render counts for category aliases.
- **Chief of Staff & Swarm Coordination**: Serialized swarm merges through the forge, loaded conditional claim procedures on demand, and kept merged-by-ancestry cleanup working across Windows and GitLab.
- **Dependencies**: Updated client and server npm dependencies.

## Fixed

- **Music Video Focus & Clip Evidence**: Preserved focus and reading position when deleting a music-video project, and preserved clip evidence during catalog outages.
- **Backup & Snapshot Reliability**: Rejected incomplete PostgreSQL dumps before retention, bounded preparation probes and restore drains, distinguished restore preflight outages from schema conflicts, handled snapshot downloads canceled before attachment, enforced wall-time deadlines on snapshot download extraction, and reported degraded scheduled backup runs as failed.
- **AI Runs & Providers**: Prevented quick AI calls to Ollama from silently dropping the start of prompts, refused dispatch after an early Runs stop, persisted usage ownership in terminal run records, serialized bounded completions with local runs, and selected the visible Gemini upload menu item for video generation.
- **Personal Data & Sync**: Preserved Gmail Takeout messages in distinct threads, attached imported Gmail replies to their live mailbox, retained exact YouTube watch times from Takeout, required Google provider event IDs and drained calendar sync writes before account removal, and drained recent Spotify playback history before advancing the cursor.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.122.0...v2.123.0
