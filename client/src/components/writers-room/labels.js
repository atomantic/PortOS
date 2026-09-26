// Display labels for Writers Room enums, keyed by the server WORK_KINDS and
// WORK_STATUSES (server/lib/writersRoomPresets.js); labels.test.js enforces parity.

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
