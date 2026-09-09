// SongBook editor serialization. Save and the unsaved-changes guard share this
// boundary so a field has exactly one definition of its persisted value.
// Pure: the page owns record-to-form defaults, requests, and navigation.

// "Fit to duration" target bounds — client mirror of `scrollDurationSec` in
// server/lib/brainValidation.js (songInputSchema). Keep the two in step: a value
// the input accepts but the schema rejects 400s the whole save.
export const SCROLL_DURATION_MIN = 15;
export const SCROLL_DURATION_MAX = 3600;

// Scroll-duration input (a string, like every number input) → what a save sends:
// null for "no target" (blank, or anything non-numeric), otherwise a whole
// second count inside the schema bounds. null is a real value here — it CLEARS a
// stored target on PATCH — so it must never collapse into "field absent".
const parseScrollDurationSec = (raw) => {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(SCROLL_DURATION_MIN, Math.min(SCROLL_DURATION_MAX, Math.trunc(n)));
};

const serializeDraft = (draft) => ({
  title: draft.title.trim(),
  artist: draft.artist.trim(),
  instrument: draft.instrument,
  stage: draft.stage,
  key: draft.key.trim(),
  capo: Math.max(0, Math.min(12, Math.trunc(Number(draft.capo) || 0))),
  tuning: draft.tuning.trim(),
  tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
  sourceUrl: draft.sourceUrl.trim(),
  links: draft.links,
  notes: draft.notes,
  // null explicitly clears a stored target; omission would preserve it.
  scrollDurationSec: parseScrollDurationSec(draft.scrollDurationSec),
  // Preserve the editor contract: format and text are saved together.
  content: { format: draft.format, text: draft.text },
});

// Compare known link fields by value, independently of object key order from
// sync peers. Tuples avoid collisions with delimiters inside free-text labels.
const comparableLinks = (links) => (links || []).map((link) => [link.type, link.id, link.label || '']);
const comparableDraft = (draft) => {
  const fields = serializeDraft(draft);
  return JSON.stringify({ ...fields, links: comparableLinks(fields.links) });
};

export const songBookDraftsEqual = (a, b) => comparableDraft(a) === comparableDraft(b);

export const buildSongBookPatch = (draft, savedDraft) => {
  const patch = serializeDraft(draft);
  // Untouched links must bypass this client's validation bounds: a newer peer
  // may have stored more links or longer labels. Changed lists are sent whole,
  // including [] to clear the last link, preserving the existing PATCH contract.
  if (JSON.stringify(comparableLinks(draft.links)) === JSON.stringify(comparableLinks(savedDraft.links))) {
    delete patch.links;
  }
  return patch;
};
