/**
 * Catalog scrap SOURCE-KIND registry — one entry per ingest path that mints a
 * `catalog_scraps` row, and the extraction lens that path implies.
 *
 * A pure leaf (no zod, no db). Declaring `factual` beside the id makes a new source
 * choose its lens when registered (#7609). `factual: true` means the user's own lived
 * capture (memoir, journal, recorded thought) rather than invented story material; it
 * drives the `{{#factual}}` sections in the catalog extraction prompts. The universe's
 * own `factual` flag (#7616) is primary once ingest is bound to a universe (#7615).
 */

export const SCRAP_SOURCE_KINDS = Object.freeze([
  { id: 'paste', label: 'Pasted text', factual: false },
  { id: 'brain-bridge', label: 'Brain record', factual: true },
  { id: 'importer-handoff', label: 'Importer handoff', factual: false },
  { id: 'manual', label: 'Manual entry', factual: false },
  { id: 'url', label: 'Web page', factual: false },
  { id: 'file', label: 'Uploaded file', factual: false },
  { id: 'voice-memo', label: 'Voice memo', factual: true },
].map(Object.freeze));

/** Ids for the Zod enum on LOCAL ingest routes; sync-apply uses a looser string so a newer peer's kind passes. */
export const SCRAP_SOURCE_KIND_IDS = Object.freeze(SCRAP_SOURCE_KINDS.map((k) => k.id));

const FACTUAL_IDS = new Set(SCRAP_SOURCE_KINDS.filter((k) => k.factual).map((k) => k.id));

/** Unknown kinds (e.g. from a newer peer) read as non-factual, the safe default lens. */
export const isFactualSourceKind = (sourceKind) => FACTUAL_IDS.has(sourceKind);
