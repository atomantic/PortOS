// Display labels for Writers Room enums. Keys mirror the canonical enum
// values in server/lib/writersRoomPresets.js — keep in sync when adding kinds
// or statuses there.

export const KIND_LABELS = {
  novel: 'Novel',
  'short-story': 'Short Story',
  screenplay: 'Screenplay',
  essay: 'Essay',
  treatment: 'Treatment',
  other: 'Other',
};

export const STATUS_LABELS = {
  idea: 'Idea',
  drafting: 'Drafting',
  revision: 'Revision',
  adaptation: 'Adaptation',
  rendering: 'Rendering',
  complete: 'Complete',
  archived: 'Archived',
};
