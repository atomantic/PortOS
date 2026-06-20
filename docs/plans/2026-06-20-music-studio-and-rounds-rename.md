# Rename Songs→Rounds + new Music studio (Artists, Albums, Tracks, Ace-Step gen)

## Context

The **Songs** page (`/songs`) is an a cappella composition/learning workbench (rounds, harmony parts,
recordings, score notation) backed by `data/songs.json` + `/api/songs` + `server/services/songs.js`. Its
real subject is musical *rounds*, so we're renaming it to **Rounds** (full-stack, per user decision).

Separately we want a new **Music** studio under the *Create* section for generating music with local
OSS tools (Ace-Step first; room for Google Music / ElevenLabs / Suno later), organized into
**tracks/singles** and **albums**, each with **album art** (AI-generated via the existing image-gen
options *or* uploaded) and a **designing artist** persona managed like Authors.

Key discovery: PortOS already has most of the music backbone — `server/services/pipeline/musicGen.js`
(engine-agnostic `ENGINES` registry: `musicgen` + `audioldm2`, sidecar+venv gated, `generateMusic()`),
`server/services/pipeline/musicLibrary.js` (`data/music/` shared library), venv provisioning in
`scripts/setup-image-video.sh` + `server/lib/pythonSetup.js`, and the `imageGen/` provider-dispatcher
for album art. **Authors** (`server/services/authors/{index,logic,db,file}.js`) is the exact db-primary,
federated, soft-delete template to mirror for Artists/Albums/Tracks. So this is mostly *composition of
existing patterns*, not green-field.

**Delivery: phased — 4 sequenced PRs off this branch**, each independently reviewable/shippable.

---

## Phase 1 — Songs → Rounds full-stack rename (PR 1)

Full-stack rename incl. data file + API. Songs are **not federated today** (absent from
`schemaVersions.js`, `peerSync.js`), so the rename has **zero cross-install sync surface** — no
`schemaVersions` bump needed (we keep Rounds local-only, matching Songs today).

**Data migration** — new `scripts/migrations/0NN-rename-songs-to-rounds-data.js`, modeled on
`scripts/migrations/031-world-to-universe-data-rename.js` (idempotent: skip if already migrated, warn if
both files exist):
- `data/songs.json` → `data/rounds.json`
- top-level key `songs[]` → `rounds[]`
- grep for cross-file refs (`songId`, partner song ids, dashboard widget refs) and rewrite
- add a `.test.js` beside it (migrations carry tests here, e.g. `074-*.test.js`)

**Server rename:**
- `server/services/songs.js` → `rounds.js` (`STATE_PATH` → `data/rounds.json`; rename exported
  identifiers `listSongs`→`listRounds`, etc., keep bounds constants)
- `server/services/songsAI.js` → `roundsAI.js`
- `server/routes/songs.js` → `routes/rounds.js` (mount `/api/rounds` in `server/index.js:547`)
- `server/lib/songCraftRef.js` → `roundCraftRef.js` (consumed by guide)
- nav manifest `server/lib/navManifest.js:34-35`: `nav.create.songs`→`nav.create.rounds`,
  `/songs`→`/rounds`, label `Songs`→`Rounds`, update aliases/keywords
- rename `*.test.js` siblings; update migrations `073-079,086` imports (`services/songs.js`→`rounds.js`)

**Client rename:**
- `pages/Songs.jsx`→`Rounds.jsx`, `SongEditor.jsx`→`RoundEditor.jsx`, `SongsGuide.jsx`→`RoundsGuide.jsx`
- `services/apiSongs.js`→`apiRounds.js` (paths `/songs`→`/rounds`, fn names), update `services/api.js:53`
- `App.jsx:52-54,295-297` lazy imports + routes (`/songs*`→`/rounds*`)
- `Layout.jsx:209` sidebar link + `:1134` full-width prefix `/songs/`→`/rounds/`
- `components/songs/` dir + `lib/song*.js` + `hooks/useSongTraining.js`: keep internal names to limit
  churn, but rename the *page-facing* pieces and `/songs/:id` links in `RoundStack.jsx`, `RoundEditor`,
  `RoundsGuide`. (Component-internal "song" vocabulary may stay — user-facing label/route is the contract.)

**Verify:** `cd server && npm test`; `cd client && npm test`; boot (`npm run dev`), confirm `/rounds`
loads, create/edit/delete a round, `/rounds/guide` renders, ⌘K "rounds" navigates, and a fresh boot
runs the migration (rename a copy of `data/songs.json` back and watch it convert). Grep for stray
`/songs` / `Songs` references.

---

## Phase 2 — Music page shell + Artist management (PR 2)

New **Music** page under *Create* + **Artists** (designing-artist personas), mirroring **Authors** 1:1.

**Artists entity (db-primary, federated — mirror `server/services/authors/`):**
- `server/services/artists/{logic,db,file,index}.js` — copy authors, id `artist-<uuid>`; fields:
  `name`, `bio`, `genre`, `musicalStyle` (voice/production notes for gen prompts),
  `physicalDescription` + `portraitStyle` (for portrait render), `portraitImageUrl` (gen/upload/gallery).
  Reuse `logic.js` sanitize/build/patch/merge shapes verbatim.
- Postgres `artists` table: add DDL to `server/scripts/init-db.sql` (after authors ~768) **and**
  `ensureSchema()` in `server/lib/db.js` (~946) — same `id/name/data JSONB/timestamps/deleted` shape +
  `idx_artists_live`.
- `server/routes/artists.js` (mirror `routes/authors.js`); mount in `server/index.js`.
- **Federation registration** (mirror the author touch-points found in exploration):
  `schemaVersions.js` (`PORTOS_SCHEMA_VERSIONS.artists:1`, `RECORD_KIND_SCHEMA_CATEGORIES.artist`),
  `peerSync.js` (`PEER_SUBSCRIBABLE_KINDS`, `KIND_TO_CATEGORY`, merge handler, asset manifest for
  portrait, syncability), `syncWire.js` sanitizer case, tombstone GC sweep. Auto-subscribe on create.
- `client/src/services/apiArtists.js` (mirror `apiAuthors.js`, re-export from `api.js`).

**Music page + Artist UI:**
- `client/src/pages/Music.jsx` — landing/studio: tabs or sections for **Artists**, **Albums**, **Tracks**
  (URL-param routed per convention, e.g. `/music/artists`, not local tab state). Start with the Artists
  tab fully working; Albums/Tracks land in Phase 3.
- Artist editor: master-detail copy of `pages/Authors.jsx` (portrait via `generateImage` /
  `uploadGalleryImage` / `GalleryImagePicker`, `useMediaJobProgress`, `buildHeadshotPrompt`→
  `buildPortraitPrompt`). Reuse `components/pipeline/AuthorPicker.jsx` → new `ArtistPicker.jsx`.
- Nav: add `App.jsx` routes, `Layout.jsx` *Create* sidebar link (alphabetical: "Music" sits between
  "Mood Boards" and "Series Pipeline"), and `NAV_COMMANDS` entries in `navManifest.js`
  (`nav.create.music`, `nav.create.music-artists`, …).

**Verify:** `server`+`client` tests (add `artists/*.test.js`, `routes/artists.test.js` mirroring
authors); boot, create an Artist, generate + upload a portrait, ⌘K "music"/"artists" navigates,
`navManifest.test.js` + `palette.test.js` green.

---

## Phase 3 — Albums + Tracks data model, album art, library + playback (PR 3)

**Albums & Tracks (db-primary, federated — same authors template):**
- `server/services/albums/` — id `album-<uuid>`; fields: `title`, `artistId` (FK) + `artist`
  (denormalized name, like series→author), `description`, `genre`, `releaseYear`, `coverImageUrl`
  (gen/upload), `trackIds[]` (ordered). DDL + ensureSchema + routes + federation (cover image as synced
  asset) + `apiAlbums.js`.
- `server/services/tracks/` — id `track-<uuid>`; fields: `title`, `albumId?` (null = single), `artistId`,
  `lyrics`, `prompt`, `engine`, `modelId`, `durationSec`, `audioFilename` (points into `data/music/`
  via `musicLibrary.js`), `order`. DDL + ensureSchema + routes + federation (audio file as synced asset,
  mirroring author headshot-filename asset path) + `apiTracks.js`.
- Reuse `server/services/pipeline/musicLibrary.js` for the actual audio files (`data/music/`); tracks
  store the library filename, not bytes.

**Album art** — reuse image-gen wholesale: `/image-gen/generate` (cover prompt from album
title+genre+artist style, e.g. 1024×1024) and `/image-gen/upload` + `GalleryImagePicker`, storing
`coverImageUrl` exactly like author headshots. No new image infra.

**Album/Track UI (in `Music.jsx`):** album grid + detail (cover, artist via `ArtistPicker`, ordered
track list, add/reorder/remove), track editor (title/lyrics/prompt/engine/duration + audio player).
Reuse `formatTimecode`/`formatDurationMs` from `client/src/utils/formatters.js`, `useLockToggle`,
existing audio `<audio>` playback pattern from AudioStage. Upload audio via the `/api/uploads` or
music-library upload path.

**Verify:** tests for albums/tracks services+routes; boot, create an album under an artist, generate +
upload cover art, add tracks (upload an mp3/wav), reorder, play back in-page; confirm album/track
records federate (asset manifest includes cover + audio).

---

## Phase 4 — Ace-Step engine + real generation wired to Tracks (PR 4)

Add **Ace-Step** as a third `ENGINES` entry in `server/services/pipeline/musicGen.js` — the registry is
already engine-agnostic, so this is additive. Ace-Step is full-song (prompt **+ lyrics + duration**),
richer than the background-music sidecars, so extend the sidecar contract with an optional `--lyrics`
flag (musicgen/audioldm2 ignore it).

- **Python sidecar** `scripts/generate_acestep.py` — mirror `generate_musicgen.py`/`generate_audioldm2.py`
  contract: `--model --text [--lyrics] --duration --output --runtime-dir`, emit `STAGE:` progress lines
  + final `RESULT:{json}` (path, durationSec), write WAV to `--output`. Ace-Step supports Apple Silicon
  (MPS) per upstream (https://github.com/ace-step/ACE-Step-1.5).
- **Venv provisioning** — add `INSTALL_ACESTEP=1` block to `scripts/setup-image-video.sh`
  (clone `ace-step/ACE-Step-1.5`, create `~/.portos/venv-acestep`, pip install its requirements, model
  weights lazy-download on first run via HF, gated by `hfTokenEnv()`), and resolver constants in
  `server/lib/pythonSetup.js` (`ACESTEP_VENV_*`, `ACESTEP_RUNTIME_DIR`, `resolveAcestepPython`).
- **Registry entry** in `musicGen.js`: `ENGINES.acestep` (models/duration window/scriptPath/resolver/
  installEnv `INSTALL_ACESTEP`). `generateMusic({ engine:'acestep', prompt, lyrics, durationSec })`
  works through the existing gate (503 with install hint when venv missing — exactly like FLUX.2).
  Thread `lyrics` through `buildSidecarArgs`.
- **Standalone generation route** — new `server/routes/music.js` `POST /api/music/generate` (the pipeline
  path is audio-stage-internal; the Music studio needs its own). Calls `generateMusic`, lands the WAV in
  `musicLibrary`, and on success creates/updates a **Track** with the engine/model/lyrics/prompt
  metadata + `audioFilename`. Long renders: reuse `mediaJobQueue` (new `kind:'music'`) for async + SSE
  progress, mirroring image-gen — or run inline with the existing AbortSignal cancel if acceptable.
- **UI** in the Track editor: engine picker (musicgen/audioldm2/acestep), readiness gate via
  `isEngineReady`/a `/api/music/engines` status endpoint (show "Run `INSTALL_ACESTEP=1 …`" hint when not
  provisioned), prompt+lyrics+duration inputs, Generate button → SSE progress → attach audio to track.

**Verify:** unit-test `buildSidecarArgs` lyrics threading + engine registry (no Python needed, like
`musicGen.test.js`); on the M5 Max box (128GB) run `INSTALL_ACESTEP=1 bash scripts/setup-image-video.sh`,
generate a real short track from the Music page, confirm WAV lands in `data/music/`, plays back, and the
Track record persists with correct metadata. Confirm graceful 503 + install hint when venv absent.

---

## Cross-cutting notes

- **CLAUDE.md compliance:** every new `apiX.js`/lib module → barrel `index.js` + `README.md` row (enforced
  by `index.test.js`); all route inputs Zod-validated (POST + PUT/PATCH `.partial()`); new pages → both
  `<Route>` **and** `NAV_COMMANDS`; sidebar stays alphabetical; new entities follow `docs/STORAGE.md`
  db-primary classification (Postgres, not new `data/*.json`); schema parity when adding fields.
- **Tests:** never run `*.db.test.js` against real `portos` DB — use `npm run test:db` (→ `portos_test`).
  Mirror authors' `file.js` backend so service tests run without Postgres.
- **Federation schemaVersions:** Artists/Albums/Tracks each get their own per-category gate (`artists`,
  `albums`, `tracks`) so a newer peer can't corrupt an older one; follow the authors `v1` precedent
  comment block in `schemaVersions.js`.
- **Run `/simplify`** after each phase's substantive work; commit + open PR per phase (rebase-merge, no
  squash, no AI attribution per global instructions).
- **Defer/PLAN.md:** future engines (Google Music/ElevenLabs/Suno as `external` HTTP providers mirroring
  `imageGen/external.js`) are explicitly out of scope here — capture as a PLAN.md item after Phase 4.
