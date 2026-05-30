/**
 * Catalog Extraction Service
 *
 * Runs LLM passes over a raw user-pasted scrap and returns a typed draft of
 * candidate ingredients (characters, places, objects) the user can review
 * and selectively commit via POST /api/catalog/scraps/:id/commit.
 *
 * Reuses server/lib/bibleExtractor.js for the three storyBible-shaped types
 * — characters, places, objects — so the catalog payload is identical to the
 * shape stored in universe canon. Idea/scene/concept LLM extraction is a
 * follow-up (Phase 5b); for now they're created manually via POST
 * /api/catalog/ingredients.
 *
 * Streams progress as `catalog:extract:progress` socket frames so the Ingest
 * UI can render a live stage checklist while waiting on the parallel passes.
 */

import { randomUUID } from 'crypto';
import { extractBible } from '../lib/bibleExtractor.js';
import { BIBLE_KINDS, BIBLE_FIELD } from '../lib/storyBible.js';
import { catalogEvents } from './catalogEvents.js';

// One stage per bible kind; runs in parallel under the same runId. Derived
// from BIBLE_KINDS so a future kind picked up by extractBible flows through
// here automatically.
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1) + 's';
export const EXTRACTION_STAGES = Object.freeze(
  BIBLE_KINDS.map((kind) => ({
    id: BIBLE_FIELD[kind],   // 'characters' | 'places' | 'objects'
    label: titleCase(kind),
    kind,
  })),
);

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
 * Replacement uses zero-width joiner between the backticks so the visual
 * content is preserved for any model that wants to comment on it.
 */
function neutralizeFenceDelimiters(text) {
  // U+200D zero-width joiner; safe inside JSON strings, invisible in prose.
  return text.replace(/```/g, '`‍``');
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

  // Run all three bible-extract passes in parallel — they're independent and
  // the corpus is identical. Each settles to a per-stage status frame so the
  // UI flips the corresponding row to ✓ / ✗ as work completes.
  const promises = EXTRACTION_STAGES.map(async ({ id, kind }) => {
    emit({ type: 'stage', id, status: 'running' });
    try {
      const result = await extractBible({
        kind,
        corpus,
        existing: [],
        providerOverride,
        source: `catalog-extract-${id}`,
      });
      emit({ type: 'stage', id, status: 'completed', count: result.extracted.length });
      return { id, extracted: result.extracted, error: null };
    } catch (err) {
      console.error(`❌ catalog extract ${id} failed: ${err.message}`);
      emit({ type: 'stage', id, status: 'failed', error: err.message });
      return { id, extracted: [], error: err.message };
    }
  });

  const settled = await Promise.all(promises);

  const draft = Object.fromEntries(EXTRACTION_STAGES.map((s) => [s.id, []]));
  const stages = settled.map(({ id, extracted, error }) => {
    draft[id] = extracted;
    return {
      id,
      label: EXTRACTION_STAGES.find((s) => s.id === id).label,
      status: error ? 'failed' : 'completed',
      count: extracted.length,
      error: error || undefined,
    };
  });

  // (No terminal `done` socket frame — the client transitions to the review
  // phase off the HTTP response, not a socket event. Emitting an unhandled
  // frame is just noise.)

  return { runId, ...draft, stages };
}
