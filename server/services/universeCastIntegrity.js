/**
 * Universe cast integrity — the review and repair half of #6415.
 *
 * Three operations over one contract (`server/lib/characterIntegrity.js`):
 *
 *   1. `getUniverseCastIntegrity` — the DETERMINISTIC pass. Zero provider
 *      calls, so a page load may run it. It also reports the `reviewScope`:
 *      the provider, model and character count a semantic review WOULD spend,
 *      resolved without executing anything, so the UI can name the cost before
 *      the user opts in (AGENTS.md: no cold-bootstrap LLM calls).
 *   2. `reviewUniverseCast` — the SEMANTIC pass, only ever from an explicit
 *      user action. One call per batch; the model's findings are validated back
 *      into the contract, and characters the batch didn't reach are reported
 *      `truncated` rather than silently passing.
 *   3. `proposeCharacterAugmentation` / `applyCharacterAugmentation` — the
 *      augment-POPULATED-fields action the existing expand deliberately can't
 *      do. Propose writes NOTHING and returns before/after per field; apply
 *      takes back only the paths the user selected. Both are thin wrappers over
 *      `characterAugmentation.js`, which Writers Room shares (#6417) — this
 *      module contributes only the universe read/write.
 *
 * Reports are derived, never stored, so "invalidate stale reports on relevant
 * edits" is a fingerprint comparison rather than a cache: `applyCharacterAugmentation`
 * refuses a proposal whose character changed underneath it (409), the same way
 * the expand runner re-derives its merge inside the write queue.
 */

import { getUniverse, updateUniverse } from './universeBuilder.js';
import { runPromptRefineRaw } from './pipeline/refineHelpers.js';
import { resolveStageContext } from './stageRunner.js';
import { ServerError } from '../lib/errorHandler.js';
import { shortId } from '../lib/fileUtils.js';
import {
  acceptedAugmentFields,
  applyAugmentationToCharacter,
  augmentationIsStale,
  characterForReview,
  noAugmentSelectionError,
  proposeAugmentation,
  staleAugmentError,
} from './characterAugmentation.js';
import {
  INTEGRITY_DIMENSIONS,
  buildCastIntegrityReport,
  characterFingerprint,
  mergeSemanticFindings,
} from '../lib/characterIntegrity.js';

const REVIEW_STAGE = 'universe-cast-integrity-review';

/**
 * How many characters one semantic review call covers. A cast larger than this
 * is reviewed in a bounded batch and the remainder is reported `truncated` —
 * the alternative (silently fanning out N provider calls from one click) is
 * exactly the runaway spend AGENTS.md forbids.
 */
export const CAST_REVIEW_BATCH_MAX = 12;

const notFound = (entryId) => new ServerError(`Character ${entryId} not found in universe`, {
  status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
});

const castOf = (universe) => (Array.isArray(universe?.characters) ? universe.characters.filter((c) => c?.id) : []);

/**
 * Ids the caller asked about, narrowed to ids that actually exist. `null` (the
 * default) means the whole cast — distinct from `[]`, which is an explicit
 * empty selection and reviews nobody.
 */
const resolveScopeIds = (cast, characterIds) => {
  if (!Array.isArray(characterIds)) return cast.map((c) => c.id);
  const live = new Set(cast.map((c) => c.id));
  return characterIds.filter((id) => live.has(id));
};

/**
 * The deterministic report plus the cost of the semantic review that would
 * follow. Makes NO provider call: `resolveStageContext` only resolves which
 * provider/model the stage would use.
 */
export async function getUniverseCastIntegrity(universeId, { characterIds = null } = {}) {
  const universe = await getUniverse(universeId);
  const cast = castOf(universe);
  const scopeIds = resolveScopeIds(cast, characterIds);
  const report = buildCastIntegrityReport(cast, { characterIds: scopeIds });

  // Best-effort: a universe with no provider configured yet must still be able
  // to render its deterministic report, so a resolution failure degrades to an
  // unnamed scope rather than failing the whole request.
  const resolved = await resolveStageContext(REVIEW_STAGE).catch(() => null);

  return {
    ...report,
    reviewScope: {
      characterIds: scopeIds.slice(0, CAST_REVIEW_BATCH_MAX),
      characterCount: Math.min(scopeIds.length, CAST_REVIEW_BATCH_MAX),
      // What the batch cap leaves for a second pass — surfaced so "review the
      // cast" never looks like it covered more than it did.
      remainingCount: Math.max(scopeIds.length - CAST_REVIEW_BATCH_MAX, 0),
      batchMax: CAST_REVIEW_BATCH_MAX,
      providerId: resolved?.provider?.id || null,
      providerName: resolved?.provider?.name || null,
      model: resolved?.model || null,
    },
  };
}

/**
 * Run the semantic review over a bounded batch. Explicit user action only.
 */
export async function reviewUniverseCast(universeId, { characterIds = null, providerId, model } = {}) {
  const universe = await getUniverse(universeId);
  const cast = castOf(universe);
  const scopeIds = resolveScopeIds(cast, characterIds);
  if (scopeIds.length === 0) {
    throw new ServerError('No characters selected for review', {
      status: 400, code: 'UNIVERSE_CAST_REVIEW_EMPTY',
    });
  }
  const batchIds = scopeIds.slice(0, CAST_REVIEW_BATCH_MAX);
  const truncated = scopeIds.length > batchIds.length;
  const batch = cast.filter((c) => batchIds.includes(c.id));

  const { content, rationale, runId, providerId: usedProvider, model: usedModel } = await runPromptRefineRaw({
    templateName: REVIEW_STAGE,
    variables: {
      castJson: JSON.stringify(batch.map(characterForReview), null, 2),
      dimensionsJson: JSON.stringify(INTEGRITY_DIMENSIONS, null, 2),
    },
    options: { providerId, model },
    source: REVIEW_STAGE,
    logTag: null,
    emptyError: {
      code: 'UNIVERSE_CAST_REVIEW_EMPTY_RESPONSE',
      message: 'LLM returned an empty cast integrity review',
    },
  });

  const base = buildCastIntegrityReport(cast, { characterIds: scopeIds });
  const report = mergeSemanticFindings(base, {
    characters: cast,
    findings: Array.isArray(content.findings) ? content.findings : [],
    reviewedIds: batchIds,
    truncated,
  });
  console.log(`🧭 Cast integrity review — universe=${shortId(universeId)} reviewed=${batchIds.length} findings=${report.findings.length} runId=${shortId(runId)}`);
  return {
    ...report,
    rationale,
    runId,
    truncated,
    reviewScope: {
      characterIds: batchIds,
      characterCount: batchIds.length,
      remainingCount: scopeIds.length - batchIds.length,
      batchMax: CAST_REVIEW_BATCH_MAX,
      providerId: usedProvider || null,
      providerName: null,
      model: usedModel || null,
    },
  };
}

/**
 * Propose sharper values for POPULATED fields of one universe character.
 * Storage is all this layer adds — the call, the field filtering and the
 * fingerprint live in `characterAugmentation.js`, shared with Writers Room.
 */
export async function proposeCharacterAugmentation(universeId, entryId, {
  fields, providerId, model,
} = {}) {
  const universe = await getUniverse(universeId);
  const cast = castOf(universe);
  const target = cast.find((c) => c.id === entryId);
  if (!target) throw notFound(entryId);
  return proposeAugmentation({
    entry: target,
    peers: cast.filter((c) => c.id !== entryId),
    fields,
    providerId,
    model,
  });
}

/**
 * Apply the subset of a proposal the author accepted.
 *
 * Refuses — rather than silently overwriting — when the character was locked,
 * deleted, or edited since the proposal was generated. All three are checked
 * INSIDE the write queue against the freshest record, for the same reason the
 * expand runner re-derives its merge there.
 */
export async function applyCharacterAugmentation(universeId, entryId, { fields = [], fingerprint } = {}) {
  const accepted = acceptedAugmentFields(fields);
  if (accepted.length === 0) throw noAugmentSelectionError();

  let outcome = { locked: false, stale: false, missing: false, appliedFields: [] };
  const updated = await updateUniverse(universeId, (latest) => {
    const list = Array.isArray(latest.characters) ? latest.characters : [];
    const idx = list.findIndex((c) => c.id === entryId);
    if (idx < 0) {
      outcome = { ...outcome, missing: true };
      return null;
    }
    const current = list[idx];
    if (current.locked === true) {
      outcome = { ...outcome, locked: true };
      return null;
    }
    if (augmentationIsStale(current, fingerprint)) {
      outcome = { ...outcome, stale: true };
      return null;
    }
    const { next, appliedFields } = applyAugmentationToCharacter(current, accepted);
    outcome = { ...outcome, appliedFields };
    return { characters: list.map((c, i) => (i === idx ? next : c)) };
  });

  if (outcome.missing) throw notFound(entryId);
  if (outcome.stale) throw staleAugmentError();
  const universe = updated || await getUniverse(universeId);
  const entry = castOf(universe).find((c) => c.id === entryId) || null;
  if (outcome.locked) return { locked: true, entry, universe, appliedFields: [] };
  console.log(`🩹 Character augment applied — universe=${shortId(universeId)} entry=${shortId(entryId)} fields=${outcome.appliedFields.length}`);
  return {
    universe,
    entry,
    appliedFields: outcome.appliedFields,
    fingerprint: entry ? characterFingerprint(entry) : null,
  };
}
