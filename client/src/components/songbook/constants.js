// Shared SongBook constants — learning-stage progression, stage chip colors,
// the practice-grade vocabulary, and the instrument list (mirrors the enums in
// server/lib/brainValidation.js and the ladder in server/lib/songPractice.js).

export const SONG_STAGES = [
  { id: 'new', label: 'New' },
  { id: 'learning', label: 'Learning' },
  { id: 'learned', label: 'Learned' },
  { id: 'memorized', label: 'Memorized' },
];

// Tailwind chip classes per stage (STATUS_COLORS style: bg tint + text + border).
export const SONG_STAGE_COLORS = {
  new: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  learning: 'bg-port-warning/20 text-port-warning border-port-warning/30',
  learned: 'bg-port-accent/20 text-port-accent border-port-accent/30',
  memorized: 'bg-port-success/20 text-port-success border-port-success/30',
};

// =============================================================================
// PRACTICE (spaced repetition, #4102)
// =============================================================================

// The grades offered for a practice run, in the order the buttons render.
// `quality` is the SM-2 self-grade the server schedules on (0..5); the four
// rungs are the Anki-style shorthand for the ones that mean something here —
// the intermediate grades (1, 2) all regress, and 5 vs 4 differ only in how far
// the interval steps. Mirrors SONG_PROMOTE_MIN_QUALITY (4) and
// SONG_REGRESS_MAX_QUALITY (2) in server/lib/songPractice.js; parity is
// asserted in constants.test.js.
export const SONG_PRACTICE_RATINGS = [
  { quality: 0, label: 'Struggled', hint: 'Fell apart — regress a stage and practice again today' },
  { quality: 3, label: 'Rough', hint: 'Got through it — hold the stage, review sooner' },
  { quality: 4, label: 'Solid', hint: 'Played it with hesitation — advance a stage' },
  { quality: 5, label: 'Clean', hint: 'Played it clean — advance a stage, review later' },
];

// Read the song's practice schedule the same way the server does: absent (a
// song predating the feature, or one never practiced) derives an anchor from
// the record itself rather than collapsing into "due at this instant", so the
// answer doesn't flap between renders. Mirrors `songPracticeOrDefault` in
// server/lib/songPractice.js.
export const songNextReviewAt = (song) => {
  const nextReview = song?.practice?.nextReview;
  if (typeof nextReview === 'string') return nextReview;
  return song?.updatedAt || song?.createdAt || null;
};

// Is this song due for practice? A never-practiced song IS due — and so is one
// whose stored date we can't read, because a song we can't schedule is one to
// surface, never one to hide forever.
export const isSongDue = (song, now = Date.now()) => {
  const at = Date.parse(songNextReviewAt(song) ?? '');
  return !Number.isFinite(at) || at <= now;
};

// Has this song ever been practiced? `null` (absent schedule) must not read the
// same as a real session count of 0 — the empty-vs-absent rule.
export const songPracticeSessions = (song) => (
  Number.isInteger(song?.practice?.sessions) ? song.practice.sessions : 0
);

export const INSTRUMENTS = [
  { id: 'guitar', label: 'Guitar' },
  { id: 'piano', label: 'Piano' },
  { id: 'ukulele', label: 'Ukulele' },
  { id: 'bass', label: 'Bass' },
  { id: 'voice', label: 'Voice' },
  { id: 'drums', label: 'Drums' },
  { id: 'other', label: 'Other' },
];

// Display label for a stored instrument id (unknown ids render as-is).
export const instrumentLabel = (id) => INSTRUMENTS.find((i) => i.id === id)?.label || id;

export const SONG_FORMATS = ['chordpro', 'tab', 'plain', 'drum'];

// =============================================================================
// CROSS-LINKS to other music records (#4103)
// =============================================================================

// The record kinds a song can link to. Mirrors `songLinkTypeEnum` in
// server/lib/brainValidation.js; `path` is the detail route the chip navigates
// to (`${path}/${id}`). Parity with the server enum is asserted in
// constants.test.js.
export const SONG_LINK_TYPES = [
  { id: 'round', label: 'Round', path: '/rounds' },
  { id: 'track', label: 'Track', path: '/music/tracks' },
];

// Display label for a stored link type. A type this client doesn't know (a song
// synced from a newer peer — the server accepts any short slug) renders as-is
// rather than vanishing.
export const songLinkTypeLabel = (type) => (
  SONG_LINK_TYPES.find((t) => t.id === type)?.label || type
);

// In-app route for a link, or null when the type is unknown to this client —
// there is no route to send the user to, so the caller renders a plain (unlinked)
// chip instead of a dead <Link>.
export const songLinkHref = (link) => {
  const path = SONG_LINK_TYPES.find((t) => t.id === link?.type)?.path;
  return path && link?.id ? `${path}/${encodeURIComponent(link.id)}` : null;
};

// A link's identity for dedupe/removal — type+id, since the same id could in
// principle exist under two record kinds.
export const songLinkKey = (link) => `${link?.type}:${link?.id}`;

// The song's links as an array. Absent (a song predating the field, or one
// synced from an older peer) reads the same as none — but never as a crash.
export const songLinks = (song) => (Array.isArray(song?.links) ? song.links : []);

// The content format whose renderer is <DrumSheetView> (kit grid) rather than
// <TabSheetView>. Named so the viewer/import branches read intent, not a string.
export const DRUM_FORMAT = 'drum';
// The instrument that defaults a new song to the drum format.
export const DRUM_INSTRUMENT = 'drums';

// Options for a `<select>` over a known list plus whatever value is actually
// stored. A record synced from a NEWER peer (or hand-edited) can carry an
// instrument/format this client has never heard of — dropping it from the option
// list would make the select resolve to its first option and silently rewrite
// the record on the next save. So append the stored value as its own option and
// let the save round-trip it unchanged.
//
// The server half of this contract is in `server/lib/brainValidation.js`: the
// write schemas accept the enum OR any short slug, precisely so the value this
// preserves can actually be saved rather than 400ing on a field the user never
// touched. Keep the two ends together — a client that preserves an unknown value
// against a server that rejects it just makes the song uneditable.
//
// `options` may be `[{ id, label }]` (INSTRUMENTS) or `['tab', …]` (SONG_FORMATS);
// both normalize to `{ id, label }`.
export const withStoredOption = (options, stored) => {
  const normalized = options.map((o) => (typeof o === 'string' ? { id: o, label: o } : o));
  if (!stored || normalized.some((o) => o.id === stored)) return normalized;
  return [...normalized, { id: stored, label: stored }];
};

// Shared form/button recipes for the SongBook pages (index, import, viewer) —
// kept here so the three pages don't drift on styling.
export const inputClass = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';
export const labelClass = 'block text-xs text-gray-400 mb-1';
// Secondary button (bordered, subtle hover; disabled fades).
export const btnClass = 'flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50';
// A sheet/transport control: 44px minimum touch target, matching the viewer's own
// controls bar. `activeCtrlClass` is the lit state for the toggles among them
// (play, metronome, loop, the sheet's Legend) — shared so a new control can't
// invent a fourth "this is on" look.
export const ctrlBtnClass = 'flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50';
export const activeCtrlClass = 'text-port-accent border-port-accent/50';
// A compact `<select>` inside a transport bar (count-in, loop range, kit) —
// same 44px touch target as the buttons beside it.
export const smallSelectClass = 'bg-port-bg border border-port-border rounded px-2 py-2 min-h-[44px] text-xs text-white focus:border-port-accent focus:outline-none';
