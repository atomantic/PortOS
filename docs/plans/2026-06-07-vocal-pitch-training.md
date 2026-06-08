# Vocal pitch-detection & sing-to-score training system

> Design record for the song-system extension tracked by umbrella issue
> [#1021](https://github.com/atomantic/PortOS/issues/1021). Point-in-time
> design — see the code and `CLAUDE.md` for current behavior.

## Context

PortOS already has a dependency-free song system: a hand-rolled SVG sheet-music
renderer (`client/src/components/songs/ScoreSheet.jsx`), a lead-sheet parser with
a clean diatonic pitch model (`client/src/lib/scoreNotation.js` →
`{ letter, accidental, octave, step }`), microphone recording
(`client/src/lib/audioRecorder.js` → 16 kHz mono WAV), sample-aligned layered
playback (`client/src/lib/songPlayback.js`), and per-take recordings stored on
each song (`server/services/songs.js`, `data/songs.json`). The song `tempo` (BPM)
field is **stored but not yet used** in playback.

What's missing is the loop between **sung human audio** and **the notated score**.
The goal is to turn the song system into a full song-writing and training tool to
memorize / learn / record:

1. **Color-match** — listen to the mic, match the sung pitch to the sheet-music
   notes, and color each note by how well it was hit (green / yellow / red).
2. **Sing-to-score** — live-draw / record notes by singing; transcribe a sung
   melody onto the staff.
3. **Metronome** — count-in, tempo reference, and rhythm quantization.
4. **Training mode** — tie it together with looping, scoring, and progress.

The guiding constraint is **no new heavy dependency**. PortOS's sheet-music stack
is deliberately library-free (no VexFlow / abcjs / OSMD), and the user's standing
preference is to limit new libraries. Pitch detection is a small, well-understood
algorithm (autocorrelation / YIN) that we vendor in-tree rather than pulling in a
DSP package.

## Architecture

```
pitch-detection core (#1022, foundation)
   ├── live tuner overlay (#1023)
   ├── color-match: score grades the singer (#1025)
   └── sing-to-score transcription (#1026)
metronome — shared timing grid (#1024)  ← consumed by #1025 and #1026
recording pitch persistence (#1027)
training mode on top (#1028)
```

The **pitch-detection core** and the **metronome** are the two foundations with no
internal dependencies and should land first. Everything else composes them with
the existing parser, renderer, and Web Audio plumbing.

### 1. Pitch-detection core (`client/src/lib/pitchDetect.js`) — #1022

The shared primitive. Pure-ish (no React), barrelled in `client/src/lib/index.js`
with a `README.md` row (the boot test enforces both).

- **Fundamental-frequency estimation** from a Float32 PCM frame via autocorrelation
  or YIN, returning a **clarity/confidence** score so noise and silence are
  rejected. Reuse the peak/silence intuition already in `audioRecorder.js` (which
  computes a per-take peak amplitude for its silence warning).
- **`frequencyToNote(hz, { a4 = 440 })`** → `{ letter, accidental, octave, step,
  cents }`. The `step` math mirrors `scoreNotation.js`'s diatonic step so a
  detected note lands on exactly the staff position the renderer would draw — this
  is what makes the color-match overlay align pixel-for-pixel. `a4` is a parameter
  now (default 440) so an alternate reference pitch is a later config change, not a
  refactor.
- **`noteToFrequency(note)`** — inverse, used by color-match to compute the target
  frequency for each notated note.
- **`createPitchTracker(analyserNode)`** — pulls frames on a rAF/interval loop and
  emits smoothed `{ hz, note, cents, clarity }`. Median + EMA smoothing suppresses
  the octave jumps that raw frame-by-frame detection produces on vocals.

### 2. Metronome (`client/src/lib/metronome.js`) — #1024

The shared timing grid. The first real consumer of the `tempo` field.

- Lookahead scheduler on a shared `AudioContext` clock — the same sample-accurate
  approach `songPlayback.js` uses (it notes that `<audio>` elements drift by tens
  of ms, so click scheduling must ride the audio clock, not `setInterval`).
- Time signature derived from the score header; accent on beat 1; count-in (e.g.
  one bar) before recording or color-match begins.
- Exposes a **beat-clock callback** that color-match (#1025) and sing-to-score
  quantization (#1026) both subscribe to, so all three features share one grid.
- UI: start/stop, BPM bounded 20–320 (matches the `tempo` Zod validation), visual
  beat pulse; mobile-responsive. Mountable in `SongRecordings.jsx` and the editor.

### 3. Live tuner (#1023)

A real-time tuner shown while recording. Taps an `AnalyserNode` off the **same**
`getUserMedia` stream `SongRecordings.jsx`/`audioRecorder.js` already open — never a
second mic stream. Drives `createPitchTracker` and renders the current note name
plus a cents needle/bar (green near 0¢, yellow/red as it drifts) using theme CSS
vars only. The analyser and rAF loop tear down on stop/unmount (the deferred-work
unmount guard from `CLAUDE.md`).

### 4. Color-match (#1025)

The headline feature.

- Build a **timeline** from `parseScore` output + the song `tempo`: each note's
  duration (in quarter-beats) converts to an onset time in ms.
- Walk a cursor through the notes in time — either live as the user sings, or while
  replaying a saved take. For the active note, compare the detected pitch (#1022)
  to the target (`noteToFrequency`) and color the notehead **green** (in tune),
  **yellow** (close), or **red** (off or missed).
- `ScoreSheet.jsx` gains an optional `noteColors` / `activeNoteIndex` prop path so
  the renderer stays pure and grading logic lives in a hook/lib. The color values
  remain theme tokens (`--port-success` / `--port-warning` / `--port-error`).
- Count-in via the metronome (#1024) so the singer knows where beat 1 is.
- Produce a per-take **accuracy summary** (% notes in tune) for training mode.

### 5. Sing-to-score (#1026)

Live-draw notes by singing.

- Run continuous pitch tracking over a sung passage, then **segment** the track
  into discrete notes: onset detection from pitch-stability + energy, note = median
  pitch over a stable segment, rests where clarity drops.
- **Quantize** durations to the metronome grid (#1024) at the song `tempo` (nearest
  whole/half/quarter/eighth/sixteenth), snapping onsets to beats — this is what
  turns a wobbly human take into clean notation.
- Choose enharmonic spelling from the key signature (reuse `SHARP_KEYS` /
  `FLAT_KEYS` from `scoreNotation.js`).
- Emit the lead-sheet DSL string (the exact text the score editor edits) for the
  user to review and insert (append or replace selection), with live preview via
  the existing parser → renderer round-trip.

### 6. Recording pitch persistence (#1027)

So tuner history and color-match results aren't recomputed on every open.

- Extend the `Recording` shape in `sanitizeSong` (`server/services/songs.js`) with
  optional analysis fields: a bounded, downsampled `pitchTrack`
  (`{ tMs, hz, cents, clarity }`) and/or an `accuracy` summary (% in tune +
  per-note grades).
- **Schema parity:** update the Zod schemas in `server/routes/songs.js` /
  `server/lib/validation.js` for both POST and PUT-partial, with array bounds
  following the existing `MAX_*` constants.
- **Migration:** add the next free `scripts/migrations/NNN-*.js`. It's a no-op
  backfill (fields are optional/absent-tolerant), but it must ship so the on-disk
  schema version is recorded and older clients don't 400 on the new shape — the
  distribution model is many installs upgrading independently (`CLAUDE.md` →
  Distribution model).

### 7. Training mode (#1028)

The capstone — a full memorize / learn / record loop.

- Practice loop UI: pick a section/layer, count-in (#1024), sing, get color-match
  feedback (#1025), see an accuracy score; repeat. Loop a single section or the
  whole song.
- Progress tracking: per-layer/per-section "learned" state + rolling accuracy
  history, building on the existing song `learned` flag and `layers[]`. A simple
  memorization progress view; optionally a lightweight spaced-repetition surfacing
  of the weakest sections.
- Optionally hide lyrics/notes progressively (sing from memory) as accuracy
  improves.
- Reuse `RoundStack.jsx` patterns if training rounds (multiple partner songs) is in
  scope. Persistence reuses #1027's fields; any new song-level progress field
  follows the same schema-parity + migration rules.

## Data model changes

All changes are additive and optional, so legacy `data/songs.json` records load
unchanged. On the `Recording` record (#1027):

```js
// optional, absent on legacy takes
pitchTrack: [{ tMs, hz, cents, clarity }],   // bounded, downsampled
accuracy:   { percentInTune, perNote: [grade...] }
```

A song-level progress field for training mode (#1028) follows the same pattern and
the same schema-parity + migration discipline.

## Cross-cutting rules (from `CLAUDE.md`)

- New client lib files (`pitchDetect.js`, `metronome.js`) are re-exported from
  `client/src/lib/index.js` and get a `README.md` row — the barrel boot test fails
  otherwise.
- Schema changes touch the sanitizer **and** the Zod schema (POST + PUT-partial) in
  the same change, plus a migration when the on-disk shape changes.
- Theme colors only — no hardcoded hex; the color-match grades map to
  `--port-success` / `--port-warning` / `--port-error`.
- Web Audio timing rides the shared `AudioContext` clock, never `setInterval`.
- Deferred work (rAF loops, scheduled clicks) tears down on stop/unmount.

## Verification

- **Unit (Vitest):**
  - `pitchDetect` — synthetic sine buffers at known Hz → correct note + octave;
    silence/noise → null; A4=440 and edge octaves; cents sign correctness.
  - `metronome` — tick interval from BPM/time-sig; count-in bar count; accent
    placement.
  - color-match — timeline math from a known score + tempo; grading thresholds;
    `ScoreSheet` renders passed colors (extend `ScoreSheet.test.jsx`).
  - sing-to-score — synthetic pitch tracks → expected note list; quantization
    snapping; emitted DSL re-parses cleanly through `parseScore` (mirror the seed
    round-trip test in `songs.test.js`).
  - persistence — sanitizer accepts/clamps new fields; legacy records still load;
    round-trip through route validation.
- **Manual (real mic + GPU/audio, not headless):** record a take with the tuner
  visible and confirm the needle tracks sung pitch; run color-match against a
  seeded song (e.g. "500 Miles") and confirm noteheads color in time with the
  count-in; sing a short phrase and confirm sing-to-score emits notation that
  renders back to the staff.
