# Release v2.128.0 - Sculpted Osprey

Released: 2026-11-24

## Highlights

- **Blender Models Studio**: Create, build, review, and export game-ready Blender models directly on the 3D page, complete with reference sheets, parts briefs, moving parts with 0–1 pose sliders, collision sweeps, worn-material texture baking, and one-click showcase films.
- **Film & 3D Production Tools**: Compare Three.js builds against product-sheet reference views, catch interpenetrating parts during clip playback, view motion reference clips beside film shot contact sheets, and drop 3D library models into Blender or code films.
- **Catalog, Embeddings & Local LLMs**: Trigger catalog embedding backfills from the Embeddings tab with disabled-provider guards, export catalog slices from the Catalog UI, and browse newly added local models including MiMo-V2.6 9B, Laguna XS 2.1, Qwen3-Coder-Next, Ornith 1.5 122B, and GLM-OCR.
- **Performance, Security & Reliability**: Sped up GitHub notification sync, Beeper reconciliation, native usage scans, and cold-load client bundles, while tightening credential permissions (`0600`), pinning immutable Hugging Face revisions for image/audio/music models, and hardening OAuth and installer verification.

## Added

- **Blender Models Engine & 3D Page**: Added a full Blender Models workspace on the 3D page with model creation, GLB export and re-import verification, reference sheets, parts briefs, build-vs-reference comparison, moving-part 0–1 pose sliders and collision sweeps, worn-material texture baking, and showcase film generation from published models.
- **Three.js & Film Workflows**: Added one-tap product-sheet and multi-view references for Three.js model generation, clip-playback collision detection for Three.js parts, motion reference clips beside film shot contact sheets, and support for adding 3D library models to Blender or code films.
- **Catalog & Embeddings Controls**: Added catalog embedding backfill controls in the Embeddings tab (refusing disabled providers) and catalog slice export in the Catalog UI.
- **Local LLM Catalog & Trusted Bots**: Added MiMo-V2.6 9B, Laguna XS 2.1, Qwen3-Coder-Next, Ornith 1.5 122B, and GLM-OCR to the local LLM catalog, and added default instance-bot trust plus an explicit trusted-bots list for GitHub accounts.

## Changed

- **Quality & App Health**: Updated App Quality to use an 85+ healthy target band with a recency-decay window and per-slice score history.
- **Performance**: Bounded concurrency and batched database writes/indexes for GitHub notification sync, coalesced and cached Beeper reachability probes and Tribe lookups, split navigation search metadata and theme palettes out of the cold-load client bundle, and streamed native agent usage scans.
- **Accessibility & Responsive Polish**: Improved keyboard navigation, focus rings, landmarks, contrast, reduced-motion support, narrow-width layouts, and large-text alignment across Goals, Flows, and Autofixer.

## Fixed

- **Security & Credentials**: Enforced `0600` permissions on secret-bearing `.env` files and credential stores, moved Telegram bot tokens to a `0600` private key store, required single-use Google and Spotify OAuth state with Host-derived origins, gated host-control routes, and verified SHA-256 checksums for Bun, Ollama, and Slotstream downloads.
- **AI Media & Model Pinning**: Pinned immutable Hugging Face commit revisions for FLUX.2, FLUX.3 Klein, diffusers, MiniMax-Music3, and Qwen3-TTS, recovered interrupted rigging/retargeting runs on boot, made rigging readiness probes race-safe, and preserved untouched video retry parameters.
- **FableLoom, Code Animation & Messaging**: Serialized concurrent Series Autopilot starts, recovered closed SSE streams in Autopilot and Pipeline Issue views, preserved FableLoom export jobs and volume beat-sheet progress, preloaded upcoming music-video shots, erased derived Timeline/Tribe copies when disabling subcalendars, and made Stacker News action replays idempotent.
- **Memory & Brain**: Unified catalog and memory embedding settings, kept memory related links symmetric, preserved journal and tombstone purges, and prevented memory decay from archiving Persistent Mind memories.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.127.0...v2.128.0
