/**
 * Catalog scrap SOURCE-KIND registry — one entry per ingest path that mints a
 * `catalog_scraps` row, and the extraction lens that path implies.
 *
 * A pure leaf (no zod, no db) so both the validation layer and the extractor
 * can read it. That split is the point: the lens used to live as a private
 * two-element Set inside `catalogExtraction.js`, so adding an ingest source
 * gave you a working route that silently extracted a memoir through the
 * fiction lens — the exact bug #7609 reports. Declaring `factual` HERE, beside
 * the id, makes a new source decide its lens at the moment it is registered.
 *
 * `factual: true` means the path produces the user's own lived capture (a
 * memoir, journal entry, or recorded thought about real people and places)
 * rather than invented story material. It drives the `{{#factual}}` sections
 * in the four catalog extraction prompts. The universe record now carries its
 * own `factual` flag too (#7616, shipped on the seeded `universe-reality`
 * world); once ingest is bound to a universe (#7615) that flag becomes the
 * primary signal, with the source kind as the fallback for a scrap catalogued
 * into no universe.
 */

export const SCRAP_SOURCE_KINDS = Object.freeze([
  { id: 'paste', label: 'Pasted text', factual: false },
  // POST /catalog/ingest/brain — an existing brain record (idea / memory /
  // project / admin). The user's own captured thought.
  { id: 'brain-bridge', label: 'Brain record', factual: true },
  { id: 'importer-handoff', label: 'Importer handoff', factual: false },
  { id: 'manual', label: 'Manual entry', factual: false },
  // POST /catalog/ingest/url — fetched + main-text-extracted page
  { id: 'url', label: 'Web page', factual: false },
  // POST /catalog/ingest/file — uploaded .txt/.md/.pdf
  { id: 'file', label: 'Uploaded file', factual: false },
  // POST /catalog/ingest/voice — recorded memo, Whisper-transcribed. Spoken
  // first-person capture.
  { id: 'voice-memo', label: 'Voice memo', factual: true },
].map(Object.freeze));

/**
 * The bare ids, for the Zod enum that gates the LOCAL ingest routes. The
 * sync-apply path deliberately uses a looser `z.string().max(32)` instead, so
 * a newer peer can push a kind this build does not enumerate.
 */
export const SCRAP_SOURCE_KIND_IDS = Object.freeze(SCRAP_SOURCE_KINDS.map((k) => k.id));

const FACTUAL_IDS = new Set(SCRAP_SOURCE_KINDS.filter((k) => k.factual).map((k) => k.id));

/**
 * Does this source kind produce lived material rather than invented fiction?
 * An unknown kind (including one a newer peer synced in) reads as non-factual:
 * the fiction lens is what every extraction rendered before #7609, so it is the
 * safe answer for a kind this build cannot classify.
 */
export const isFactualSourceKind = (sourceKind) => FACTUAL_IDS.has(sourceKind);
