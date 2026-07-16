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
  { id: 'other', label: 'Other' },
];

// Display label for a stored instrument id (unknown ids render as-is).
export const instrumentLabel = (id) => INSTRUMENTS.find((i) => i.id === id)?.label || id;

export const SONG_FORMATS = ['chordpro', 'tab', 'plain'];

// Shared form/button recipes for the SongBook pages (index, import, viewer) —
// kept here so the three pages don't drift on styling.
export const inputClass = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';
export const labelClass = 'block text-xs text-gray-400 mb-1';
// Secondary button (bordered, subtle hover; disabled fades).
export const btnClass = 'flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50';
