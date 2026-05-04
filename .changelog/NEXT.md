# Unreleased Changes

## Fixed

- `update.sh` no longer hangs after "PortOS restarted" — the browser-open script now exits explicitly instead of waiting for Node's undici connection pool to drain.
- `update.sh` now kills the PM2 daemon (not just stops apps) before restarting, fixing crashes where a stale daemon cached a `ProcessContainerFork.js` path from a different project's Yarn PnP zip cache.
- Writers-room storyboard renders queued through Codex now wait their turn instead of erroring with "A Codex generation is already in progress" when you fire a second render before the first finishes. Codex jobs run on their own queue lane, so they don't block (and aren't blocked by) local image or video renders.

## Added

- Video Gen "Chunks" control (1–8) chains multiple LTX renders into a single longer clip. Each chunk's last frame seeds the next, then ffmpeg stitches them into one output. The individual chunks land in history hidden by default, so the gallery shows just the stitched result.
- Two new LTX-2.3 video models — "dgrauet Q4" and "dgrauet Q8" — running on a more capable runtime that supports true keyframe interpolation (proper FFLF that respects both start AND end frames), native video extend, and audio-to-video. Install with `INSTALL_LTX2=1 bash scripts/setup-image-video.sh`. The existing notapalindrome models keep working unchanged; pick the new "dgrauet" entries from the model dropdown to use the new pipeline. FFLF on these models has a stage-2 OOM ceiling — the server auto-clamps frame count to a memory-safe budget (override via `FFLF_LTX2_PIXEL_BUDGET` env var if you have more RAM than 48 GB).
- "Extend" mode on the new dgrauet runtime now uses a true latent video extension (conditions on the entire source video's motion + visual content) instead of last-frame i2v conditioning. The visible motion stall at scene boundaries is gone — extensions continue movement naturally from the source. Legacy notapalindrome models keep using the old chained-i2v workaround.
- New "Audio" mode in Video Gen renders a clip whose motion and on-screen audio sync to an uploaded audio track (WAV / MP3 / M4A). Pick the new mode tile, drop in a 4–8 second clip, write a directive prompt ("a person dancing to this track in a studio"), and the dgrauet runtime drives the video to the audio. Requires one of the new dgrauet models — legacy LTX models don't expose an audio-conditioned pipeline.

## Changed

- Video Gen FFLF mode now offers the same dual control on both the first-frame and last-frame slots — pick from your image gallery or upload a fresh image — instead of the previous upload-only first frame and gallery-only last frame.
- Release workflow no longer silently skips creating the GitHub Release when something else pushed the version tag before the workflow ran.
- Release-notes style guide tightened — entries should be one sentence per change in user-facing language, not code-review prose with file paths and internal symbols.
- Chief of Staff 3D avatars (Cyber, Sigil, Esoteric, Nexus, Muse) now fill the agent panel as a full-bleed background, with the title, status, and controls overlaying the scene instead of sharing a column with it.
- Autonomy level buttons in the CoS Config tab now use higher-contrast active states so the selected level is obvious at a glance.
