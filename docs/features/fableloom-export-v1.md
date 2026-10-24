# FableLoom portable export v1

FableLoom exports authored stories and existing rendered media for an author's
own external host. PortOS remains private. Exports never upload, deploy, expose
PortOS, fetch a media URL, call a provider, or generate new creative media.

## API

An operator starts a job with `POST /api/fableloom/:id/export`:

```json
{"episodeIds":["example-episode"],"allowDraft":false,"mediaProfile":"source"}
```

Omit `episodeIds` for all episodes. Selections are unique and retain authored
episode order. Unknown options, wrong types and unknown episode IDs are refused.
The response is `202 {"jobId":"<uuid>"}`. Read
`GET /api/fableloom/:id/export/:jobId` for status, progress, validation findings,
expiry and a size report. A completed job supplies a relative `downloadUrl` for
`GET /api/fableloom/:id/export/:jobId/download`; downloads require operator
authority, including valid delegated agent sessions. Jobs cannot be read or
downloaded through a different loom. Instance authentication retains its existing
optional policy; no export endpoint is always-public.

`includePlayer:true` adds the dependency-free `player/` reference client
described in the runtime contract. This version still refuses
`includeCharacters:true` and `includeVoice:true`. Unknown media profiles are
rejected at validation.
`DELETE /api/fableloom/:id/export/:jobId` cancels a queued/running export and
waits for worker and encoder shutdown before returning its failed status
(`EXPORT_CANCELLED`). Completed jobs remain completed.

## Gates and approvals

The job snapshots the authored record, selected episodes, video history and
linked universe. It reuses graph, outline and production validation. All
reachable scenes need a still and an entry clip. Decision scenes also need
holds; legacy entry/video assets may supply their hold. Attached exit clips
must exist; an absent exit means a direct cut under runtime v1.

A still needs its existing storyboard approval. Video needs the loom's current
delivery approval, which record mutations invalidate. Each asset also needs
locked visual-conditioning provenance. Missing provenance, unapproved, draft
and degraded assets fail by default. `allowDraft:true` permits those approval
conditions and records explicit `draftFlags` per media use. It does not relax
graph, outline, production, missing media, encoding, occupancy, path or size
failures. Enabled live holds require verified speech-safe occupancy; intervals
cannot exceed the actual clip duration.

Media reads accept basenames only, resolve inside the appropriate gallery/video
root, refuse escaping symlinks and snapshot bounded regular-file bytes. No
history ID is reconstructed as a filename. Input changes during a read fail
the job. Preparation decodes stills to metadata-free PNG and remuxes H.264
yuv420p / optional AAC MP4 without re-encoding picture/audio samples. Animated stills remain unsupported. Web profiles accept decodable MP4 picture/audio
streams and transcode them as described below. Embedded container metadata, H.264 user-data SEI, chapters and extra tracks are
removed; authored source files remain unchanged.

## Web media profiles

`mediaProfile` defaults to `"source"` for compatibility. Choose `"web-720p"` or
`"web-1080p"` for H.264 yuv420p/AAC MP4, metadata-free PNG stills and a poster PNG
for each clip. Presets preserve aspect ratio, never upscale, cap frame rate at
30 fps, and fit within 1280×720 or 1920×1080. Video target/maximum bitrates are
2,000 or 4,000 kbit/s with a two-second VBV buffer; audio targets are 128 or
192 kbit/s at 48 kHz. Variable bitrate packets and container overhead mean the
actual byte report, not bitrate multiplied by duration, is the package size.

Two-pass loudness normalization targets −16 LUFS, −1.5 dBTP and LRA 11 for the
existing authored audio mix (including dialogue and SFX). Silence remains
silence; clips without audio remain silent. Audio too short or sparse for a
finite integrated-loudness measurement uses peak normalization to −1.5 dBTP
without padding its duration. Discarded subtitle/data tracks do not extend the
retained picture/audio duration. No stem separation, speech synthesis,
provider calls or new creative media generation occurs. Normalization changes
level, not authored occupancy intervals. Oversized, invalid, failed or timed-out
encodes fail the job visibly; clips are never shortened to fit the byte limit.

Set `includeWebm:true` with a web profile to additionally encode VP9/Opus WebM.
MP4 remains the primary playback file. Video descriptors add a `poster`
descriptor and, when requested, `alternatives` with `type:"video/webm"`. These
are additive runtime-v1 fields; each carries its own hash, duration and bytes.

`provenance.json` records each primary file's bytes, the complete resolved
profile (including recipe version and WebM choice), encoder version/build hash,
source content hash and cache key, plus poster/alternative descriptors. The
cache keys source bytes, media kind, complete profile and encoder identity;
different history IDs with identical content share an encode. Repeated exports
reuse verified cached bytes and hashes. A changed profile, source or encoder
invalidates reuse. Cache entries expire after 24 hours and are evicted oldest
first within a separate 256 MiB disk budget. Incomplete cache entries are never
accepted as completed encodes. Source media remains untouched.

## Package schema 1.0.0

- `manifest.json`: export schema, playback runtime and PortOS versions; explicit
  authored metadata, ordered episodes, reachable graphs and playback roles.
  Media uses only content hashes and relative `media/<sha256>.<ext>` references,
  with `durationMs`, `loopable` and projected audio occupancy.
- `provenance.json`: per-use content hash, provider/model labels, parameter hash,
  approval and conditioning status, draft flags, and encoding provenance.
- `media/`: deduplicated, metadata-free media.
- `runtime-v1.md` and `README.md`: the versioned playback and hosting contracts.
- `player/` when `includePlayer` is set: static HTML, CSS and scripts that read
  `manifest.json` and run runtime v1 in the browser. That directory has no
  instance data, credential, or authoring-service address.

All JSON object keys and ZIP member order are stable. ZIP timestamps are fixed.
The same source bytes and authored snapshot, with the same PortOS/media-tool
versions, produce identical manifest, media hashes and ZIP bytes. There are no
job IDs, timestamps, instance/peer IDs, local paths, credentials, provider
configuration, adapters, LoRAs, source prompts, sessions or transcripts in the
package. Only authored scene/choice text and the documented projections leave
the authoring record.

## Lifecycle and failures

Jobs and ZIPs are regenerable `ephemeral-file` cache entries. They expire after
24 hours; starting another export evicts expired entries and then the oldest
terminal entries to keep at most four jobs. Four queued/running jobs return
`EXPORT_QUEUE_FULL`. Each asset is capped at 64 MiB and each ZIP at 256 MiB.
Only one job prepares media at a time. Graceful maintenance tracks it through
final status persistence and scratch cleanup.
Prepared buffers are retained once by content hash, with a 256 MiB aggregate
budget; source-ID caches hold descriptors only. A preparation step adds at most
one 64 MiB source and up to three bounded prepared representations; ZIP construction adds at most
one 256 MiB archive buffer. Queued jobs retain only referenced video filenames.

A failed job exposes an actionable code/message and its preflight findings,
never a raw filesystem/encoder error or source path. It has no download URL.
An interrupted job is failed on the first read after restart; it is not replayed.
An expired job returns `410 EXPORT_EXPIRED`; an unavailable/failed/not-yet-ready
artifact cannot be downloaded. Exporting again is the recovery path.
