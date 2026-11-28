# Release v2.132.0 - Transceiver Phoenix

Released: 2026-11-28

## Highlights

- **Voice Call Transceiver & Realtime Speech**: Redesigned the Voice Call station with a sat-phone transceiver handset, added realtime speech-to-speech calls with Voice tool handoff, added per-channel avatar and agent settings backed by a federated Avatars collection, and enabled continuous AvatarForcing neural idle with realtime lip sync.
- **Music Video Effects & Vertical Export**: Added optical film light effects with live picture preview and stacked effects, styled credits themes with background stills and social handle badges, and a framed 16:9 vertical preview with safe zones and full-length export.
- **Voice Setup & Model Controls**: Added an inline Voice LLM picker with live loading and memory status, one-click llama.cpp Conversational Gemma setup with 16k context, and cancellation for local TUI checks and Jev training in Models.
- **Security, Privacy & Backup Hardening**: Enforced targeted session revocation across VNC, Eidoverse, and FableLoom; locked down personal, Digital Twin, Brain, and Beeper store permissions; switched `.env` writes to atomic owner-only files; and kept database passwords out of process arguments and logs.
- **Mobile, Accessibility & Runtime Efficiency**: Improved mobile layouts across Wiki, Insights, Calendar, Video Gen, and Navigation; tightened accessibility semantics across Voice Call, MeatSpace, and Organize panels; and trimmed dozens of unused dependencies from local MLX and CUDA runtime locks.

## Added

- **Voice Call & Transceiver**: Added a sat-phone transceiver handset and redesigned Voice Call station, added realtime speech-to-speech Voice Calls that delegate lookups and actions to Voice tools, added per-channel agent settings and avatar channels backed by a federated Avatars collection, and added inline chat input and vision support for shared tabs and uploaded images.
- **Avatar & Voice Model Setup**: Added continuous AvatarForcing neural idle that starts automatically on Voice Call open with a pixelated connecting state and realtime reply lip-sync, added an inline Voice LLM picker with loading and memory status indicators, and added one-click llama.cpp Conversational Gemma setup.
- **Music Video Studio**: Added optical film light effects with live picture preview and stacked effects, styled credits themes with background stills and social handle badges, and framed 16:9 TikTok vertical preview with safe zones and full-length export.
- **Models**: Added cancellation support for local TUI checks and Jev training.

## Changed

- **Voice Defaults & Layout**: Recommended Ollama `gemma4:26b` as the fast Voice brain, kept the Voice prompt prefix stable across turns to preserve LLM caching, moved desktop floating voice setup controls behind compact tabs, and raised Conversational Gemma `llama-server` context to 16k.
- **UI & Mobile Polish**: Wrapped narrow Video Gen provider switches, compacted Insights and Calendar navigation on phones, improved Wiki mobile Browse width and Search input layout, improved Peer card button affordances, and added bulk confirmation prompts across destructive PortOS actions.
- **Runtime Locks & Performance**: Trimmed unused packages across Apple Silicon MLX and CUDA runtime locks (FLUX.3 Klein, FastVideo, Wan 2.2, MiniMax Music 3, MiniMax H3, MusicGen, MuScriptor, AuK, Pixal3D, and 3D Metal), bounded peer pull concurrency, projected Music Video summaries in PostgreSQL, and batched raw agent terminal spools.

## Fixed

- **Security & Session Revocation**: Disconnected sockets and rejected credential creation after targeted session revocation across authGate, VNC, Eidoverse, and FableLoom; required host control for CLI vision, workspace contexts, video-gen status, and live host probes; wrote `.env` secrets atomically with `0600` permissions while preserving symlinks; and kept database passwords and realtime voice tokens out of process arguments and URLs.
- **Privacy & Backups**: Restricted personal, Digital Twin, Brain, and Beeper store permissions; scrubbed genetic conclusions from Time Capsule snapshots; enforced broker consent and delivery confirmation in Privacy; preserved live Brain stores during legacy snapshot restores; and reconciled cached JSON stores during live restore.
- **Voice, Media & Reliability**: Hardened realtime voice sidecar auth, startup, and teardown across tabs and turn boundaries; prevented Music Video credits color save storms and vertical render stalls; settled canceled FableLoom media batches cleanly; retried transient Docker and Ollama setup fetches; and surfaced deploy and local runtime failures cleanly.

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v2.131.0...v2.132.0
