/**
 * Scheduled handler `universe-bible-images` — render images for universe bible
 * entries that have none.
 *
 * PROGRAMMATIC: no agent is spawned. PortOS compiles the missing entries' render
 * prompts itself and enqueues them on the media job queue, exactly as the
 * Universe Builder's "Render" button does. The quota a render spends is the
 * CLOUD IMAGE backend's (codex `image_gen`, grok `image_gen`, agy
 * `generate_image`), which is why a Quota Burn step's render backend defaults to
 * the burning family's own mode. Run from CoS → Schedule there is no family to
 * pin to, so an unset backend falls through to the universe-bible render-target
 * ladder — see `resolveRenderMode`. Both paths go through this one
 * implementation; see `scheduledHandlers/index.js`.
 *
 * "Has no image" means the entry's `imageRefs[]` is empty — the same array the
 * collection hook appends a finished render's filename to. An entry that has
 * ever rendered successfully is skipped forever after, so repeated runs walk
 * down the backlog instead of re-rendering the same entries.
 */

import { getWorldCategoryKeys } from '../universeBuilder/sanitize.js';
import { renderUniverseJobs } from '../universeBuilderRender.js';
import { CLOUD_IMAGE_GEN_MODES } from '../imageGen/modes.js';
import { getQuotaBurnInFlight, recordQuotaBurnInFlight } from '../quotaBurnStore.js';
import { BIBLE_FIELD, BIBLE_KEYS, BIBLE_KINDS } from '../../lib/storyBible.js';
import { bibleEntryIsDescribed } from '../../lib/universeBibleCompleteness.js';
import { collectUniverseBacklog } from './universeBacklog.js';

// Universe array key → the canon kind `bibleEntryIsDescribed` measures. Derived
// from `BIBLE_FIELD` rather than hand-written, so a future canon kind flows
// through this walker the way `BIBLE_KEYS` promises.
const CANON_TRUNK_KIND = Object.freeze(Object.fromEntries(BIBLE_KINDS.map((kind) => [BIBLE_FIELD[kind], kind])));
const CANON_TRUNKS = BIBLE_KEYS;

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
 *
 * `requireDescribed` holds back canon entries that have no description yet, so a
 * plan that also runs the `universe-bible-describe` job spends its image quota
 * on entries worth rendering rather than on a name with nothing behind it. Only
 * canon can be under-described — a variation or composite sheet cannot exist
 * without its prompt (the sanitizer drops one that has none).
 */
export function findMissingImageEntries(universe, { scope = 'all', requireDescribed = false } = {}) {
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
        // `core` depth, not `full`: the gate is "is there anything to render
        // from", not "is the sheet finished". Holding a fully-described
        // character back because its `dislikes` is blank would park most of a
        // real universe behind a job the user may not even have configured.
        if (requireDescribed && !bibleEntryIsDescribed(CANON_TRUNK_KIND[trunk], entry, { depth: 'core' })) continue;
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

/**
 * Rows this job would render next, plus the total backlog so the page can say
 * "10 of 143". The universe walk and the one-universe-per-run rule are shared
 * with the describe job (`universeBacklog.js`).
 *
 * `inFlight` is the set of keys this job has already enqueued recently.
 * `imageRefs` only fills in when a render COMPLETES, and a cloud render
 * routinely outlives the 5–720 minute tick interval — so without this the next
 * cycle re-selects the same entries and enqueues them again, spending the whole
 * window cap re-rendering the same handful and making zero progress.
 */
async function collect(params, inFlight = new Set()) {
  const scope = typeof params?.scope === 'string' ? params.scope : 'all';
  const requireDescribed = params?.requireDescribed === true;
  const collected = await collectUniverseBacklog(params, {
    // Labels are what `compilePrompts` selects on and they are NOT unique
    // (nothing dedupes them on write), so a case-insensitive dedupe here keeps
    // one row from expanding into several renders and blowing past the cap.
    rowsFor: (universe) => dedupeByLabel(findMissingImageEntries(universe, { scope, requireDescribed }))
      .filter((row) => !inFlight.has(inFlightKey(universe.id, row))),
  });
  return { ...collected, requireDescribed };
}

// Keyed on the same identity `dedupeByLabel` uses. Label alone would let one
// enqueued variation hide an unrelated canon entry that happens to share its
// name for six hours — dropping it from both the pick AND the backlog count.
export const inFlightKey = (universeId, row) =>
  `${universeId}:${row.kind}:${row.categoryKey || ''}:${String(row.label).toLowerCase()}`;

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
 * The image backend to render through, as `{ mode, reason }`.
 *
 * `mode` is the backend id, or `undefined` for "let the universe-bible
 * render-target ladder decide" (what `renderUniverseJobs` does with no `mode`).
 * `reason` is set — and `mode` left null — only when the handler must REFUSE.
 * An explicit sentinel rather than a bare null because "nothing pinned, use the
 * install default" and "this family cannot render, do not spend" are opposite
 * outcomes that a single falsy value would collapse.
 *
 * An explicit `params.mode` always wins. Otherwise `family` decides:
 *
 *   - A QUOTA BURN passes one, and a family with no cloud image mode of its own
 *     (`claude` — it renders no images) must NOT silently fall through to the
 *     install default: the renders would spend a DIFFERENT provider's image quota
 *     while this family's window expires unused and its dispatch cap is charged
 *     for the privilege. Pinning the backend to the burning family is the entire
 *     point, so a family that can't be pinned needs an explicit `params.mode` or
 *     nothing happens.
 *   - An ORDINARY SCHEDULED RUN passes none. There is no window to protect, so
 *     an unset backend behaves like every other render PortOS enqueues.
 */
export function resolveRenderMode({ params, family } = {}) {
  if (typeof params?.mode === 'string' && params.mode) return { mode: params.mode };
  if (!family?.id) return { mode: undefined };
  return CLOUD_IMAGE_GEN_MODES.includes(family.id)
    ? { mode: family.id }
    : { mode: null, reason: `${family.id} renders no images — pick a render backend on this job` };
}

export async function countPending({ params, family } = {}) {
  const resolvedMode = resolveRenderMode({ params, family });
  if (resolvedMode.reason) return { count: 0, detail: resolvedMode.reason };
  const inFlight = await getQuotaBurnInFlight();
  const collected = await collect(params, inFlight);
  const { picked, total, requireDescribed } = collected;
  const next = picked?.rows.length || 0;
  return {
    count: total,
    // Handed back to run() by the runner so the bible scan happens once per
    // dispatch instead of twice — see the registry's hook contract.
    context: collected,
    detail: total
      ? `${total} bible ${total === 1 ? 'entry has' : 'entries have'} no image — ${next} queued next from "${picked.universeName}"`
      // Naming the description gate matters: with it on, a universe full of
      // blank canon rows reports zero pending, and "already has an image" would
      // read as a bug rather than as the filter doing its job.
      : `every bible entry already has an image${requireDescribed ? ', has no description yet,' : ''} or is already queued`,
  };
}

/**
 * Enqueue the next batch. The render backend resolves as `params.mode` → the
 * burning family's own image mode (a burn with a family that has one) →
 * whatever the universe-bible render-target ladder decides (an ordinary
 * scheduled run). Pinning to the family by default is the point of a BURN: a
 * `codex` burn should spend CODEX's image quota, not silently fall through to
 * the install default and burn a different provider's — a family with no image
 * mode is refused rather than redirected. See `resolveRenderMode`.
 */
export async function run({ params, job, family, context, force = false } = {}) {
  const { mode, reason } = resolveRenderMode({ params, family });
  if (reason) return { dispatched: false, reason };

  // Reuse the probe's scan when the runner supplied it; the page's force path
  // calls run() with no probe, so fall back to scanning here.
  // A forced run ignores the cooldown: the user clicked ▶ on this exact job, and
  // 'already queued' is the state they are most likely trying to push past.
  const { picked, total, max } = context ?? await collect(params, force ? new Set() : await getQuotaBurnInFlight());
  if (!picked) return { dispatched: false, reason: 'no bible entries are missing images' };

  const { selection, canonSelection, sheetSelection } = buildRenderSelection(picked.rows);

  const result = await renderUniverseJobs(picked.universeId, {
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
  await recordQuotaBurnInFlight(picked.rows.map((row) => inFlightKey(picked.universeId, row)));

  console.log(`🖼️ Bible images: rendered ${result.promptCount} bible image(s) for "${picked.universeName}" via ${result.mode}`);
  return {
    dispatched: true,
    summary: `Queued ${result.promptCount} image render${result.promptCount === 1 ? '' : 's'} for "${picked.universeName}" via ${result.mode}`,
    detail: { universeId: picked.universeId, runId: result.runId, jobIds: result.jobIds, mode: result.mode, backlog: total, cap: max },
  };
}
