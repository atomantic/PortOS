/**
 * Catalog Extraction Service
 *
 * Runs LLM passes over a raw user-pasted scrap and returns a typed draft of
 * candidate ingredients (characters, places, objects, ideas, scenes,
 * concepts) the user can review and selectively commit via
 * POST /api/catalog/scraps/:id/commit.
 *
 * Three passes reuse server/lib/bibleExtractor.js for the storyBible-shaped
 * types (characters, places, objects) so their payloads are identical to the
 * shape stored in universe canon. A fourth pass calls a single LLM stage
 * (`catalog-ideas-scenes-concepts`) that returns all three light-shape types
 * in one round-trip — they share a corpus and an output schema, so packaging
 * them as one call cuts cost while still surfacing as a UI stage.
 *
 * Streams progress as `catalog:extract:progress` socket frames so the Ingest
 * UI can render a live stage checklist while waiting on the parallel passes.
 */

import { randomUUID } from 'crypto';
import { extractBible } from '../lib/bibleExtractor.js';
import { runStagedLLM } from '../lib/stageRunner.js';
import { BIBLE_KINDS, BIBLE_FIELD, BIBLE_LIMITS } from '../lib/storyBible.js';
import { CATALOG_TYPES } from '../lib/catalogTypes.js';
import { catalogEvents } from './catalogEvents.js';
import { listIngredientsForRef } from './catalogDB.js';

// Light-shape ingredient type ids, sourced from the shared registry
// (`extractionShape === 'light'`). Adding a light type to `catalogTypes.js`
// flows through the draft scaffolding without a manual edit here. Order
// matches the registry → matches the bundled prompt's JSON keys
// (ideas/scenes/concepts today).
const LIGHT_TYPE_IDS = CATALOG_TYPES.filter((t) => t.extractionShape === 'light').map((t) => t.id);
// Bible type ids, sourced the same way (`extractionShape === 'bible'`).
const BIBLE_TYPE_IDS = CATALOG_TYPES.filter((t) => t.extractionShape === 'bible').map((t) => t.id);
// Map a light TYPE id to its plural draft key (`idea` → `ideas`). The bundled
// prompt's JSON keys + the draft scaffolding key results by this plural.
const lightDraftKey = (id) => `${id}s`;

// Light-shape stage that bundles ideas/scenes/concepts into one LLM call.
// Surfaced to the UI as a single stage row — the three result arrays land
// in `draft.ideas` / `draft.scenes` / `draft.concepts` and the user reviews
// them as separate sections.
const LIGHT_STAGE_ID = 'ideasScenesConcepts';

// Stage list emitted to the Ingest UI. Three bible stages run via extractBible
// (one per BIBLE_KINDS entry — a future bible kind picks up automatically),
// plus the one bundled light stage. Order matches the typical user mental
// model: structural first, then narrative shards.
//
// Label is derived from BIBLE_FIELD (which is the canonical plural form
// already used everywhere else for the field key — `characters` / `places` /
// `objects`) rather than a hand-rolled "append 's'" helper. The append-'s'
// approach would silently mis-pluralize a future kind that doesn't take a
// bare-'s' plural (e.g. `entity` → `Entitys`).
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const EXTRACTION_STAGES = Object.freeze([
  ...BIBLE_KINDS.map((kind) => ({
    id: BIBLE_FIELD[kind],   // 'characters' | 'places' | 'objects'
    label: capitalize(BIBLE_FIELD[kind]),
    kind,
  })),
  { id: LIGHT_STAGE_ID, label: 'Ideas, scenes & concepts' },
]);

// Field caps for the light-shape sanitizer below. Generous enough for
// reasonable LLM output, tight enough that a runaway response can't load
// a multi-MB string into the catalog payload. NAME_MAX / TAG_MAX /
// TAGS_PER_ENTRY_MAX MUST track BIBLE_LIMITS — those are the boundaries the
// `/api/catalog/scraps/:id/commit` Zod schema enforces, and a sanitizer cap
// looser than the schema would let a row pass the extractor but reject the
// whole batch on commit.
const LIGHT_LIMITS = Object.freeze({
  NAME_MAX: BIBLE_LIMITS.NAME_MAX,
  SUMMARY_MAX: 2000,
  EVIDENCE_MAX: 400,
  SETTING_MAX: 200,
  KIND_MAX: 64,
  TAG_MAX: BIBLE_LIMITS.TAG_MAX,
  TAGS_MAX: BIBLE_LIMITS.TAGS_PER_ENTRY_MAX,
  ACTORS_MAX: 12,
});

const trim = (v, max) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const trimArray = (arr, itemMax, listMax) => {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const t = trim(item, itemMax);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= listMax) break;
  }
  return out;
};

// Per-kind light-shape sanitizer. Drops rows with no name (the primary key
// for review selection), and packages everything except `name`/`tags` into
// the catalog payload so the commit path's payload-splat works cleanly.
function sanitizeLightEntry(kind, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trim(raw.name, LIGHT_LIMITS.NAME_MAX);
  if (!name) return null;
  const summary = trim(raw.summary, LIGHT_LIMITS.SUMMARY_MAX);
  const evidence = trim(raw.evidence, LIGHT_LIMITS.EVIDENCE_MAX);
  const tags = trimArray(raw.tags, LIGHT_LIMITS.TAG_MAX, LIGHT_LIMITS.TAGS_MAX);
  const entry = { name, tags };
  if (summary) entry.summary = summary;
  if (evidence) entry.evidence = evidence;
  if (kind === 'scene') {
    const setting = trim(raw.setting, LIGHT_LIMITS.SETTING_MAX);
    const actors = trimArray(raw.actors, LIGHT_LIMITS.NAME_MAX, LIGHT_LIMITS.ACTORS_MAX);
    if (setting) entry.setting = setting;
    if (actors.length > 0) entry.actors = actors;
  } else if (kind === 'concept') {
    // The LLM emits `kind` (magic-system / faction / lore / metaphor / rule).
    // Stored on the payload as-is — `type` is a separate column at the row
    // level, so `payload.kind` doesn't collide with the catalog's outer type
    // discriminator and downstream readers (Catalog.jsx snippet fallbacks,
    // future detail-page renderers) can find the field where the prompt put it.
    const conceptKind = trim(raw.kind, LIGHT_LIMITS.KIND_MAX);
    if (conceptKind) entry.kind = conceptKind;
  }
  return entry;
}

/**
 * Run the bundled ideas/scenes/concepts LLM call. Returns three arrays
 * sanitized into the catalog payload shape. Tolerant on parse failure — a
 * malformed response logs and yields empty arrays, mirroring extractBible's
 * sanitizeBibleList tolerance for missing keys.
 */
async function extractIdeasScenesConcepts({ corpus, providerOverride }) {
  const result = await runStagedLLM('catalog-ideas-scenes-concepts', {
    draftBody: corpus,
    returnsJson: true,
  }, {
    providerOverride,
    returnsJson: true,
    source: 'catalog-extract-ideas-scenes-concepts',
  });
  const content = result?.content || {};
  // One sanitized array per light type, keyed by plural draft key. Driven by
  // the registry so a new light type (with its prompt JSON key) is picked up
  // here without an extra line.
  const out = {};
  for (const id of LIGHT_TYPE_IDS) {
    const key = lightDraftKey(id);
    const raw = Array.isArray(content[key]) ? content[key] : [];
    out[key] = raw.map((r) => sanitizeLightEntry(id, r)).filter(Boolean);
  }
  return out;
}

/**
 * Extract candidate ingredients from a raw scrap.
 *
 * @param {object} args
 * @param {string} args.rawText      The scrap body to extract from.
 * @param {string} [args.scrapId]    Scrap id to attach to progress frames.
 * @param {string} [args.providerOverride] Override the staged-llm provider.
 * @returns {Promise<{
 *   runId: string,
 *   characters: Array,
 *   places: Array,
 *   objects: Array,
 *   stages: Array<{ id, label, status, error? }>
 * }>}
 */
/**
 * Neutralize markdown fence delimiters in user-pasted text before it lands
 * inside the extractor's triple-backtick `{{draftBody}}` fence. Without this
 * a paste containing ``` would prematurely close the prompt's fenced block
 * and corrupt the structured prompt the LLM sees. The writers-room callers
 * of `extractBible` pass server-curated content so they don't need this; the
 * catalog caller passes ARBITRARY USER PASTE and does.
 *
 * Replacement inserts a zero-width joiner between every adjacent pair of
 * backticks in a run of 3 or more, so the visual content stays readable but
 * no three-backtick subsequence survives. A naive `/```/g` replace fails on
 * runs of 4+ — the leftover backtick after the first match reforms a triple
 * with the trailing pair of the replacement.
 */
function neutralizeFenceDelimiters(text) {
  // U+200D zero-width joiner; safe inside JSON strings, invisible in prose.
  // Match every run of 3+ backticks and rebuild it with ZWJ between each.
  return text.replace(/`{3,}/g, (run) => run.split('').join('‍'));
}

export async function extractIngredients({ rawText, scrapId = null, providerOverride } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('extractIngredients: rawText is required');
  }

  const corpus = neutralizeFenceDelimiters(rawText);
  const runId = randomUUID();
  const emit = (frame) => {
    try {
      catalogEvents.emit('progress', { runId, scrapId, ...frame });
    } catch (err) {
      console.error(`❌ catalog progress emit failed: ${err.message}`);
    }
  };

  emit({ type: 'start', stages: EXTRACTION_STAGES.map(({ id, label }) => ({ id, label })) });

  // Run every stage in parallel — they're independent and share the corpus.
  // Each settles to a per-stage status frame so the UI flips the corresponding
  // row to ✓ / ✗ as work completes. Bible stages return one array; the
  // light-shape stage returns three (ideas/scenes/concepts) under one stage id.
  const runStage = async (stage) => {
    emit({ type: 'stage', id: stage.id, status: 'running' });
    try {
      if (stage.id === LIGHT_STAGE_ID) {
        const out = await extractIdeasScenesConcepts({ corpus, providerOverride });
        const count = LIGHT_TYPE_IDS.reduce((n, id) => n + (out[lightDraftKey(id)]?.length || 0), 0);
        emit({ type: 'stage', id: stage.id, status: 'completed', count });
        return { id: stage.id, light: out, error: null };
      }
      const result = await extractBible({
        kind: stage.kind,
        corpus,
        existing: [],
        providerOverride,
        source: `catalog-extract-${stage.id}`,
      });
      emit({ type: 'stage', id: stage.id, status: 'completed', count: result.extracted.length });
      return { id: stage.id, extracted: result.extracted, error: null };
    } catch (err) {
      console.error(`❌ catalog extract ${stage.id} failed: ${err.message}`);
      emit({ type: 'stage', id: stage.id, status: 'failed', error: err.message });
      return { id: stage.id, error: err.message };
    }
  };

  const settled = await Promise.all(EXTRACTION_STAGES.map(runStage));

  // Default empty arrays for every result key the UI can render — keeps the
  // commit path's `Array.isArray(result.draft.x)` guard happy even when a
  // stage failed or returned nothing. Bible keys use BIBLE_FIELD plurals;
  // light keys use the registry's plural draft key.
  const draft = {};
  for (const kind of BIBLE_TYPE_IDS) draft[BIBLE_FIELD[kind]] = [];
  for (const id of LIGHT_TYPE_IDS) draft[lightDraftKey(id)] = [];
  const stages = settled.map(({ id, extracted, light, error }) => {
    let count = 0;
    if (light) {
      for (const lightId of LIGHT_TYPE_IDS) {
        const key = lightDraftKey(lightId);
        draft[key] = light[key] || [];
        count += draft[key].length;
      }
    } else if (extracted) {
      draft[id] = extracted;
      count = extracted.length;
    }
    return {
      id,
      label: EXTRACTION_STAGES.find((s) => s.id === id).label,
      status: error ? 'failed' : 'completed',
      count,
      error: error || undefined,
    };
  });

  // (No terminal `done` socket frame — the client transitions to the review
  // phase off the HTTP response, not a socket event. Emitting an unhandled
  // frame is just noise.)

  return { runId, ...draft, stages };
}

// (refKind, refId) pairs the scan is allowed to consider. Only catalog
// ingredients linked to one of the provided targets are eligible — a draft
// shouldn't claim a reference to a character that lives in an unrelated
// universe just because the two names collide.
const SCAN_REF_KINDS = Object.freeze(['universe', 'series', 'work']);

/**
 * Detect which catalog ingredients a piece of prose references, scoped to the
 * ingredients linked to the given target(s).
 *
 * Substring-matches each candidate ingredient's `name` against the prose
 * (case-insensitive). The candidate set is the union of ingredients linked to
 * any provided ref — so a Writers Room draft only ever picks up the cast that
 * was deliberately attached to its work / series / universe, never an
 * arbitrary catalog row. Returns a de-duplicated list of matched ingredient
 * ids in stable (sorted) order so the stored array is comparable across saves.
 *
 * @param {string} text                 The prose to scan.
 * @param {object} scope
 * @param {string} [scope.universeId]   Universe ref to scope candidates to.
 * @param {string} [scope.seriesId]     Series ref to scope candidates to.
 * @param {string} [scope.workId]       Work ref to scope candidates to.
 * @returns {Promise<string[]>}         Matched ingredient ids (sorted, unique).
 */
export async function scanProseForIngredientRefs(text, scope = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const targets = [
    ['universe', scope.universeId],
    ['series', scope.seriesId],
    ['work', scope.workId],
  ].filter(([kind, id]) => SCAN_REF_KINDS.includes(kind) && typeof id === 'string' && id.trim());
  if (targets.length === 0) return [];

  // Union the candidate ingredients across every provided target. The same
  // ingredient can be linked to more than one target (a character attached to
  // both its universe and its work) — de-dupe by id so we scan its name once.
  const byId = new Map();
  for (const [kind, id] of targets) {
    const rows = await listIngredientsForRef(kind, id);
    for (const { ingredient } of rows) {
      if (ingredient?.id && ingredient?.name && !byId.has(ingredient.id)) {
        byId.set(ingredient.id, ingredient.name);
      }
    }
  }
  if (byId.size === 0) return [];

  const matched = [];
  for (const [id, name] of byId) {
    const needle = String(name).trim();
    if (!needle) continue;
    // Word-boundary match (not bare substring) so a short name like "Sun"
    // doesn't false-positive inside "Sunday" or "Al" inside "always". Names
    // are user-controlled, so escape regex metacharacters; the \p{L}\p{N}
    // lookarounds keep multi-word phrases ("The Drowned Harbor") matching as a
    // unit while still treating the whole name as one token boundary-wise.
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(text)) matched.push(id);
  }
  return matched.sort();
}
