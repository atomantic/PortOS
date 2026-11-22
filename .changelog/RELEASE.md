# Release v2.126.0 - Skillful Falcon

Released: 2026-11-22

## Highlights

- **Skill Curator & Agent Skills Registry**: Prompt Manager gains an Agent Skills tab with a deterministic Skill Curator that tracks usage, pins or locks skills, archives unused ones, and supports ledger rollback, backed by a progressive-disclosure skill registry with quarantine protection.
- **Website Logins in Privacy Vault**: Store website credentials in the Privacy Vault and let browser agents perform origin-bound, model-blind login fills gated by an explicit fill grant toggle.
- **Mixture of Agents & Multi-Key Credential Pools**: Persistent Mind thinking presets now support Mixture of Agents with parallel tool-free advisors, and API providers gain multi-key credential pools with per-model rate-limit cooldowns and automatic rotation.
- **Hermes Agent, ACP Adapter & Job Reliability**: Hermes Agent joins as a first-class CLI/TUI harness, Ask Yourself and Persistent Mind are exposed over an ACP stdio adapter, and autonomous jobs gain a bounded durable notepad, preflight checks, deduplicated failure incidents, and an unreachable retry ladder.
- **Local Models & Inkling 2 Mini**: Added Inkling 2 Mini support for Ollama and LM Studio, MTPLX 2.13 packs with thinking-effort forwarding, cancelable model downloads, per-model context-window sizing, and an output speed axis on Models › Comparison.
- **Keyboard Accessibility & Performance**: Added keyboard navigation, panning, and controls across World Map, Wiki, Universe Builder, Beat Timeline, and collapsed sidebar flyouts, alongside faster Brain list loading and GitHub notification triage.

## Added

- **Skill Curator & Registry**: Added an Agent Skills tab in Prompt Manager with usage telemetry, pin/lock controls, archival, and ledger rollback, plus a progressive-disclosure skill registry with quarantine for unsafe content.
- **Website Logins**: Added a Website Logins manager in the Privacy Vault with a dedicated fill grant toggle so agents can sign into matching origins without seeing raw credentials.
- **Mixture of Agents (MoA)**: Added MoA presets with parallel tool-free advisors and cache-safe aggregator injection, selectable from Persistent Mind thinking presets.
- **Multi-Key Credential Pools**: Added multi-key credential pools with per-model 429 cooldowns and same-provider key rotation.
- **Hermes Agent & ACP Adapter**: Added Hermes Agent as a CLI/TUI provider harness and exposed Ask Yourself and Persistent Mind over an ACP stdio adapter.
- **Persistent Mind Context Breakdown**: Added a live context-window breakdown and window provenance view for Persistent Mind.
- **Autonomous Job Notepad & Preflight**: Added a bounded durable key-value notepad, preflight checks, deduplicated failure incidents, and an unreachable retry ladder for autonomous jobs.
- **Telegram Artifact Delivery**: Delivered notification artifacts natively to Telegram.
- **OpenRouter Provider Routing**: Added OpenRouter provider-routing preferences.
- **Local Models & Benchmarks**: Added Inkling 2 Mini (Ollama, LM Studio, MTPLX 2.13 packs, and AA v5.0.1 comparison scores), an output speed axis on Models › Comparison, cancelable model downloads, repo-ID Hugging Face search, and Homebrew upgrade management in Settings › Software.
- **Host-Mode Media Streaming**: Streamed host-mode reference images, audio, and 3D models instead of copying them, and added primary machine consolidation for Unsorted media.
- **Keyboard & Graph Controls**: Added keyboard pan, zoom, and node navigation to World Map, Wiki graph, Universe Builder graph, and Beat Timeline.

## Changed

- **Context-Window & Prompt Sizing**: Sized each local model's context cache at install, added per-model context overrides, bounded local maintainer prompts by the model's window, and allowed effort settings to select Ollama thinking levels.
- **Faster Lists, Sync & Dependencies**: Loaded Brain list rows and backup snapshot history on demand, skipped unchanged CLI transcripts when recording runs, batched GitHub notification triage and sync loops, cloned duplicate Hugging Face hub blobs, routed runtime downloads through the hub cache, and replaced several third-party libraries (`chokidar`, `google-auth-library`, HTTP compression, terminal web-link detection, and bundle visualization) with owned implementations.
- **Accessibility & Headings**: Standardized page heading hierarchy, named Recharts charts, raised contrast on CoS queue and agent action labels, and made collapsed sidebar flyouts keyboard reachable and dismissible.
- **Music Video & Media Collections**: Allowed directors to mark a music video complete or back in progress, displayed Music Video tags on media collections, and added a Make-primary action for shared media.

## Fixed

- **Privacy & Log Redaction**: Scrubbed prior values, sealed evidence, and Privacy Center email drafts on vault/subject/consent changes, kept Meatspace doses, personal names, goal/todo/calendar names, Tribe contact names, Moltbook verification answers, local paths, and user-authored text out of operational logs and media prompts, and stripped location/device metadata before sending media to providers.
- **Ollama & Agent Execution**: Registered Ollama-backed CLI/TUI and runner-hosted agent runs as in-flight work, serialized resident-window unloads and gated reloads on drain, and improved parser rejection classification for model tool markup.
- **Health, Clinical & Meatspace**: Aggregated Apple Health XML steps and sleep once per file, queried Health charts by local calendar day, stamped blood panels on analyte import, preserved alcohol/nicotine drafts and failed genome/marker/intervention deletes, and improved error/retry states on Health and POST.
- **Social, Messages & FableLoom**: Fixed X account silent-reload races, draft review status, and socket refreshes; fixed Messages draft expansion/approval and live sync progress; and fixed FableLoom hosted session state broadcasts, guest push-to-talk recovery, and blocked image explanations.
- **Media & Peer Sync**: Prevented project renames from invalidating Blender shot renders, preserved storyboard fields, mood-board video pins, and artist press profiles across older-peer edits, and fixed chronotype zone label legibility.
- **Setup & Upgrades**: Repaired `pgvector` and restarted stale Postgres binaries after Homebrew upgrades, fixed stale-Postgres setup checks, and updated outdated server and client npm dependencies.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.125.0...v2.126.0
