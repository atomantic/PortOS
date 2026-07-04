# Rounds: yt-dlp "Download audio from URL" for references (#2120)

**Approved:** 2026-07-04

## Goal

Add the deferred convenience path from #2106: on a round *reference* (e.g. a
layered TikTok performance), let the user paste a URL and have PortOS download +
extract its audio via `yt-dlp`, landing the file in the uploads dir so it can be
attached and analyzed like an uploaded/mic-captured recording. Upload and mic
capture remain the primary paths; this is best-effort.

## Key discovery — reuse, don't rebuild

The yt-dlp + audio-extraction + SSE-progress machinery already exists for the
YouTube **track** import (#1945): `server/lib/ytdlp.js` (`findYtDlp`),
`server/services/trackYoutubeImport.js`, `server/lib/sseUtils.js`,
`server/lib/killWithEscalation.js`. #2120's operation is nearly identical,
differing only in:

1. **URL scope** — any public http(s) URL + SSRF guard (not YouTube-only).
2. **Output** — land in `PATHS.uploads` and return a `filename` (not the music
   library + a Track record).

## Design (approved decisions)

- **Progress UX:** SSE streaming progress (mirrors the LoRA/track import), not a
  blocking spinner.
- **URL scope:** any public http(s) URL; `assertPublicHttpUrl(url, { blockPrivate: true })`
  from `safeUrlFetch.js` rejects private/loopback/metadata hosts. yt-dlp decides
  what it can actually extract; a failure degrades to a clear error.
- **Reuse strategy:** extract the shared yt-dlp download core and refactor the
  track import to use it (DRY; the track path has test coverage so the refactor
  is verifiable).

### Components

1. **`server/services/ytdlpAudioImport.js`** (new, shared core) — binary
   discovery/assert, arg construction, `--progress-template` parsing, spawn,
   cancel-aware exit classification, temp cleanup. Returns
   `{ outcome, outPath, title, reason }`; SSE + post-processing stay with the
   caller. `trackYoutubeImport.js` refactored to call it.
2. **`server/lib/fileUtils.js`** — new `importFileToUploads(tempPath, originalName)`
   (copyFile+unlink cross-device-safe, `uuid8-sanitizedName`, mirrors the
   `/api/uploads` naming). Registered in the lib barrel + README.
3. **`server/services/roundReferenceAudioImport.js`** (new) — SSRF-guarded
   `startReferenceAudioImport(url)` job that runs the core, lands the mp3 via
   `importFileToUploads`, and streams `{ type:'complete', filename }`. Plus
   attach/cancel SSE helpers.
4. **`server/routes/rounds.js`** — `POST /reference-audio/import`,
   `GET /reference-audio/import/:jobId/events`,
   `POST /reference-audio/import/:jobId/cancel` (placed before `/:id`).
5. **Client** — `apiRounds.js` wrappers, a `useReferenceAudioImport` hook
   (mirrors `useYoutubeTrackImport`), and a "Download from URL" control in
   `ReferenceAudioAttach` (`ReferenceAnalysis.jsx`) that sets `audioFilename`
   via the existing `onUpdate` path on completion.

### Bounds / safety

- `execFile`/`spawn` with a fixed arg array (no shell) — the yt-dlp binary is the
  only command, args never interpolate through a shell.
- `--max-filesize` / `--match-filters duration<=…` cap resource use (its own
  uploads-appropriate bounds).
- Binary-missing → `409`/`500` with an actionable "install yt-dlp/ffmpeg" message.

## Tests

- Shared core: URL/arg invariants; happy path + failure with mocked `spawn`.
- `roundReferenceAudioImport`: SSRF rejection; happy path lands a filename.
- Rounds route: kickoff + SSE attach + cancel.
- Re-run `trackYoutubeImport.test.js` (no regression) and `lib/index.test.js`
  (barrel).
