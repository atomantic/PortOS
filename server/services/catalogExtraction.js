/** Catalog extraction returns review drafts only; commit owns all ingredient writes. */
import { randomUUID } from 'crypto';
import { isFactualSourceKind } from '../lib/catalogSourceKinds.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { neutralizeFences } from '../lib/promptFencing.js';
import { catalogEvents } from './catalogEvents.js';
import { getScrap, listIngredientsForRef } from './catalogDB.js';
import { escapeRegExp } from '../lib/textUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { isRunCanceledError } from '../lib/aiToolkit/errorDetection.js';

export const EXTRACTION_STAGES = Object.freeze([{ id: 'catalog', label: 'Catalog graph' }]);
const CHUNK_EXTRACT_CONCURRENCY = 2;

/** Resolve, plan and execute one joint graph call per complete source chunk. */
export async function extractIngredients({ rawText, scrapId = null, providerOverride, modelOverride,
  runId = randomUUID(), emitStart = true, context = {} } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) throw new Error('extractIngredients: rawText is required');
  // Writers Room imports the prose scanner below. It need not load extraction
  // schemas, prompt configuration or the provider graph until extraction runs.
  const { planCatalogExtraction, CATALOG_EXTRACTION_STAGE } = await import('./catalogExtractionPlan.js');
  const { runStageScopedInlineLLM } = await import('./stageRunner.js');
  const { parseCatalogDraft, dedupDrafts, CATALOG_DRAFT_TYPES } = await import('../lib/catalogExtractionDraft.js');
  const { parts, options, plan } = await planCatalogExtraction({ rawText, context, providerOverride, modelOverride });
  const emit = frame => {
    try { catalogEvents.emit('progress', { runId, scrapId, ...frame }); }
    catch (err) { console.error(`❌ catalog progress emit failed: ${err.message}`); }
  };
  if (emitStart) emit({ type: 'start', stages: plan.chunks.map(({ id, label }) => ({ id, label })), plan });
  let cancellation = null;
  const results = await mapWithConcurrency(parts, CHUNK_EXTRACT_CONCURRENCY, async (part, index) => {
    const chunk = plan.chunks[index];
    const stage = { id: chunk.id, label: chunk.label, chunkIndex: index, chunkCount: parts.length };
    if (cancellation) return { draft: null, stage: { ...stage, status: 'failed', count: 0, error: 'Extraction canceled' } };
    emit({ type: 'stage', ...stage, status: 'running' });
    try {
      const result = await runStageScopedInlineLLM(CATALOG_EXTRACTION_STAGE, part.prompt, options);
      const draft = parseCatalogDraft(result.content, {
        corpus: neutralizeFences(part.text), factual: context.factual === true, finishReason: result.finishReason,
      });
      const count = CATALOG_DRAFT_TYPES.reduce((n, type) => n + draft[type.key].length, 0);
      const completed = { ...stage, status: 'completed', count };
      emit({ type: 'stage', ...completed });
      return { draft, stage: completed };
    } catch (err) {
      if (isRunCanceledError(err)) cancellation = err;
      // Do not log source-bearing parse errors or provider responses. The run
      // record already holds provider diagnostics; these frames belong to UI.
      const error = err.message || 'Catalog extraction failed; retry this source.';
      const failed = { ...stage, status: 'failed', count: 0, error };
      emit({ type: 'stage', ...failed });
      return { draft: null, stage: failed };
    }
  });
  if (cancellation) throw cancellation;
  const completedChunks = results.filter(result => result.draft).length;
  if (!completedChunks) throw new ServerError(results[0].stage.error, { status: 502, code: 'CATALOG_EXTRACTION_FAILED' });
  let merged;
  try { merged = dedupDrafts(results.map(result => result.draft)); }
  catch (err) { throw new ServerError(err.message, { status: 502, code: 'CATALOG_EXTRACTION_FAILED' }); }
  const totalEntries = CATALOG_DRAFT_TYPES.reduce((n, type) => n + merged[type.key].length, 0);
  return { runId, ...merged, stages: results.map(result => result.stage), plan,
    coverage: { status: completedChunks === parts.length ? 'complete' : 'partial',
      completedChunks, totalChunks: parts.length,
      failedChunks: plan.chunks.filter((_, index) => !results[index].draft).map(chunk => chunk.index),
    },
    // Keep all candidates for review; consumers must explicitly reduce overflow.
    ...(totalEntries > 200 || merged.relationships.length > 1000
      ? { overflow: { entries: totalEntries, relationships: merged.relationships.length, maxEntries: 200, maxRelationships: 1000 } } : {}),
  };
}

/** Stored children never replace the complete parent source for model planning. */
export async function extractIngredientsForScrap({ scrapId, providerOverride, modelOverride } = {}) {
  const parent = await getScrap(scrapId);
  if (!parent) throw new Error(`extractIngredientsForScrap: scrap ${scrapId} not found`);
  const sourceKind = typeof parent.sourceKind === 'string' ? parent.sourceKind.trim() : '';
  return extractIngredients({ rawText: parent.rawText, scrapId: parent.id, providerOverride, modelOverride,
    context: { title: typeof parent.title === 'string' ? parent.title.trim() : '', sourceKind, factual: isFactualSourceKind(sourceKind) },
  });
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
    const esc = escapeRegExp(needle);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(text)) matched.push(id);
  }
  return matched.sort();
}
