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

export const INSTRUMENTS = ['guitar', 'piano', 'ukulele', 'bass', 'voice', 'other'];

export const SONG_FORMATS = ['chordpro', 'tab', 'plain'];
