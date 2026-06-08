# Add built-in musical rounds + a cross-song "round stack" (quodlibet) view

## Context

The songs workbench (shipped in `9be5b79d`) currently seeds one built-in song, "500 Miles". The user wants to ship a set of **traditional musical rounds** as additional built-in songs — and, crucially, wants to treat them as *symbiotic, layerable elements*: a way to render multiple songs stacked together as simultaneous parts (a quodlibet / round-stack), since the user learned these four rounds sung all together.

Two deliverables:
1. **Four new built-in round songs** with notated melodies, lyrics, and canon-entry "layers".
2. **A cross-song layering mechanism** — songs can declare *partner songs* they sing with, and a read-only "round stack" view renders each partner's melody + lyrics stacked as simultaneous parts (and can play their recorded takes together).

### Lyric/spelling check (verified against canonical sources)

- **Hey, Ho! Nobody Home** (English round, Ravenscroft's *Pammelia*, 1609): `Hey, ho, nobody home, / Meat nor drink nor money have I none, / Still I will be merry. / Hey, ho, nobody home.` — user prefers the "Still I will be merry" variant; using that. It's a round in up to 6 voices.
- **Zum Gali Gali** (Israeli/Hebrew round): user's "zum gully gully" → **"Zum gali gali"**. `Zum gali gali gali, zum gali gali (×2) / He'chalutz le'man avodah, / Avodah le'man he'chalutz.` (*"The pioneer is for work; work is for the pioneer."*)
- **Rose, Rose, Rose, Red** (English round): user's spelling correct. `Rose, rose, rose, red, / Will I ever see thee wed? / I will marry at thy will, sire, / At thy will.`
- **Ah, Poor Bird** (English round) — ships **two lyric sections**:
  - *Canonical:* `Ah, poor bird, / Take thy flight, / Far above the sorrows / Of this sad night.`
  - *Alternate (as the user learned it):* `Oh, poor bird, why art thou / Hiding in the shadows / Of this dark house?` — added as a second labeled lyric section so both versions ship.

**Musical note:** Hey Ho + Ah Poor Bird + Rose Rose are the classic *quodlibet* trio — they share one minor-key chord cycle and can be sung simultaneously. Zum Gali Gali is a standalone round (i–V vamp); it's grouped with the others as a performance set per the user, but the notes will be honest that the trio is the harmonically-compatible set.

## Approach

### 1. New `partnerSongIds` field (the "symbiotic link")

Mirror the existing `references` array pattern end-to-end:

- **`server/services/songs.js`**: add `PARTNERS_MAX = 12`; in `sanitizeSong` add `partnerSongIds: sanitizePartnerIds(raw.partnerSongIds, id)` — a helper that keeps only non-empty strings (trim to `ID_MAX_LENGTH`), dedupes, and **drops self-references** (an id equal to the song's own id). Add `'partnerSongIds'` to the merge-key loop in `updateSong` and to the `refreshSongFromTemplate` template spread (it's part of template content).
- **`server/routes/songs.js`**: add `partnerSongIds: z.array(str(ID_MAX_LENGTH)).max(PARTNERS_MAX).optional()` to `songInputSchema` (import `PARTNERS_MAX`).
- Sanitize-on-read defaults it to `[]`, so the existing 500 Miles record needs **no migration** for the field itself.

### 2. Four new built-in round songs (`SEED_SONGS` in `server/services/songs.js`)

Append four entries after `seed-500-miles`. IDs: `seed-hey-ho-nobody-home`, `seed-ah-poor-bird`, `seed-rose-rose-rose-red`, `seed-zum-gali-gali`. Each carries:

- `title`, `artist: 'Traditional'`, `key`, `tempo`, `rhythmShapeId` (e.g. `rubato-free` / `slow-4-4`).
- **`score`**: the round's melody authored in the lead-sheet DSL (`client/src/lib/scoreNotation.js` format). Trio (Hey Ho, Ah Poor Bird, Rose Rose) notated in a **shared no-accidental A-minor** (written with the C key signature, tonic A) so they stack cleanly; Zum Gali Gali in D minor. Melodies authored from the canonical traditional tunes; **verified to parse with zero `errors` and render in `ScoreSheet`** before commit.
- **`sections`**: the corrected lyrics above, one section per round (multi-line). Ah Poor Bird gets **two** sections — "Verse" (canonical) and "Alternate (as learned)" with the user's "Oh, poor bird, why art thou…" version.
- **`layers`**: the canon *entries* — e.g. Hey Ho = 4 layers "Voice 1 (lead)" … "Voice 4 (enters 4th phrase)", each with a note on where it comes in. This reuses the existing `layers` concept for *within-song* staggered round entries (distinct from `partnerSongIds`, which is *across-song* simultaneity).
- **`partnerSongIds`**: each of the four links the other three (bidirectional by convention). `notes` explains the quodlibet trio vs. the standalone Zum Gali Gali honestly.
- `references`: none (left empty; user can add performance links).
- Fixed `createdAt`/`updatedAt` timestamps (string literals, matching the 500 Miles seed convention — scripts can't call `Date.now()`).

`BUILTIN_SONG_IDS` auto-derives from `SEED_SONGS`, so the new ids get the `builtIn` flag + refresh-from-template for free.

### 3. Backfill migration for existing installs

New `scripts/migrations/074-seed-musical-rounds.js`, mirroring `073-seed-500-miles-score.js`:
- Export `const ROUND_SEEDS = [...]` (the four full records).
- `up({ rootDir })`: if `data/songs.json` absent → no-op (fresh installs seed directly); if unparseable / unexpected shape → skip; otherwise for each round **prepend it only if its id isn't already present** (idempotent), bump nothing on skip, write back.
- Drift guard in the test: assert each `ROUND_SEEDS[i]` deep-equals the matching `SEED_SONGS` entry, so the migration copy and the live seed can't diverge (same pattern as `073` asserting `SCORE_500_MILES === seed.score`).

### 4. Cross-song "round stack" view (read-only)

New component **`client/src/components/songs/RoundStack.jsx`**:
- Props: `{ songs }` — the primary song + its resolved partner songs.
- Renders one labeled block per song: title + `<ScoreSheet text={song.score} />` (reused as-is — it's a pure render component) + that song's lyric sections, stacked vertically so all simultaneous parts are visible at once.
- A "Play all parts together" button that flattens every partner song's `recordings` into one `createLayeredPlayer(takes)` call (reusing `client/src/lib/songPlayback.js`) so recorded takes across songs play sample-aligned — the existing within-song mixer pattern, widened across songs.

Integration in **`client/src/pages/SongEditor.jsx`**:
- **ReadView**: when `song.partnerSongIds.length > 0`, show a "Sings with" list (links to each partner) and a **"Stack parts" toggle** controlled by a URL param (`?stack=1`, per the linkable-routes convention) that fetches the partner songs (`getSong` per id, or filter a single `listSongs`) and renders `<RoundStack>`.
- **EDIT mode**: a minimal "Sings with" editor — a checkbox list of the user's *other* songs to toggle membership; writes `partnerSongIds` through the normal Save (`updateSong`). Self is excluded from the list.

No new route/nav-manifest entry (the stack is a URL-param view on the existing `/songs/:id`), and `components/` has no barrel/README requirement (matches `ScoreSheet.jsx`).

## Critical files

- `server/services/songs.js` — `partnerSongIds` sanitizer + helper, four `SEED_SONGS` entries, merge-key + template-spread updates.
- `server/routes/songs.js` — `partnerSongIds` in `songInputSchema`.
- `scripts/migrations/074-seed-musical-rounds.js` (+ `.test.js`) — backfill + drift guard.
- `client/src/components/songs/RoundStack.jsx` (+ `.test.jsx`) — stacked multi-song render; reuses `ScoreSheet` + `createLayeredPlayer`.
- `client/src/pages/SongEditor.jsx` — "Sings with" read/edit UI + `?stack=1` partner fetch.
- Reused as-is: `client/src/components/songs/ScoreSheet.jsx`, `client/src/lib/scoreNotation.js`, `client/src/lib/songPlayback.js`, `client/src/services/apiSongs.js` (`getSong`/`listSongs`/`updateSong`).

## Tests

- `server/services/songs.test.js`: four new seeds present + `builtIn` true; `partnerSongIds` round-trips; self-reference dropped; dedupe; refresh-from-template restores partners.
- `server/routes/songs.test.js`: `partnerSongIds` accepted; over-`PARTNERS_MAX` / non-string array rejected (400).
- `scripts/migrations/074-seed-musical-rounds.test.js`: no-file no-op, fresh-prepend, idempotent re-run, never-clobber-existing, unparseable skip, **drift guard vs `SEED_SONGS`**.
- `client/src/lib/scoreNotation.test.js` (or a `ScoreSheet.test.jsx`): the four round score strings parse with `errors: []` and `scoreHasMusic === true` (DSL-validity guard for the authored melodies).
- `client/src/components/songs/RoundStack.test.jsx`: renders a `ScoreSheet` + lyrics per song; "Play all parts" gathers takes across songs.

## Verification (end-to-end)

1. `cd server && npm test` and `cd client && npm test` — all green, including the new migration drift guard and score-parse tests.
2. `npm run dev`; open `/songs` — confirm the four rounds appear with the "Built-in" badge.
3. Open **Hey Ho Nobody Home** in read mode — confirm the melody renders in `ScoreSheet`, lyrics + 4 canon-entry layers show, and a "Sings with" list links the other three.
4. Click **Stack parts** (`?stack=1`) — confirm all partner melodies + lyrics render stacked; the URL is shareable/linkable.
5. Record a quick take on two partner songs, hit **Play all parts together** — confirm they play layered/aligned.
6. Run a fresh-install simulation (temp `data/`, no `songs.json`) to confirm seeds appear without the migration, then run migration `074` against an old `songs.json` (only 500 Miles) and confirm the four rounds are prepended once and re-runs are no-ops.
7. Run `/simplify` on the diff before committing (per repo workflow).
