/**
 * Burn job — fill in the blanks on universe bible entries that are named but
 * not actually described.
 *
 * PROGRAMMATIC: no agent is spawned. PortOS sends one headless expand prompt per
 * entry through the stage runner, pinned to the burning family's own CLI/TUI
 * provider, so a `codex` burn spends CODEX's subscription window.
 *
 * This is the step that belongs BEFORE `universe-bible-images` in a plan: an
 * image rendered from a character row holding only a name is a generic figure
 * that has to be thrown away, and it has already spent the image quota. Order
 * the two jobs describe→images in the family's rotation (and optionally set the
 * image job's `requireDescribed`) and the backlog gets described first, then
 * rendered from something worth rendering.
 *
 * "Not described" is `lib/universeBibleCompleteness.js`'s definition, at the
 * depth the job selects:
 *   - `core` — the entry is unusable without these (a character's
 *     physicalDescription / personality / background / motivations / visualNotes;
 *     a place's or object's description).
 *   - `full` — the whole sheet, which for a character is every field the
 *     character-sheet expand prompt fills.
 *
 * Category variations and composite sheets are deliberately out of scope: their
 * sanitizer already REQUIRES a prompt, so one cannot exist undescribed.
 */

import { expandUniverseCharacter } from '../universeCharacterExpand.js';
import { expandUniverseCanonEntry } from '../universeCanonEntryExpand.js';
import { getQuotaBurnInFlight, recordQuotaBurnInFlight } from '../quotaBurnStore.js';
import { BIBLE_FIELD, BIBLE_KIND, BIBLE_KINDS } from '../../lib/storyBible.js';
import { bibleEntryCompleteness, normalizeDescribeDepth } from '../../lib/universeBibleCompleteness.js';
import { collectUniverseBacklog } from './universeBacklog.js';
import { noProviderReason, resolveBurnProvider } from './providerPick.js';

/**
 * Scope value → the canon kinds it selects. Both the keys and the kind lists are
 * derived from `BIBLE_FIELD`, and the job catalog renders its option list from
 * the same `BIBLE_DESCRIBE_SCOPES` — so a future canon kind (or a renamed one)
 * reaches the picker and the form together instead of orphaning stored jobs
 * whose `scope` no longer matches anything.
 */
const SCOPE_KINDS = Object.freeze({
  all: BIBLE_KINDS,
  ...Object.fromEntries(BIBLE_KINDS.map((kind) => [BIBLE_FIELD[kind], [kind]])),
});

/**
 * One in-flight key per ENTRY (ids are unique, unlike the image job's labels),
 * namespaced so a described entry never shadows the same entry's pending render.
 */
export const describeInFlightKey = (universeId, kind, entryId) => `describe:${universeId}:${kind}:${entryId}`;

/**
 * Every under-described entry in one universe. Unordered — `sortRows` below is
 * what ranks the ones actually picked.
 */
export function findUnderdescribedEntries(universe, { scope = 'all', depth = 'full' } = {}) {
  const kinds = SCOPE_KINDS[scope] || SCOPE_KINDS.all;
  const rows = [];
  for (const kind of kinds) {
    for (const entry of universe?.[BIBLE_FIELD[kind]] || []) {
      // Locked entries are protected from every AI rewrite path; picking one
      // would spend a dispatch on an expand that returns `{ locked: true }`
      // without an LLM call and changes nothing.
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
 * Emptiest first, by the FRACTION of the entry's own sheet that is blank rather
 * than the raw gap count. Raw counts would rank by kind rather than by need: a
 * character sheet has ~31 fields and an object two, so every half-written
 * character in the cast would outrank a completely blank object forever, and on
 * a large cast the places and objects would never be reached. The absolute gap
 * breaks ties (between two equally-empty entries the bigger one buys more per
 * call) and the id breaks those, so repeated runs walk a stable backlog rather
 * than reshuffling it.
 */
export const sortByEmptiest = (rows) =>
  [...rows].sort((a, b) => b.blankRatio - a.blankRatio || b.missing - a.missing || a.id.localeCompare(b.id));

/**
 * Rows this job would describe next, plus the total backlog so the page can say
 * "10 of 143". The universe walk + one-universe-per-run rule are shared with the
 * image job (`universeBacklog.js`).
 */
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
 * The provider this job would prompt through, or null when the family has none.
 *
 * Same rule the image job applies to render backends: a family with no usable
 * provider must NOT fall through to the install's active provider, or the expand
 * calls would spend a DIFFERENT subscription while this family's window expires
 * unused and its dispatch cap is charged for the privilege.
 */
export const resolveDescribeProvider = ({ job, family }) =>
  // Headless one-shot prompts, not a watchable agent session — see `providerForFamily`.
  resolveBurnProvider({ job, family, prefer: 'cli' });

export async function countPending({ params, job, family } = {}) {
  const provider = await resolveDescribeProvider({ job, family });
  if (!provider) return { count: 0, detail: noProviderReason(family) };
  const collected = await collect(params, await getQuotaBurnInFlight());
  const { picked, total, depth } = collected;
  const next = picked?.rows.length || 0;
  return {
    count: total,
    // Handed back to run() by the runner so the bible scan + provider lookup
    // happen once per dispatch instead of twice — see the registry's contract.
    context: { ...collected, provider },
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
 * Describe the next batch, one LLM call per entry, sequentially.
 *
 * Sequential rather than fanned out on purpose: the whole point is to draw a
 * subscription window down at a steady rate, and a parallel fan-out against a
 * CLI provider mostly produces rate-limit refusals — which the denial ledger
 * then reads as "this family's short window is spent".
 *
 * A per-entry failure is absorbed, not propagated: one entry whose expand came
 * back empty must not discard the batch's earlier successes (the registry turns
 * a throw into "this job declined", which would also mean the successful writes
 * went unreported).
 */
export async function run({ params, job, family, context, force = false } = {}) {
  const provider = context?.provider ?? await resolveDescribeProvider({ job, family });
  if (!provider) return { dispatched: false, reason: noProviderReason(family) };

  // Reuse the probe's scan when the runner supplied it; the page's force path
  // calls run() with no probe, so fall back to scanning here. A forced run
  // ignores the cooldown: the user clicked ▶ on this exact job.
  const collected = context ?? await collect(params, force ? new Set() : await getQuotaBurnInFlight());
  const { picked, total, max, depth } = collected;
  if (!picked) return { dispatched: false, reason: 'every bible entry is already described' };

  const options = { providerId: provider.id, model: job?.model || undefined, effort: job?.effort || undefined };
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

  // Every entry failing is a provider problem, not progress — report it as a
  // non-dispatch so the window's cap isn't charged for a burn that did nothing,
  // and return BEFORE the cooldown stamp: a provider that was down for one tick
  // must not park this batch for the ledger's whole six-hour TTL.
  if (outcome.described === 0 && outcome.failed === picked.rows.length) {
    return { dispatched: false, reason: `every expand failed via ${provider.id} — ${failures[0] || 'unknown error'}` };
  }

  // Stamp EVERY attempted entry of a batch that got somewhere, including the
  // ones the model declined to fill. At `full` depth some fields are legitimately
  // meant to stay blank (the expand prompt tells the model to leave the Ghost→Need
  // chain alone for a bit-player), so an entry can be permanently "incomplete" —
  // without the cooldown the plan would re-pick the same handful every tick and
  // never reach the rest.
  await recordQuotaBurnInFlight(picked.rows.map((row) => describeInFlightKey(picked.universeId, row.kind, row.id)));

  console.log(`🔥 Quota-burn describe "${picked.universeName}" via ${provider.id} — described=${outcome.described} fields=${outcome.fields} skipped=${outcome.skipped} failed=${outcome.failed}`);
  return {
    dispatched: true,
    summary: `Described ${outcome.described} of ${picked.rows.length} bible entr${picked.rows.length === 1 ? 'y' : 'ies'} (${outcome.fields} field${outcome.fields === 1 ? '' : 's'}) in "${picked.universeName}" via ${provider.id}`,
    detail: {
      universeId: picked.universeId,
      providerId: provider.id,
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
