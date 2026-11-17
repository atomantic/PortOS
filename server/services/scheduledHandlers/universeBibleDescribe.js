/**
 * Scheduled handler `universe-bible-describe`: fill in universe bible entries that are
 * named but not described.
 *
 * PROGRAMMATIC: one headless expand prompt per entry through the stage runner. From CoS →
 * Schedule it uses the task's provider pin (or the active provider); as a Quota Burn step
 * it is pinned to the burning family's own CLI/TUI provider. See `scheduledHandlers/index.js`.
 *
 * Order it BEFORE `universe-bible-images` in a plan: an image rendered from a name-only
 * row is a generic figure that wastes image quota.
 *
 * "Not described" is `lib/universeBibleCompleteness.js`'s definition at the job's depth:
 * `core` (fields the entry is unusable without) or `full` (every field the expand prompt
 * fills). Category variations and composite sheets are out of scope: their sanitizer
 * already REQUIRES a prompt.
 */

import { expandUniverseCharacter } from '../universeCharacterExpand.js';
import { expandUniverseCanonEntry } from '../universeCanonEntryExpand.js';
import { getQuotaBurnInFlight, recordQuotaBurnInFlight } from '../quotaBurnStore.js';
import { BIBLE_FIELD, BIBLE_KIND, BIBLE_KINDS } from '../../lib/storyBible.js';
import { bibleEntryCompleteness, normalizeDescribeDepth } from '../../lib/universeBibleCompleteness.js';
import { collectUniverseBacklog } from './universeBacklog.js';
import { noProviderReason, resolveBurnProvider } from './providerPick.js';

/**
 * Scope value → canon kinds, derived from `BIBLE_FIELD` (the job catalog renders its
 * options from the same `BIBLE_DESCRIBE_SCOPES`) so a new or renamed kind cannot orphan stored jobs.
 */
const SCOPE_KINDS = Object.freeze({
  all: BIBLE_KINDS,
  ...Object.fromEntries(BIBLE_KINDS.map((kind) => [BIBLE_FIELD[kind], [kind]])),
});

/** One in-flight key per ENTRY, namespaced so it never shadows the same entry's pending render. */
export const describeInFlightKey = (universeId, kind, entryId) => `describe:${universeId}:${kind}:${entryId}`;

/** Every under-described entry in one universe, unordered (`sortRows` ranks the picked ones). */
export function findUnderdescribedEntries(universe, { scope = 'all', depth = 'full' } = {}) {
  const kinds = SCOPE_KINDS[scope] || SCOPE_KINDS.all;
  const rows = [];
  for (const kind of kinds) {
    for (const entry of universe?.[BIBLE_FIELD[kind]] || []) {
      // Locked entries are protected from AI rewrites; the expand would spend a dispatch and change nothing.
      if (!entry?.id || entry.locked === true) continue;
      const { missing, required } = bibleEntryCompleteness(kind, entry, { depth });
      if (missing.length === 0) continue;
      rows.push({
        kind,
        id: entry.id,
        label: entry.name || entry.slugline || entry.id,
        missing: missing.length,
        blankRatio: required ? missing.length / required : 0,
      });
    }
  }
  return rows;
}

/**
 * Emptiest first by the FRACTION of the entry's sheet that is blank, not raw gap count
 * (a character has ~31 fields, an object two, so raw counts would starve places and
 * objects). Ties: larger absolute gap, then id, for a stable backlog order.
 */
export const sortByEmptiest = (rows) =>
  [...rows].sort((a, b) => b.blankRatio - a.blankRatio || b.missing - a.missing || a.id.localeCompare(b.id));

/** Rows this job would describe next plus the total backlog; the walk is shared with the image job (`universeBacklog.js`). */
async function collect(params, inFlight = new Set()) {
  const scope = typeof params?.scope === 'string' ? params.scope : 'all';
  const depth = normalizeDescribeDepth(params?.depth);
  const collected = await collectUniverseBacklog(params, {
    rowsFor: (universe) => findUnderdescribedEntries(universe, { scope, depth })
      .filter((row) => !inFlight.has(describeInFlightKey(universe.id, row.kind, row.id))),
    sortRows: sortByEmptiest,
  });
  return { ...collected, depth };
}

/**
 * Which provider this handler prompts through, as `{ providerId, reason }`. A QUOTA BURN
 * passes `family`: a family with no usable provider must NOT fall through to the active
 * provider (it would spend a different subscription), so no match gives `providerId: null`
 * plus the `reason`. An ordinary scheduled run uses the task's own pin or leaves null for
 * the stage runner; "no pin" is valid, never a refusal.
 */
export async function resolveDescribeProvider({ job, family } = {}) {
  if (!family?.id) return { providerId: job?.providerId || null };
  // Headless one-shot prompts, not a watchable agent session — see `providerForFamily`.
  const provider = await resolveBurnProvider({ job, family, prefer: 'cli' });
  return provider ? { providerId: provider.id } : { providerId: null, reason: noProviderReason(family) };
}

/** How a run reports the provider it used when nothing was pinned. */
const providerLabel = (providerId) => providerId || 'the active provider';

export async function countPending({ params, job, family } = {}) {
  const resolved = await resolveDescribeProvider({ job, family });
  if (resolved.reason) return { count: 0, detail: resolved.reason };
  const collected = await collect(params, await getQuotaBurnInFlight());
  const { picked, total, depth } = collected;
  const next = picked?.rows.length || 0;
  return {
    count: total,
    // Handed back to run() so the scan and provider lookup happen once per dispatch.
    context: { ...collected, providerId: resolved.providerId, providerResolved: true },
    detail: total
      ? `${total} bible ${total === 1 ? 'entry is' : 'entries are'} under-described (${depth}) — ${next} queued next from "${picked.universeName}"`
      : `every bible entry is described (${depth}) or was just attempted`,
  };
}

/** Route one row to the expand service that owns its kind. */
const expandRow = (universeId, row, options) => (row.kind === BIBLE_KIND.CHARACTER
  ? expandUniverseCharacter(universeId, row.id, options)
  : expandUniverseCanonEntry(universeId, row.kind, row.id, options));

/**
 * Describe the next batch, one LLM call per entry, sequentially: parallel fan-out against
 * a CLI provider yields rate-limit refusals that the denial ledger reads as a spent window.
 * A per-entry failure is absorbed so earlier successes in the batch are still reported.
 */
export async function run({ params, job, family, context, force = false } = {}) {
  // `providerResolved` is the sentinel, not `providerId` truthiness: an unpinned run resolves to a NULL pin.
  const resolved = context?.providerResolved === true
    ? { providerId: context.providerId }
    : await resolveDescribeProvider({ job, family });
  if (resolved.reason) return { dispatched: false, reason: resolved.reason };
  const { providerId } = resolved;

  // The page's force path has no probe, so scan here; a forced run ignores the cooldown.
  const collected = context ?? await collect(params, force ? new Set() : await getQuotaBurnInFlight());
  const { picked, total, max, depth } = collected;
  if (!picked) return { dispatched: false, reason: 'every bible entry is already described' };

  const options = { providerId: providerId || undefined, model: job?.model || undefined, effort: job?.effort || undefined };
  const outcome = { described: 0, fields: 0, skipped: 0, failed: 0 };
  const failures = [];
  for (const row of picked.rows) {
    const result = await expandRow(picked.universeId, row, options).catch((err) => ({ error: err.message }));
    if (result?.error) {
      outcome.failed += 1;
      if (failures.length < 3) failures.push(`${row.label}: ${result.error}`);
      continue;
    }
    const filled = result?.updatedFields?.length || 0;
    if (filled === 0) outcome.skipped += 1;
    else {
      outcome.described += 1;
      outcome.fields += filled;
    }
  }

  // All-failed is a provider problem: report a non-dispatch (no cap charge) BEFORE the
  // cooldown stamp so a one-tick outage doesn't park the batch for the ledger's TTL.
  if (outcome.described === 0 && outcome.failed === picked.rows.length) {
    return { dispatched: false, reason: `every expand failed via ${providerLabel(providerId)} — ${failures[0] || 'unknown error'}` };
  }

  // Stamp EVERY attempted entry, including ones the model declined to fill: at `full`
  // depth some fields legitimately stay blank, and without the cooldown the plan would
  // re-pick the same handful every tick.
  await recordQuotaBurnInFlight(picked.rows.map((row) => describeInFlightKey(picked.universeId, row.kind, row.id)));

  console.log(`📖 Bible describe "${picked.universeName}" via ${providerLabel(providerId)} — described=${outcome.described} fields=${outcome.fields} skipped=${outcome.skipped} failed=${outcome.failed}`);
  return {
    dispatched: true,
    summary: `Described ${outcome.described} of ${picked.rows.length} bible entr${picked.rows.length === 1 ? 'y' : 'ies'} (${outcome.fields} field${outcome.fields === 1 ? '' : 's'}) in "${picked.universeName}" via ${providerLabel(providerId)}`,
    detail: {
      universeId: picked.universeId,
      providerId: providerId || null,
      model: job?.model || null,
      effort: job?.effort || null,
      depth,
      ...outcome,
      failures,
      backlog: total,
      cap: max,
    },
  };
}
