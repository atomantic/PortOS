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

This core version explicitly refuses `includePlayer:true`,
`includeCharacters:true`, `includeVoice:true` and media profiles other than
`"source"`. Their implementation belongs to the linked export slices.

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
yuv420p / optional AAC MP4 without re-encoding picture/audio samples. Other codecs,
animated stills, resizing, bitrate profiles and loudness normalization are not
supported yet. Embedded container metadata, H.264 user-data SEI, chapters and extra tracks are
removed; authored source files remain unchanged.

## Package schema 1.0.0

- `manifest.json`: export schema, playback runtime and PortOS versions; explicit
  authored metadata, ordered episodes, reachable graphs and playback roles.
  Media uses only content hashes and relative `media/<sha256>.<ext>` references,
  with `durationMs`, `loopable` and projected audio occupancy.
- `provenance.json`: per-use content hash, provider/model labels, parameter hash,
  approval and conditioning status, and draft flags.
- `media/`: deduplicated, metadata-free media.
- `runtime-v1.md` and `README.md`: the versioned playback and hosting contracts.

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

A failed job exposes an actionable code/message and its preflight findings,
never a raw filesystem/encoder error or source path. It has no download URL.
An interrupted job is failed on the first read after restart; it is not replayed.
An expired job returns `410 EXPORT_EXPIRED`; an unavailable/failed/not-yet-ready
artifact cannot be downloaded. Exporting again is the recovery path.
