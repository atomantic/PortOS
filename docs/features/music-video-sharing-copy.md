# Music Video private sharing copy

Music Video → Review & Export → Final render offers **Prepare sharing copy**.
When ready, **Download sharing copy** shows the measured dimensions, frame rate
and byte size. The existing full-quality MP4 download remains available.
This action downloads locally; it does not send messages or publish anything.

The local `video-sharing` media job uses the existing durable queue, maintenance
admission, supervised child processes, SSE status, cancellation and boot cleanup.
Reloading reattaches to an active job. After a connection failure, **Check export**
recovers the saved result or reconnects. Repeated requests reuse the active job
or verified saved copy. Cancellation remains pending until process settlement;
once file publication starts it is refused as already finishing.

The export uses two-pass H.264 with AAC at 128 kbps, at most 1280×720, preserves
aspect ratio and frame rates up to 60 fps, and never upscales. A duration-based
95 MB stream budget reserves room for container overhead. An oversized result
gets one retry at a lower bitrate. Only a full-length file strictly below
100,000,000 bytes is offered; failed or cancelled work removes partial files.
Encoding uses two threads and a 30-minute timeout per pass. Sources over one
hour, unreadable sources and duration budgets below the minimum usable bitrate
are refused with an actionable error.

The server resolves only the project's selected final history entry, refuses
symlinks and unsafe filenames, and binds the copy to its history ID and SHA-256.
The copy's own hash and size are verified before reuse/download. Selecting a
new final or changing the existing final's bytes invalidates it. No original
file or history entry is overwritten. Publishing-kit metadata stores the result
on the existing project record; missing files on another machine are cache misses.

API:

- `GET /api/music-video/:id/sharing-copy` — verified `copy` or null, plus active
  `jobId`/`status` when present.
- `POST /api/music-video/:id/sharing-copy` — return a cached copy, reuse an active
  job or enqueue a new job. No arbitrary path, codec or process arguments are accepted.
- `GET /api/music-video/:id/sharing-copy/download` — source-validated attachment;
  stale/missing copies return a conflict requiring a new preparation.
- Existing `/api/video-gen/:jobId/events` and `/api/media-jobs/:jobId/cancel`
  provide the media queue's SSE and cancellation contracts.

There is no native cache-registration endpoint for externally prepared MP4s.
Development-file uploads retain their existing media policy and do not register
a sharing derivative or replace the canonical final.
