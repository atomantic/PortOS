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
import { getQuotaBurnInFlight, recordQuotaBurnInFlight } from '../quotaBurnStore.js';
import { QUOTA_BURN_BOUNDS } from '../../lib/quotaBurnConfig.js';

const CANON_TRUNKS = ['characters', 'places', 'objects'];
// Bounds come from the catalog descriptor the client renders its min/max from —
// hardcoding them here would let a raised cap change the accepted range in the
// form without changing what the job actually runs.
const ENTRY_BOUNDS = QUOTA_BURN_BOUNDS.maxEntries;

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
 * Rows this job would render next, plus the total backlog so the page can say
 * "10 of 143".
 *
 * ONE universe per run, capped to `maxEntries`: `run` makes a single
 * `renderUniverseJobs` call, which provisions one collection and one run
 * record. Spreading the budget across several universes (as an earlier version
 * did) produced a cap the run never honored and a status line that advertised
 * more universes than it touched.
 *
 * `inFlight` is the set of `<universeId>:<label>` keys this job has already
 * enqueued recently. `imageRefs` only fills in when a render COMPLETES, and a
 * cloud render routinely outlives the 5–720 minute tick interval — so without
 * this the next cycle re-selects the same entries and enqueues them again,
 * spending the whole window cap re-rendering the same handful and making zero
 * progress on the backlog.
 */
async function collect(params, inFlight = new Set()) {
  const max = Math.min(ENTRY_BOUNDS.max, Math.max(ENTRY_BOUNDS.min, Number(params?.maxEntries) || ENTRY_BOUNDS.default));
  const scope = typeof params?.scope === 'string' ? params.scope : 'all';
  const universes = await loadUniverses(params);
  let picked = null;
  let total = 0;
  for (const universe of universes) {
    // Labels are what `compilePrompts` selects on and they are NOT unique
    // (nothing dedupes them on write), so a case-insensitive dedupe here keeps
    // one row from expanding into several renders and blowing past the cap.
    const rows = dedupeByLabel(findMissingImageEntries(universe, { scope }))
      .filter((row) => !inFlight.has(inFlightKey(universe.id, row.label)));
    total += rows.length;
    if (!rows.length || picked) continue;
    picked = { universe, rows: rows.slice(0, max) };
  }
  return { picked, total, max };
}

export const inFlightKey = (universeId, label) => `${universeId}:${String(label).toLowerCase()}`;

/**
 * One row per case-insensitive label within a category/trunk. `compilePrompts`
 * matches a selection entry against EVERY variation whose label matches
 * case-insensitively, so two entries sharing a label (legal — no writer dedupes
 * them) turn one selected row into two enqueued renders, one of which may
 * already have an image.
 */
function dedupeByLabel(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.kind}:${row.categoryKey || ''}:${String(row.label).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The image backend this job would render through, or null when it cannot
 * resolve one it is willing to use.
 *
 * A family with no cloud image mode of its own (`claude` — it renders no
 * images) must NOT silently fall through to the install default: the renders
 * would spend a DIFFERENT provider's image quota while this family's window
 * expires unused and its dispatch cap is charged for the privilege. Pinning the
 * backend to the burning family is the entire point of the job, so a family
 * that can't be pinned needs an explicit `params.mode` or nothing happens.
 */
export function resolveRenderMode({ params, family }) {
  if (typeof params?.mode === 'string' && params.mode) return params.mode;
  return CLOUD_IMAGE_GEN_MODES.includes(family?.id) ? family.id : null;
}

export async function countPending({ params, family } = {}) {
  if (!resolveRenderMode({ params, family })) {
    return { count: 0, detail: `${family?.id} renders no images — pick a render backend on this job` };
  }
  const inFlight = await getQuotaBurnInFlight();
  const collected = await collect(params, inFlight);
  const { picked, total } = collected;
  const next = picked?.rows.length || 0;
  return {
    count: total,
    // Handed back to run() by the runner so the bible scan happens once per
    // dispatch instead of twice — see the registry's hook contract.
    context: collected,
    detail: total
      ? `${total} bible ${total === 1 ? 'entry has' : 'entries have'} no image — ${next} queued next from "${picked.universe.name}"`
      : 'every bible entry already has an image or is already queued',
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
export async function run({ params, job, family, context } = {}) {
  const mode = resolveRenderMode({ params, family });
  if (!mode) return { dispatched: false, reason: `${family?.id} renders no images — pick a render backend on this job` };

  // Reuse the probe's scan when the runner supplied it; the page's force path
  // calls run() with no probe, so fall back to scanning here.
  const { picked, total, max } = context ?? await collect(params, await getQuotaBurnInFlight());
  if (!picked) return { dispatched: false, reason: 'no bible entries are missing images' };

  const { selection, canonSelection, sheetSelection } = buildRenderSelection(picked.rows);

  const result = await renderUniverseJobs(picked.universe.id, {
    promptMode: 'all',
    selection,
    canonSelection,
    sheetSelection,
    batchPerVariation: 1,
    mode,
    cloudModel: job?.model || undefined,
  }, (err) => err);

  // Stamp the entries as enqueued BEFORE reporting success. `imageRefs` only
  // fills in when the render completes, so this cooldown is the only thing
  // stopping the next cycle from re-selecting the same entries and spending the
  // window's whole cap re-rendering them.
  await recordQuotaBurnInFlight(picked.rows.map((row) => inFlightKey(picked.universe.id, row.label)));

  console.log(`🔥 Quota-burn rendered ${result.promptCount} bible image(s) for "${picked.universe.name}" via ${result.mode}`);
  return {
    dispatched: true,
    summary: `Queued ${result.promptCount} image render${result.promptCount === 1 ? '' : 's'} for "${picked.universe.name}" via ${result.mode}`,
    detail: { universeId: picked.universe.id, runId: result.runId, jobIds: result.jobIds, mode: result.mode, backlog: total, cap: max },
  };
}
