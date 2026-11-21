# Release v2.125.0 - Curated Kingfisher

Released: 2026-11-21

## Highlights

- **Creative Director & Auto-Organized Collections**: The Video Library is now consolidated into Creative Director, and generated, downloaded, mood board, and catalog media are automatically organized into project, cast, environment, object, and external collections that can be joined and consolidated on a primary machine.
- **Music Video Audio Layers & Fades**: The Music Video editor timeline now supports audio layers, fade controls, and live previews for mixing clip sound over the music track.
- **Faster Startup & Streamlined Navigation**: Server startup defers optional routes and heavy feature engines until needed, client overlays load on demand, navigation and automation settings are streamlined, and GitHub inbox automation now supports rules by notification reason.
- **Stronger Privacy & Chief of Staff**: Vault, genetic, health, and authored music prompt data are kept out of operational logs and stored prompts, while Chief of Staff adds opt-in auto-approve and admin-merge support for code-owner-blocked pull requests.
- **Unified Updater & Autofixer Resilience**: The PortOS updater now runs through a single unified pipeline, and Autofixer preserves monitoring, port metadata, and healthy services across upgrades and restarts.

## Added

- **Auto-Organized Media Collections**: Automatically filed generated images and videos, mood board renders, downloaded or imported external media, and catalog references into project, cast, environment, object, named, and External collections, with support for joining collections, confirming deletions, consolidating on a primary machine, and filtering media history to the current machine.
- **Creative Director Video Consolidation**: Consolidated the standalone video library into Creative Director.
- **Music Video Timeline Audio**: Added audio layers to the Music Video editor timeline along with fades and live preview for clip sound over the music.
- **Single-Character Reference Sheets**: Added a single-character standard reference sheet option.
- **GitHub Inbox Automation Rules**: Added GitHub inbox automation rules filtered by notification reason.
- **Chief of Staff Opt-In Auto-Approve & Admin Merge**: Added opt-in auto-approve and admin-merge handling for pull requests blocked solely by code-owner review requirements.
- **Provider Model Reconciliation on Upgrade**: Reconciled shipped provider models automatically during upgrades.

## Changed

- **Faster Startup & Navigation**: Deferred optional routes, media job hooks, and heavy image/AST engines from cold server startup, lazy-loaded client shell overlays, streamlined navigation and automation settings, restored all pages to sidebar navigation, and split large Story Builder, Review, Usage, and Agent Card views into focused modules.
- **Unified PortOS Updater**: Consolidated the PortOS updater behind one cross-platform pipeline.
- **Media & Image Generation Workflows**: Unified image generation input preparation, provider dispatch, and cloud model selection, and loaded Music Video and retry model pickers from a dedicated model context.
- **Client Dependencies**: Updated client dependencies including `lucide-react`, `react-router`, and Testing Library packages.

## Fixed

- **Privacy & Credential Protection**: Kept vault facts out of stored prompts, protected fleet host credential reveals, kept genetic, health, and authored music prompts out of operational and generation logs, scrubbed withdrawn facts from late responses, and preserved publication admission for private output.
- **Media Collections & Catalog Sync**: Fixed media collection manifest syncing, history-based video path resolution, peer-hosted collection parity counts, orphaned dated Creative Director collection folding, catalog merge associations, transactional universe canon membership, and atomic initial ingredient relations.
- **Music Video & Creative Exports**: Fixed false out-of-date status on legacy Music Video finals, stale final render settlement, early final footage reconciliation, provisional invalid lyric word timings, Code Animation soundtrack process cancellation, prose export error reporting and quoted filenames, annotation loading and toolbar touch targets, Image Cleaner retries, and SongBook import draft resets.
- **Chief of Staff, Pipeline & Claims**: Serialized inbound issue merges with local edits, preserved draft prose displaced by peer sync and newer render pins across peer edits, verified managed worktree dependencies before linking, protected maintenance admission under disk pressure, and prevented concurrent archive policy read races.
- **Autofixer & Updater**: Preserved healthy PM2 services, port metadata, and promotion state during Autofixer upgrades, kept Autofixer monitoring active if the dashboard fails to bind, and allowed update continuation after detached refusals.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.124.0...v2.125.0
