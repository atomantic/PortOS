/**
 * Burn job — render images for universe bible entries that have none.
 *
 * PROGRAMMATIC: no agent is spawned. PortOS compiles the missing entries' render
 * prompts itself and enqueues them on the media job queue, exactly as the
 * Universe Builder's "Render" button does. The quota it burns is the CLOUD IMAGE
 * backend's (codex `image_gen`, grok `image_gen`, agy `generate_image`), which is
 * why the job's render backend defaults to the burning family's own mode.
 *
 * "Has no image" means the entry's `imageRefs[]` is empty — the same array the
 * collection hook appends a finished render's filename to. An entry that has
 * ever rendered successfully is skipped forever after, so repeated runs walk
 * down the backlog instead of re-rendering the same entries.
 */

import { getUniverse, listUniverses } from '../universeBuilder.js';
import { getWorldCategoryKeys } from '../universeBuilder/sanitize.js';
import { renderUniverseJobs } from '../universeBuilderRender.js';
import { CLOUD_IMAGE_GEN_MODES } from '../imageGen/modes.js';

const CANON_TRUNKS = ['characters', 'places', 'objects'];
const DEFAULT_MAX_ENTRIES = 10;

const hasNoImage = (entry) => !Array.isArray(entry?.imageRefs) || entry.imageRefs.length === 0;

// The label `compilePrompts` matches a selection against, per entry kind. Canon
// places may carry only a slugline, which is the identifier compile.js falls
// back to — mirror that or those entries become unselectable.
const canonLabel = (trunk, entry) =>
  (typeof entry?.name === 'string' && entry.name.trim())
    ? entry.name
    : (trunk === 'places' && typeof entry?.slugline === 'string' ? entry.slugline : '');

const wantsScope = (scope, kind) => scope === 'all' || !scope || scope === kind;

/**
 * Every image-less entry in one universe, as `{ kind, categoryKey, label }`
 * rows in a stable order (variations → sheets → canon), so a capped run always
 * chews through the same backlog front-to-back rather than sampling randomly.
 */
export function findMissingImageEntries(universe, { scope = 'all' } = {}) {
  const rows = [];
  if (wantsScope(scope, 'variations')) {
    for (const categoryKey of getWorldCategoryKeys(universe?.categories)) {
      for (const variation of universe?.categories?.[categoryKey]?.variations || []) {
        if (!hasNoImage(variation) || !variation?.label) continue;
        rows.push({ kind: 'variation', categoryKey, label: variation.label });
      }
    }
  }
  if (wantsScope(scope, 'sheets')) {
    for (const sheet of universe?.compositeSheets || []) {
      if (!hasNoImage(sheet) || !sheet?.label) continue;
      rows.push({ kind: 'sheet', label: sheet.label });
    }
  }
  if (wantsScope(scope, 'canon')) {
    for (const trunk of CANON_TRUNKS) {
      for (const entry of universe?.[trunk] || []) {
        const label = canonLabel(trunk, entry);
        if (!hasNoImage(entry) || !label) continue;
        rows.push({ kind: 'canon', categoryKey: trunk, label });
      }
    }
  }
  return rows;
}

/** Turn capped rows back into the three selection shapes `compilePrompts` reads. */
export function buildRenderSelection(rows) {
  const selection = {};
  const canonSelection = {};
  const sheetSelection = [];
  for (const row of rows) {
    if (row.kind === 'variation') (selection[row.categoryKey] ||= []).push(row.label);
    else if (row.kind === 'canon') (canonSelection[row.categoryKey] ||= []).push(row.label);
    else sheetSelection.push(row.label);
  }
  return { selection, canonSelection, sheetSelection };
}

async function loadUniverses(params) {
  const id = typeof params?.universeId === 'string' ? params.universeId.trim() : '';
  if (!id || id === 'all') return listUniverses();
  // A universe deleted since the job was configured must not wedge the family —
  // report zero pending and let the next job in the plan take the window.
  return getUniverse(id).then((universe) => [universe]).catch(() => []);
}

/**
 * Rows this job would render next, capped to `maxEntries`, plus the total
 * backlog so the page can show "10 of 143".
 */
async function collect(params) {
  const max = Math.min(50, Math.max(1, Number(params?.maxEntries) || DEFAULT_MAX_ENTRIES));
  const scope = typeof params?.scope === 'string' ? params.scope : 'all';
  const universes = await loadUniverses(params);
  const batches = [];
  let total = 0;
  for (const universe of universes) {
    const rows = findMissingImageEntries(universe, { scope });
    total += rows.length;
    if (!rows.length) continue;
    batches.push({ universe, rows });
  }
  // Cap ACROSS universes, taking whole universes in list order until the budget
  // is spent: one render batch is one `renderUniverseJobs` call against one
  // universe, so splitting the cap finer would mean several batches per run and
  // several collections provisioned for a single burn.
  const picked = [];
  let budget = max;
  for (const batch of batches) {
    if (budget <= 0) break;
    picked.push({ universe: batch.universe, rows: batch.rows.slice(0, budget) });
    budget -= Math.min(budget, batch.rows.length);
  }
  return { picked, total, max };
}

export async function countPending({ params } = {}) {
  const { picked, total } = await collect(params);
  const universeCount = picked.length;
  return {
    count: total,
    detail: total
      ? `${total} bible ${total === 1 ? 'entry has' : 'entries have'} no image (${universeCount} universe${universeCount === 1 ? '' : 's'} queued next)`
      : 'every bible entry already has an image',
  };
}

/**
 * Enqueue the next batch. The render backend resolves as
 * `params.mode` → the burning family's own image mode (when it has one) →
 * whatever the universe-bible render-target ladder decides. Pinning to the
 * family by default is the point of the job: a `codex` burn should spend
 * CODEX's image quota, not silently fall through to the install default and
 * burn a different provider's.
 */
export async function run({ params, job, family } = {}) {
  const { picked, total, max } = await collect(params);
  if (!picked.length) return { dispatched: false, reason: 'no bible entries are missing images' };

  const familyMode = CLOUD_IMAGE_GEN_MODES.includes(family?.id) ? family.id : undefined;
  const mode = (typeof params?.mode === 'string' && params.mode) || familyMode;
  const batch = picked[0];
  const { selection, canonSelection, sheetSelection } = buildRenderSelection(batch.rows);

  const result = await renderUniverseJobs(batch.universe.id, {
    promptMode: 'all',
    selection,
    canonSelection,
    sheetSelection,
    batchPerVariation: 1,
    mode,
    cloudModel: job?.model || undefined,
  }, (err) => err);

  console.log(`🔥 Quota-burn rendered ${result.promptCount} bible image(s) for "${batch.universe.name}" via ${result.mode}`);
  return {
    dispatched: true,
    summary: `Queued ${result.promptCount} image render${result.promptCount === 1 ? '' : 's'} for "${batch.universe.name}" via ${result.mode}`,
    detail: { universeId: batch.universe.id, runId: result.runId, jobIds: result.jobIds, mode: result.mode, backlog: total, cap: max },
  };
}
