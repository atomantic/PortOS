# Release v2.124.0 - Melodic Sparrow

Released: 2026-11-19

## Highlights

- **MIDI-Aware Music Video Planning & Clip Audio**: Music Video Studio now supports MIDI-aware song planning, standard cast sheets, and mixing clip sound over the song in document finals and excerpts, with automatic recovery from MIDI transcription failures.
- **Faster Client Navigation & Dashboard**: Heavy viewers, workbench stage panels, DevTools pages, and the Models, POST, and Messages tabs now load on demand, while the Apps dashboard renders immediately before quality scores finish loading.
- **Video Downloader on macOS**: You can now install `yt-dlp` directly from Video Downloader on macOS and see exact downloaded video file paths right in the interface.
- **Safer Backups, Database Cutover & Peer Sync**: Database cutover checks the destination before stopping PortOS and retires obsolete usage tables, healthy backup retention slots are protected, and schema refusals now identify the peer install behind them.
- **Smoother Social Publishing & Chief of Staff**: LinkedIn, Instagram, Facebook, and Reddit publishing flows handle detached composers, updated navigation icons, caption paragraphs, and vertical export caps more reliably, while Chief of Staff enforces monotonic spawn-budget accounting and comment-triggered claim reviews.

## Added

- **MIDI-Aware Music Video & Cast Sheets**: Added MIDI-aware planning, standard cast sheets, and mixing clip sound over the song in Music Video Studio.
- **Video Downloader macOS Setup & Paths**: Added one-click `yt-dlp` installation from Video Downloader on macOS and displayed downloaded video file paths.
- **Gemini 4 Neon Comparison**: Added Gemini 4 Neon comparison evidence and retained its API references in the comparison catalog.
- **Comment-Triggered Claim Reviews**: Added support for comment-triggered claim reviewers in Chief of Staff.

## Changed

- **On-Demand Page & Panel Loading**: Lazy-loaded the 3D viewer, assessment panels, goals list, workbench stage and tab panels, DevTools pages, and the Models, POST, and Messages tabs to keep initial page loads fast and light.
- **Apps Dashboard & Publish Preview**: Rendered the Apps dashboard before quality scores load, distinguished row quality from page loading, and showed the vertical kit's real layout in the publish preview.
- **Brain Audio & Tribe**: Added smooth fade-out before stopping Brain meditation audio, and added URL-backed person selection, delete confirmation, and accessible form labels in Tribe.
- **Setup & Dependencies**: Unified setup scripts through a single pipeline and updated client dependencies.

## Fixed

- **Music Video & Social Publishing**: Recovered MIDI transcription failures and Autopilot songs after Suno form failures, omitted empty audio filters for near-unity rates, capped vertical social exports for Suno Hook, preserved Facebook reel caption paragraphs, bounded Reddit publishing requests, accepted publish-kit frames for thumbnail title painting, protected migrated previz records from older peers, and fixed Instagram and LinkedIn media editor flows when composers detach or navigation icons change.
- **Backups, Database & Peer Sync**: Checked the database cutover destination before stopping PortOS, retired obsolete usage tables during backend cutover, protected healthy database retention slots, kept legacy CoS config inspection inside snapshots and flagged historical task queues during restore, and identified the install behind schema refusals.
- **Chief of Staff & Agent Execution**: Made settled inline release handoffs read-only, kept divergent checkout cleanup pending, completed claims waiting only on required human approval, replaced spawn-budget proofs with a monotonic counter that merges consistently across peers and offers resets on spawn-cap blocks, settled Claude's folder-trust selector before confirming, stripped stray TUI escape sequences from transcripts, and kept Claude CLI warnings out of model replies.
- **Brain & Video Processing**: Retained failed Brain memory resyncs for restart, serialized journal mirror location deletion, and bounded signed Topaz video transfers.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.123.0...v2.124.0
