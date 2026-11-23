# Release v2.127.0 - Feedback Firefly

Released: 2026-11-23

## Highlights

- **Digital Twin Behavioral Feedback Loop**: Wired the Digital Twin behavioral feedback loop end to end, with clearer error states when recent feedback fails to load, runtime context-window limits, and improved tab confirmations and mobile touch targets.
- **Live fal.ai Image Model Picker**: Image generation now loads fal.ai's live model catalog on demand, validates model prompt and reference-image requirements before paid runs, accepts custom model endpoint IDs, and prioritizes featured edit models for frame refinements.
- **Plan-First HTML Pages**: HTML Pages now plans each page before generating it, displays both the prompt and plan, and organizes creation into Create, Runs, and Gallery tabs.
- **Accessibility & Performance**: Improved keyboard, focus-trap, and screen-reader semantics across Sharing, Conflicts, Elements Song, Merge modals, and Data Manager, while speeding up catalog search, branch lane-health checks, and developer pre-push guards.

## Added

- **Digital Twin Feedback Loop**: Added end-to-end behavioral feedback collection and recent-feedback display for the Digital Twin, with explicit error states if feedback fails to load.
- **Live fal.ai Image Model Catalog**: Added an on-demand fal.ai model picker with manual refresh, schema-checked prompt and reference-image validation, custom endpoint support in Settings, and "Edit with" prioritization for music-video frame refinements.
- **HTML Pages Planning & Tabs**: Added a planning step before HTML page generation, visible prompt and plan details, and dedicated Create, Runs, and Gallery tabs.

## Changed

- **Digital Twin Controls & Mobile Layout**: Honored Digital Twin maximum context token settings at runtime, gated Run actions on saved options, preserved unsaved drafts with confirmations across tabs, scrolled the Settings panel into view on Enable, and improved mobile layout and touch targets.
- **Accessibility & Copy Polish**: Added dialog focus traps and ARIA semantics to Share/Sync popovers, Sharing, Conflicts, Merge modals, Elements Song, and Data Manager, and fixed singular/plural copy across seven UI surfaces.
- **Performance & Tooling**: Omitted unused embeddings in catalog search, batched reference lookups, bounded and cached lane-health forge reads, trimmed structural guard runtime, and dropped `concurrently` from generated app scaffolds.

## Fixed

- **Privacy & Security**: Stripped PortOS credentials from Eidoverse proxy upstream requests, completed Privacy Center draft erasure on vault updates and opt-outs, enforced broker disclosure fields and full names on opt-out emails, and atomically staged Tailscale HTTPS self-signed certificates with directory watching.
- **FableLoom & Media Pipelines**: Serialized FableLoom batch cancellation with enqueueing, kept Start Batch Production available after failed or canceled runs, guarded story load-error and rollback races, prevented per-edit validation churn, pruned invalid export cache directories, preserved volume cover slots on script-only edits, and returned proper conflict errors for stale audio line targets.
- **Messaging & Sync**: Excluded already-claimed messages from Beeper outbox fallback confirmation, preserved measured attachment sizes and participant display names on re-sync, kept Beeper download partials excluded during backups, invalidated video-history checksums on tombstone updates, and inserted missing overnight voicemail boundaries when typing.
- **Motion, Image Generation & Branch Management**: Replaced `npx skills@latest` with a pinned SHA-256-verified archive installer for motion skills, pinned MusicGen and FLUX.2 setup environments with root-aware `ffmpeg` installation, stopped branch reconciliation from stranding failed claim checkouts or squash-merged claims, and hydrated the Weekly Quality Schedule form from saved overrides.
- **Database & Settings**: Improved native Postgres lifecycle handling and Homebrew `psql` resolution in setup scripts, and prevented stale reset-to-defaults responses after switching apps.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.126.0...v2.127.0
