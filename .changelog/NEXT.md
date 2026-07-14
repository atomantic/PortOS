# Unreleased

## Security

- **[issue-2514] Harden AI provider custom endpoints against SSRF / API-key exfiltration.** A provider's `endpoint` is a free-form URL, and model-refresh / API-run paths attached the paid `Authorization: Bearer <apiKey>` and fetched that host with no host checks — a hostile or mistyped endpoint could receive the user's paid LLM key and prompts, or be pointed at a cloud-metadata service (`169.254.169.254`). A new `endpointGuard` now gates every secret-bearing request: loopback/LAN (Tailscale) and known paid-provider hosts are allowed, cloud-metadata hosts are always blocked, and any other host requires the new per-provider **Allow custom endpoint** opt-in. Keyless local-LLM calls (Ollama/LM Studio) are unaffected.

## Fixed

- **[issue-2510] MidiPianoRoll: clear the stale hover overlay when the transcription data changes.** The piano-roll kept its hovered note/chord identity (objects from the previous parse) when the `data`/`chords` props swapped on a mounted instance, so a re-transcription or Retry while a hover was active and the pointer sat still would keep stroking the old note at coordinates mapped into the new file until the next pointer move or Escape. A `useEffect` now drops the hover identity whenever `data`/`chords` change.
- **[issue-2513] Block loopback/metadata hosts in Layered Intelligence custom `http` sources.** `fetchHttpSource` used a bare `fetch` with only an `http(s)` scheme check, so a hand-edited config could point a custom source at `127.0.0.1`, `169.254.169.254`, or `metadata.google.internal` and exfiltrate up to 8KB into the reasoner prompt. It now routes through the shared SSRF-guarded `fetchPublicText` (default posture): loopback, link-local, and cloud-metadata hosts are blocked and redirects are revalidated, while LAN/Tailscale hosts stay intentionally allowed for this single-user tool.
