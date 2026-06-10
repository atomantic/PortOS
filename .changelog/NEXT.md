# Unreleased Changes

## Added

- **[issue-1092] Vocal takes remember their pitch analysis** — when you record a take against a song's notated melody, the take now keeps its color-match grading (percent-in-tune and per-note accuracy) and the tuner trace. Each saved take shows its score in the takes list, and a Review button replays that grading on the staff without re-singing.

- **Public API surface with per-API auth gating (Voice/TTS + sdapi):** PortOS can now serve individual services as HTTP APIs on your tailnet. A new **Settings → API Access** tab exposes per-API toggles — *Expose on the network* (off by default) and *Require auth* (off = passwordless) — so you can keep the whole app behind your PortOS password while leaving the **Voice/TTS** and **Image Gen (sdapi)** APIs open for other machines to call. A deliberately-minimal `POST /api/voice/public/synthesize` (plus `/voices` and `/engines`) turns text into WAV audio with any engine/voice/rate; config and process-control endpoints always stay gated. A single in-tree registry (`server/lib/apiRegistry.js`) drives the auth-gate exemptions, the settings UI, and a native **OpenAPI 3.1 spec** at `GET /api/api-docs/openapi.json` (no swagger dependency — request bodies are generated from the same Zod schemas the routes validate against). The API Access tab shows each API's public base URL and a copy-paste `curl` example, and the Voice settings tab links to it. Defaults are safe: both APIs ship not-exposed and passwordless-once-exposed, with a migration seeding the key for existing installs.

## Changed

- **[issue-1094] Federation "Make mutual" sync behavior clarified** — documented and locked in how toggling a sync category toward a peer stays mirrored on both machines. No change to how syncing behaves.
