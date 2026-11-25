# Release v2.129.0 - Guided Kestrel

Released: 2026-11-25

## Highlights

- **Managed Local Runtimes & Coding Context**: Install, start, repair, and monitor Splash (with its Inkling checkpoint) and mkserve directly from PortOS with PM2 logs, performance tracking, free-disk checks, and automatic provider model refreshes, while editing Claude Code, OpenCode, and Splash context in-app.
- **Multi-Runtime LLM Playground**: Test and compare models across every running local runtime in the Local LLM Playground, with clearer per-runtime listing errors and removable stale selections.
- **Music Video & Media Studio**: Apply non-destructive Image Treatments to music video shots, move takes between shots, label and switch project versions, browse a paginated video gallery picker, and inspect or edit negative prompts on image and video retries.
- **CoS Linking & Feature Audit Priorities**: Navigate directly between Chief of Staff agents, runs, run events, and tasks via deep links, and view or pin feature-area audit priority tiers in Settings > Features.
- **Performance & Reliability**: Split heavy charting and 3D libraries out of cold-load bundles, speed up app status lists, media gallery search, and Review history, and add retryable error states and duplicate-submit guards across core pages.

## Added

- **Managed Splash & mkserve Lifecycle**: Added in-app lifecycle controls, pinned installation, free-disk verification, PM2 log integration, performance measurements, proxy support, and cache repair for Splash (including Inkling) and mkserve, plus automatic provider-model refreshes after starts, downloads, or removals.
- **In-App Coding Context Editor**: Added editing for Claude Code, OpenCode, and Splash context inside PortOS, with Launch in Shell support for managed apps and OpenCode 2.
- **Local LLM Playground Multi-Runtime Comparison**: Added side-by-side testing and comparison across all running local runtimes, retaining unavailable selections as removable rows and surfacing per-runtime listing errors.
- **Music Video & Media Controls**: Added non-destructive Image Treatments for music video shots, moving takes to another shot, music video project version labels and switching, and pagination in the video gallery picker.
- **CoS Cross-Linking & Audit Priorities**: Linked Chief of Staff agents, runs, run events, and tasks with deep-link resolution by run ID, added automatic feature-area usage learning with pinnable priority tiers in Settings > Features, and added reasoning-only timeout reporting for HTML Pages.

## Changed

- **Performance & Bundle Splitting**: Split shared client chunks so routes no longer load 3D and charting libraries unnecessarily, served Video Gen status from a shared probe cache, indexed media gallery search and filter fields, paged Review history, trimmed mood board and comparison payloads, and read only metadata prefixes when scanning Obsidian notes.
- **Retry & Edit Flows**: Built the image Edit and Retry form from Image Gen compose controls with model-input previews, showed source negative prompts on Regenerate and annotation re-renders, and kept Schedule Timeline edits applied locally with clearable recheck schedules.
- **Dependencies & Retirements**: Updated client charting and icon dependencies (`recharts` and `lucide-react`), and retired the Integration Flows viewer along with unused routes.

## Fixed

- **Media & Video Generation**: Prevented duplicate 3D renders on double-click, refused unsupported negative prompts on Reactor renders, validated hosted video durations and attachments for Gemini, Runway, and Higgsfield, preserved inherited prompts and retry edits after refusals, and prompted before leaving Media Annotate with unsaved strokes.
- **Chief of Staff & Runs**: Stabilized Chief of Staff avatar state and slice refreshes across tab switches and socket updates, serialized pinned Runs reads, kept scheduled jobs armed after overlapped or failed fires, and prevented updates from killing detached jobs.
- **Error States & Form Input**: Added retryable load-error states across Insights, Catalog, Privacy Center, POST, and Dashboard widgets, fixed digit-by-digit number input and speech-rate entry below 1, preserved commas and spaces in Brain follow-ups, and stopped double-clicks from creating duplicate records.
- **Imports, Feeds & Backups**: Fixed iPhone Google Timeline visit imports, WhatsApp afternoon timestamps, legacy Spotify podcast plays, Gmail Takeout sent-mail labels, Atom feed decoding, Rapid Reader book reopening, and exclusion of managed Python environments from backups.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.128.0...v2.129.0
