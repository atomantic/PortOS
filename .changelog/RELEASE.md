# Release v2.131.0 - Upscaled Nightingale

Released: 2026-11-27

## Highlights

- **Video & Shot Upscaling**: Upscale generated videos and Music Video shots using the new opt-in local Real-ESRGAN lane or the fal.ai SeedVR2 1080p cloud upscaler.
- **Browser Voice Call & Lip Sync**: Start voice calls directly from a dedicated browser call console and the mobile top bar, with optional local AvatarForcing lip sync and Conversational Gemma voice support.
- **Music Video & Storyboard Editing**: Undo and redo Music Video board edits, cancel in-flight storyboard panel generation batches and Photoreal renders, and preview snapshot treatments cleanly.
- **Local X Drafts, Legacy PDF & Digest Catch-Up**: Manage the full local X draft lifecycle, export Legacy archives to PDF with live progress, and configure Activity Digest catch-up settings in Brain.
- **Stronger Host-Control & Storage Safety**: Enforced host-control admission for remote desktop, vault reads, and process streams; tightened owner-only permissions on personal and credential stores; and reconciled live caches after backup restores.

## Added

- **Video & Music Video Upscaling**: Added an opt-in local Real-ESRGAN video upscale lane, fal.ai SeedVR2 1080p cloud video upscaling, and a Music Video shot upscale workflow that inherits project attribution.
- **Voice Studio & Calls**: Added a browser Voice Call console, added Voice Call quick access to the mobile top bar, added optional local AvatarForcing lip sync, and cataloged Trelis Conversational Gemma with gated download access checks.
- **Creative Studio Controls**: Added a board edit undo stack and UI controls in Music Video, batch cancellation for Storyboards panel generation, and active Photoreal render cancellation in Catalog.
- **Brain, Models, Legacy & Social**: Completed the local X draft lifecycle, exposed Activity Digest catch-up settings in Brain, added PDF export options with progress tracking in Legacy Export, and added Inkling and cached MTPLX agent checks in Models.

## Changed

- **Music Video & Previews**: Applied restrained default template effects for new Music Video projects, displayed snapshot treatments in native previews, and updated the icon library.
- **API & List Bounding**: Bounded Chief of Staff and media list responses, projected FableLoom story summaries in PostgreSQL, avoided loading large media records for list metadata, and batched Tribe touchpoint writes.
- **UI & Accessibility**: Consolidated Persistent Mind workspace controls and learning analytics in Chief of Staff, unified image generation provider controls, added bulk confirmation prompts for app automation toggles and media/AI cleanups, and improved accessibility across Rapid Reader, Walk workflows, and Cognitive Drills.

## Fixed

- **Security & Privacy**: Enforced browser and host-control admission for Remote Desktop, gated host vault reads and process streams behind host control, revoked hosted FableLoom sessions with PortOS auth, bound Eidoverse renderer access to the visitor seat, protected personal and provider recovery stores with owner-only permissions, and scrubbed deleted subject addresses.
- **Voice & Media Stability**: Removed Voice's default completion cap, prevented capture transcription races, serialized voice profile promotion and model provisioning, preserved EXIF orientation on image uploads, preserved opening preview frames across seeks, and surfaced FFmpeg and upscale failures cleanly.
- **Backups, Sync & Chief of Staff**: Reconciled live JSON, prompt, timer, and Digital Twin caches after backup restores; locked snapshot actions during database restores; preserved active CoS workers during dev startup; reconciled agent schedule timers during live restore; protected MortalLoom history during bidirectional edits; and made failed run, Pipeline, and Sharing loads retryable.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.130.0...v2.131.0
