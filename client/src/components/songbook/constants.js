// Shared SongBook constants — learning-stage progression, stage chip colors,
// and the instrument list (mirrors server/lib/brainValidation.js enums).

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
