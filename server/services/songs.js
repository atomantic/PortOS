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
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// --- Shape bounds (shared with routes/songs.js#songInputSchema) -------------
export const TITLE_MAX_LENGTH = 200;
export const ARTIST_MAX_LENGTH = 200;
export const KEY_MAX_LENGTH = 24;
export const FIELD_MAX_LENGTH = 4000;      // lyrics body / general notes
export const LABEL_MAX_LENGTH = 120;       // section + layer labels
export const PART_MAX_LENGTH = 60;         // layer voice (e.g. "Bass")
export const ID_MAX_LENGTH = 60;           // rhythm-shape / layer ids
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 320;
export const SECTIONS_MAX = 60;
export const LAYERS_MAX = 24;

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
    notes: trimField(raw.notes, FIELD_MAX_LENGTH),
    learned: raw.learned === true,
    sections: sanitizeList(raw.sections, sanitizeSection, SECTIONS_MAX),
    layers: sanitizeList(raw.layers, sanitizeLayer, LAYERS_MAX),
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
    notes: 'A travelling lament — keep it spacious and mournful. Sustain the vowels on the downbeats. Works beautifully with a soft hummed drone under the verses.',
    learned: false,
    sections: [
      { id: 'sec-verse-1', label: 'Verse 1', lyrics: 'If you miss the train I\'m on, you will know that I am gone\nYou can hear the whistle blow a hundred miles' },
      { id: 'sec-chorus', label: 'Chorus', lyrics: 'A hundred miles, a hundred miles, a hundred miles, a hundred miles\nYou can hear the whistle blow a hundred miles' },
    ],
    layers: [
      { id: 'lead', label: 'Lead melody', part: 'Soprano / Tenor', notes: 'The tune everyone knows. Lock this first, in tune, before stacking anything.' },
      { id: 'bass', label: 'Bass / root', part: 'Bass', notes: 'Root of each chord — C, A, F, G. Move slowly; you are the floor.' },
      { id: 'harmony-3rd', label: 'Harmony (third)', part: 'Alto', notes: 'A third under the melody. The first colour — keep it close and warm.' },
      { id: 'drone', label: 'Drone / pedal', part: 'Bass / Alto', notes: 'Optional held tonic (C) under the verse to make the lament feel ancient.' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

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
    for (const key of ['title', 'artist', 'key', 'tempo', 'rhythmShapeId', 'notation', 'notes', 'learned', 'sections', 'layers']) {
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
