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
 *      takes back only the paths the user selected.
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
import { sanitizeBibleField } from '../lib/storyBible.js';
import { shortId } from '../lib/fileUtils.js';
import {
  INTEGRITY_DIMENSIONS,
  buildCastIntegrityReport,
  characterFingerprint,
  characterIntegrityDepth,
  characterIntegrityDimensions,
  isAugmentableFieldPath,
  mergeSemanticFindings,
  readIntegrityField,
  withIntegrityField,
} from '../lib/characterIntegrity.js';

const REVIEW_STAGE = 'universe-cast-integrity-review';
const AUGMENT_STAGE = 'universe-character-augment';

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

/** The character record the review prompt sees — framework + the fields the dimensions judge against. */
const characterForReview = (entry) => ({
  id: entry.id,
  name: entry.name || '',
  role: entry.role || '',
  arcType: entry.arcType || null,
  depth: characterIntegrityDepth(entry),
  dimensions: characterIntegrityDimensions(entry),
  motivations: entry.motivations || '',
  ghost: entry.ghost || '',
  wound: entry.wound || '',
  lie: entry.lie || '',
  want: entry.want || '',
  need: entry.need || '',
  personality: entry.personality || '',
  background: entry.background || '',
  secrets: Array.isArray(entry.secrets) ? entry.secrets : [],
  psychology: entry.psychology || null,
  relationshipLinks: (Array.isArray(entry.relationshipLinks) ? entry.relationshipLinks : []).map((l) => ({
    targetCharacterId: l?.targetCharacterId || '',
    type: l?.type || 'custom',
    description: l?.description || '',
  })),
});

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

/** Field paths the caller may ask to augment, narrowed to string-valued integrity paths. */
const resolveAugmentPaths = (fields) => {
  const requested = Array.isArray(fields) ? fields : [];
  return [...new Set(requested.filter((f) => typeof f === 'string' && isAugmentableFieldPath(f)))];
};

/**
 * Propose sharper values for POPULATED fields. Writes nothing — the whole point
 * is that the author sees before/after and applies only what they accept ("AI
 * proposals are not automatically verified canon").
 */
export async function proposeCharacterAugmentation(universeId, entryId, {
  fields, providerId, model,
} = {}) {
  const universe = await getUniverse(universeId);
  const cast = castOf(universe);
  const target = cast.find((c) => c.id === entryId);
  if (!target) throw notFound(entryId);
  if (target.locked === true) return { locked: true, entry: target, proposals: [] };

  const paths = resolveAugmentPaths(fields);
  if (paths.length === 0) {
    throw new ServerError('No augmentable fields requested', {
      status: 400, code: 'UNIVERSE_CHARACTER_AUGMENT_NO_FIELDS',
    });
  }

  const { content, rationale, runId, providerId: usedProvider, model: usedModel } = await runPromptRefineRaw({
    templateName: AUGMENT_STAGE,
    variables: {
      characterJson: JSON.stringify(characterForReview(target), null, 2),
      fieldsJson: JSON.stringify(paths.map((path) => ({ field: path, current: readIntegrityField(target, path) })), null, 2),
      peersJson: JSON.stringify(
        cast.filter((c) => c.id !== entryId).map((c) => ({ id: c.id, name: c.name, role: c.role || '' })),
      ),
    },
    options: { providerId, model },
    source: AUGMENT_STAGE,
    logTag: null,
    emptyError: {
      code: 'UNIVERSE_CHARACTER_AUGMENT_EMPTY',
      message: 'LLM returned an empty augmentation',
    },
  });

  const requested = new Set(paths);
  const seen = new Set();
  const proposals = [];
  for (const raw of Array.isArray(content.proposals) ? content.proposals : []) {
    const field = typeof raw?.field === 'string' ? raw.field.trim() : '';
    // Only fields the user asked about, once each — a model that volunteers a
    // rewrite of an unrequested field would otherwise smuggle it into a preview
    // the author is about to bulk-accept.
    if (!requested.has(field) || seen.has(field)) continue;
    const after = typeof raw.value === 'string' ? raw.value.trim() : '';
    const before = readIntegrityField(target, field);
    if (!after || after === before) continue;
    seen.add(field);
    proposals.push({
      field,
      before,
      after,
      rationale: typeof raw.rationale === 'string' ? raw.rationale.trim() : '',
    });
  }

  return {
    entry: target,
    proposals,
    // The author reviews against THIS version of the character; apply refuses
    // if it moved on. Returned rather than stored, so there is no proposal
    // record to garbage-collect.
    fingerprint: characterFingerprint(target),
    rationale,
    runId,
    providerId: usedProvider || null,
    model: usedModel || null,
  };
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
  const accepted = (Array.isArray(fields) ? fields : [])
    .filter((f) => typeof f?.field === 'string' && isAugmentableFieldPath(f.field) && typeof f.value === 'string' && f.value.trim());
  if (accepted.length === 0) {
    throw new ServerError('No fields selected to apply', {
      status: 400, code: 'UNIVERSE_CHARACTER_AUGMENT_NO_SELECTION',
    });
  }

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
    if (fingerprint && characterFingerprint(current) !== fingerprint) {
      outcome = { ...outcome, stale: true };
      return null;
    }
    let next = current;
    const appliedFields = [];
    for (const { field, value } of accepted) {
      next = withIntegrityField(next, field, value.trim());
      appliedFields.push(field);
    }
    // Re-sanitize the touched containers so caps/enums are enforced on values
    // that came back from a model and then round-tripped through the client.
    const psychology = sanitizeBibleField('character', current, 'psychology', next.psychology);
    next = psychology ? { ...next, psychology } : next;
    for (const field of new Set(appliedFields.filter((f) => !f.includes('.')))) {
      next = { ...next, [field]: sanitizeBibleField('character', current, field, next[field]) };
    }
    outcome = { ...outcome, appliedFields };
    return { characters: list.map((c, i) => (i === idx ? next : c)) };
  });

  if (outcome.missing) throw notFound(entryId);
  if (outcome.stale) {
    throw new ServerError(
      'This character changed since the proposal was generated — re-run the review and try again.',
      { status: 409, code: 'UNIVERSE_CHARACTER_AUGMENT_STALE' },
    );
  }
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
