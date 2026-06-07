/**
 * Songs workbench
 *
 * Write, arrange, and learn a cappella songs (e.g. "500 Miles" by Peter, Paul
 * and Mary). Each song stores its key/tempo/rhythm-shape, lyric sections, and
 * the voice layers (lead / bass / harmony / drone / counter-melody) the user is
 * stacking — plus per-layer learning notes. Persisted to data/songs.json.
 *
 * Pure-ish CRUD over a single JSON file: PortOS is single-user (see CLAUDE.md
 * "Security Model"), so a per-file write queue serializes the read-modify-write
 * cycle rather than guarding against competing humans.
 *
 * Shape bounds are exported so routes/songs.js builds its Zod schema from the
 * same source — sanitize-on-read and validate-at-the-boundary agree by
 * construction. The rhythm-shape and layer id vocabularies mirror
 * client/src/lib/songCraft.js; unknown ids are accepted (free-text fallback)
 * so a client on a newer/older songCraft revision can't 400.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const STATE_PATH = join(PATHS.data, 'songs.json');

// Service errors carry a `code` field so routes map to HTTP status without
// string-matching on err.message (which breaks on rename).
export const ERR_NOT_FOUND = 'NOT_FOUND';
// Raised when a refresh-from-template is requested for a song that isn't a
// bundled built-in default (no shipped template to restore from).
export const ERR_NOT_BUILTIN = 'NOT_BUILTIN';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// --- Shape bounds (shared with routes/songs.js#songInputSchema) -------------
export const TITLE_MAX_LENGTH = 200;
export const ARTIST_MAX_LENGTH = 200;
export const KEY_MAX_LENGTH = 24;
export const FIELD_MAX_LENGTH = 4000;      // lyrics body / general notes
export const SCORE_MAX_LENGTH = 8000;      // sheet-music notation (lead-sheet DSL)
export const LABEL_MAX_LENGTH = 120;       // section + layer labels
export const PART_MAX_LENGTH = 60;         // layer voice (e.g. "Bass")
export const ID_MAX_LENGTH = 60;           // rhythm-shape / layer ids
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 320;
export const SECTIONS_MAX = 60;
export const LAYERS_MAX = 24;
export const RECORDINGS_MAX = 64;      // saved vocal takes for layered playback
export const REFERENCES_MAX = 12;      // reference links/videos (e.g. TikTok)
export const URL_MAX_LENGTH = 512;     // uploaded-file path/url

// Trim a string field, returning '' for non-strings. Mirrors the
// absent-vs-empty rule in CLAUDE.md: callers decide whether '' clears.
const trimField = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Clamp an integer tempo into the supported band; null when unparseable so a
// song without a tempo stays distinct from one pinned to a bound.
const sanitizeTempo = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(v)));
};

// One lyric/structure section ({ id, label, lyrics }). Label defaults from the
// id when blank so a section card is never headerless. Drops shapeless entries.
const sanitizeSection = (s) => {
  if (!s || typeof s !== 'object') return null;
  const label = trimField(s.label, LABEL_MAX_LENGTH);
  const lyrics = trimField(s.lyrics, FIELD_MAX_LENGTH);
  if (!label && !lyrics) return null;
  return {
    id: trimField(s.id, ID_MAX_LENGTH) || `sec-${randomUUID().slice(0, 8)}`,
    label: label || 'Section',
    lyrics,
  };
};

// One voice layer the user is arranging ({ id, label, part, notes }). `id`
// references a songCraft VOICE_LAYERS entry when known but is free-text-safe.
const sanitizeLayer = (l) => {
  if (!l || typeof l !== 'object') return null;
  const label = trimField(l.label, LABEL_MAX_LENGTH);
  const part = trimField(l.part, PART_MAX_LENGTH);
  const notes = trimField(l.notes, FIELD_MAX_LENGTH);
  if (!label && !part && !notes) return null;
  return {
    id: trimField(l.id, ID_MAX_LENGTH) || `layer-${randomUUID().slice(0, 8)}`,
    label: label || 'Layer',
    part,
    notes,
  };
};

// One saved vocal take ({ id, layerId, filename, label, durationMs, peak,
// mutedByDefault }). `filename` is the /api/uploads file name the audio is
// served from; a recording without one is meaningless, so it's dropped.
// `layerId` ties a take to a voice layer for the layered-playback mixer (free
// text — empty means "unassigned"). Numbers are coerced/clamped; bad values
// fall to sensible defaults rather than throwing.
const sanitizeRecording = (r) => {
  if (!r || typeof r !== 'object') return null;
  const filename = trimField(r.filename, URL_MAX_LENGTH);
  if (!filename) return null;
  const durationMs = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
    ? Math.max(0, Math.round(r.durationMs)) : 0;
  const peak = typeof r.peak === 'number' && Number.isFinite(r.peak)
    ? Math.max(0, Math.min(1, r.peak)) : 0;
  return {
    id: trimField(r.id, ID_MAX_LENGTH) || `rec-${randomUUID().slice(0, 8)}`,
    layerId: trimField(r.layerId, ID_MAX_LENGTH),
    label: trimField(r.label, LABEL_MAX_LENGTH),
    filename,
    durationMs,
    peak,
    muted: r.muted === true,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
  };
};

// One reference link/video ({ id, url, label, note }) — external study
// material for the song (a TikTok performance, a tutorial, a chord chart).
// `url` is required (a reference without a target is meaningless); label/note
// are free text. The client decides how to render each url (TikTok videos
// embed; everything else is a link).
const sanitizeReference = (r) => {
  if (!r || typeof r !== 'object') return null;
  const url = trimField(r.url, URL_MAX_LENGTH);
  // Require an http(s) scheme — defense-in-depth so a hand-edited file or a
  // non-PortOS writer can't persist a javascript:/data: URL that a renderer
  // might trust (mirrors the client's isHttpUrl guard).
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    id: trimField(r.id, ID_MAX_LENGTH) || `ref-${randomUUID().slice(0, 8)}`,
    url,
    label: trimField(r.label, LABEL_MAX_LENGTH),
    note: trimField(r.note, FIELD_MAX_LENGTH),
  };
};

const sanitizeList = (arr, fn, max) =>
  (Array.isArray(arr) ? arr : [])
    .map(fn)
    .filter(Boolean)
    .slice(0, max);

// Project a stored or inbound record onto the canonical song shape. Used on
// read (defends hand-edited JSON) and on write (normalizes the input).
export const sanitizeSong = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = trimField(raw.id, ID_MAX_LENGTH);
  if (!id) return null;
  return {
    id,
    title: trimField(raw.title, TITLE_MAX_LENGTH) || 'Untitled song',
    artist: trimField(raw.artist, ARTIST_MAX_LENGTH),
    key: trimField(raw.key, KEY_MAX_LENGTH),
    tempo: sanitizeTempo(raw.tempo),
    rhythmShapeId: trimField(raw.rhythmShapeId, ID_MAX_LENGTH),
    notation: trimField(raw.notation, FIELD_MAX_LENGTH),
    // Sheet-music notation in the PortOS lead-sheet DSL (client/src/lib/
    // scoreNotation.js). A bounded free-text string — the client parses + renders
    // it; the server only length-caps it, so a newer/older DSL revision can't 400.
    score: trimField(raw.score, SCORE_MAX_LENGTH),
    notes: trimField(raw.notes, FIELD_MAX_LENGTH),
    learned: raw.learned === true,
    sections: sanitizeList(raw.sections, sanitizeSection, SECTIONS_MAX),
    layers: sanitizeList(raw.layers, sanitizeLayer, LAYERS_MAX),
    recordings: sanitizeList(raw.recordings, sanitizeRecording, RECORDINGS_MAX),
    references: sanitizeList(raw.references, sanitizeReference, REFERENCES_MAX),
    // Derived from the shipped-seed id set, NOT from `raw` — so the flag can't
    // be lost on edit or spoofed on a hand-edited custom song. A built-in
    // default can be restored to its shipped content via refreshSongFromTemplate.
    builtIn: BUILTIN_SONG_IDS.has(id),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
};

// Seeded on first read so a fresh install opens on a worked example — the song
// the feature was designed around. Mirrors the dirge `slow-4-4` rhythm shape
// and the foundation-first layer ladder from songCraft.js.
export const SEED_SONGS = [
  {
    id: 'seed-500-miles',
    title: '500 Miles',
    artist: 'Peter, Paul and Mary',
    key: 'C major',
    tempo: 68,
    rhythmShapeId: 'slow-4-4',
    notation: 'Verse chords (key of C): C — Am — F — G, four slow bars per line. A gentle 4/4 ballad; let each line breathe across the bar rather than chopping it.',
    // Sheet music in the PortOS lead-sheet DSL — the verse melody with chords and
    // lyrics. A singable arrangement in C (edit it in the Sheet music tab); see
    // client/src/lib/scoreNotation.js for the format.
    score: [
      'clef: treble',
      'key: C',
      'time: 4/4',
      'tempo: 68',
      '',
      '| [C] E4q(If) G4q(you) G4q(miss) G4q(the) | [Am] A4h(train) G4q(I\'m) E4q(on) |',
      '| [F] F4q(You) A4q(will) A4q(know) A4q(that) | [C] G4h(I) E4q(am) C4q(gone) |',
      '| [F] F4q(You) A4q(can) A4q(hear) A4q(the) | [C] G4q(whis-) E4q(tle) C4h(blow) |',
      '| [G] D4q(A) F4q(hun-) G4q(dred) rq | [C] C4w(miles) |',
    ].join('\n'),
    notes: 'A travelling lament — keep it spacious and mournful. Sustain the vowels on the downbeats. Works beautifully with a soft hummed drone under the verses.',
    learned: false,
    sections: [
      { id: 'sec-verse-1', label: 'Verse 1', lyrics: 'If you miss the train I\'m on\nYou will know that I am gone\nYou can hear the whistle blow\nA hundred miles' },
      { id: 'sec-chorus-1', label: 'Chorus 1', lyrics: 'A hundred miles\nA hundred miles\nA hundred miles\nA hundred miles\nA hundred miles\nYou can hear the whistle blow a hundred miles' },
      { id: 'sec-verse-2', label: 'Verse 2', lyrics: 'Lord, I\'m one\nLord, I\'m two\nLord, I\'m three\nLord, I\'m four\nLord, I\'m five hundred miles from my home' },
      { id: 'sec-chorus-2', label: 'Chorus 2', lyrics: 'Five hundred miles\nFive hundred miles\nFive hundred miles\nFive hundred miles\nLord, I\'m five hundred miles from my home' },
      { id: 'sec-verse-3', label: 'Verse 3', lyrics: 'Not a shirt on my back\nNot a penny to my name\nLord, I can\'t go home\nThis a-way' },
      { id: 'sec-chorus-3', label: 'Chorus 3', lyrics: 'This a-way\nThis a-way\nThis a-way\nThis a-way\nThis a-way\nLord, I can\'t go home this a-way' },
      { id: 'sec-verse-4', label: 'Verse 4 (reprise)', lyrics: 'If you miss the train I\'m on\nYou will know that I am gone\nYou can hear the whistle blow a hundred miles' },
    ],
    layers: [
      { id: 'lead', label: 'Lead melody', part: 'Soprano / Tenor', notes: 'The tune everyone knows. Lock this first, in tune, before stacking anything.' },
      { id: 'bass', label: 'Bass / root', part: 'Bass', notes: 'Root of each chord — C, A, F, G. Move slowly; you are the floor.' },
      { id: 'harmony-3rd', label: 'Harmony (third)', part: 'Alto', notes: 'A third under the melody. The first colour — keep it close and warm.' },
      { id: 'drone', label: 'Drone / pedal', part: 'Bass / Alto', notes: 'Optional held tonic (C) under the verse to make the lament feel ancient.' },
    ],
    references: [
      { id: 'ref-tt-marie', url: 'https://www.tiktok.com/@marie.celestinee/video/7638358831205977376', label: 'TikTok · @marie.celestinee', note: 'Reference performance.' },
      { id: 'ref-tt-eric', url: 'https://www.tiktok.com/@ericolsith/video/7633158760659176718', label: 'TikTok · @ericolsith', note: 'Reference performance.' },
      { id: 'ref-tt-eric-2', url: 'https://www.tiktok.com/@ericolsith/video/7647221045618887949', label: 'TikTok · @ericolsith', note: 'Reference performance.' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

// Ids of the bundled built-in default songs. The sanitizer stamps each read
// song with `builtIn` from this set, and refreshSongFromTemplate restores a
// built-in's shipped content from the matching SEED_SONGS entry. A user who
// already has the song installed (older shipped lyrics) renews it on demand.
export const BUILTIN_SONG_IDS = new Set(SEED_SONGS.map((s) => s.id));
const seedTemplate = (id) => SEED_SONGS.find((s) => s.id === id) || null;

// Serialize the read-modify-write cycle so two mutations issued back-to-back
// (e.g. a rename PUT followed by a layer edit) each merge against the freshest
// persisted state instead of racing on a stale snapshot. Single-user, so this
// is re-entrancy hygiene, not a multi-actor lock (see CLAUDE.md Security Model).
const enqueue = createFileWriteQueue();

// Pure read + sanitize — NO write side effect. When the file is absent or
// malformed, returns the seed in-memory without persisting it. Mutations call
// this inside their enqueue() so the read-modify-write cycle never re-enters
// the queue (which would deadlock).
async function readSongs() {
  const state = await readJSONFile(STATE_PATH, null, { allowArray: false });
  if (!state || !Array.isArray(state.songs)) {
    return SEED_SONGS.map(sanitizeSong).filter(Boolean);
  }
  return state.songs.map(sanitizeSong).filter(Boolean);
}

// Public read. On first read (file absent) it persists the seed so the example
// is stable and editable — but the seed write is routed through the SAME queue
// as mutations and re-checks inside the queue, so a create that landed first
// can't be clobbered by a late seed write (read-path lazy-init race).
export async function listSongs() {
  const state = await readJSONFile(STATE_PATH, null, { allowArray: false });
  if (state && Array.isArray(state.songs)) {
    return state.songs.map(sanitizeSong).filter(Boolean);
  }
  return enqueue(async () => {
    // Re-check inside the queue: a queued create may have already written the
    // file (with seed + new song). If so, don't overwrite it with bare seed.
    const fresh = await readJSONFile(STATE_PATH, null, { allowArray: false });
    if (fresh && Array.isArray(fresh.songs)) {
      return fresh.songs.map(sanitizeSong).filter(Boolean);
    }
    const seeded = SEED_SONGS.map(sanitizeSong).filter(Boolean);
    await atomicWrite(STATE_PATH, { songs: seeded });
    return seeded;
  });
}

export async function getSong(id) {
  const songs = await listSongs();
  return songs.find((s) => s.id === id) || null;
}

export async function createSong(input) {
  return enqueue(async () => {
    const songs = await readSongs();
    const now = new Date().toISOString();
    const song = sanitizeSong({ ...input, id: `song-${randomUUID()}`, createdAt: now, updatedAt: now });
    songs.unshift(song);
    await atomicWrite(STATE_PATH, { songs });
    console.log(`🎵 Created song "${song.title}" (${song.id})`);
    return song;
  });
}

export async function updateSong(id, patch) {
  return enqueue(async () => {
    const songs = await readSongs();
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) throw makeErr(`Song ${id} not found`, ERR_NOT_FOUND);
    // Merge field-by-field so an absent key preserves the stored value while a
    // present key (including empty string / empty array) applies the change.
    const merged = { ...songs[idx] };
    for (const key of ['title', 'artist', 'key', 'tempo', 'rhythmShapeId', 'notation', 'score', 'notes', 'learned', 'sections', 'layers', 'recordings', 'references']) {
      if (key in patch) merged[key] = patch[key];
    }
    merged.id = id;
    merged.createdAt = songs[idx].createdAt;
    merged.updatedAt = new Date().toISOString();
    const song = sanitizeSong(merged);
    songs[idx] = song;
    await atomicWrite(STATE_PATH, { songs });
    console.log(`🎵 Updated song "${song.title}" (${id})`);
    return song;
  });
}

// Restore a built-in default song's shipped content (metadata, lyrics, layers,
// notation, notes) to the current bundled template — for installs that seeded
// an older version of the song and want the newer shipped one. User-owned state
// is preserved: their recorded takes, their `learned` progress, and the
// original createdAt. Throws ERR_NOT_BUILTIN for a non-default song.
export async function refreshSongFromTemplate(id) {
  return enqueue(async () => {
    const songs = await readSongs();
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) throw makeErr(`Song ${id} not found`, ERR_NOT_FOUND);
    const template = seedTemplate(id);
    if (!template) throw makeErr(`Song ${id} is not a built-in default`, ERR_NOT_BUILTIN);
    const existing = songs[idx];
    // Resetting layers to the template set can orphan a recording assigned to a
    // user-added layer the template doesn't define — unassign those so the
    // mixer doesn't reference a layer that no longer exists (the take still plays).
    const templateLayerIds = new Set((template.layers || []).map((l) => l.id));
    const recordings = (existing.recordings || []).map((r) => (
      r.layerId && !templateLayerIds.has(r.layerId) ? { ...r, layerId: '' } : r
    ));
    const song = sanitizeSong({
      ...template,
      id,
      learned: existing.learned,
      recordings,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    songs[idx] = song;
    await atomicWrite(STATE_PATH, { songs });
    console.log(`🔄 Refreshed built-in song "${song.title}" (${id}) from template`);
    return song;
  });
}

export async function deleteSong(id) {
  return enqueue(async () => {
    const songs = await readSongs();
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) throw makeErr(`Song ${id} not found`, ERR_NOT_FOUND);
    const [removed] = songs.splice(idx, 1);
    await atomicWrite(STATE_PATH, { songs });
    console.log(`🗑️ Deleted song "${removed.title}" (${id})`);
    return { id };
  });
}
