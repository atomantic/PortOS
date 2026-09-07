/**
 * Selective character augmentation — the surface-agnostic half (#6417).
 *
 * "Sharpen a field that is already written" is the same operation whether the
 * character lives in a universe's canon array or in a Writers Room work's
 * per-work bible: same field contract (`lib/characterIntegrity.js`), same
 * prompt, same before/after preview, same staleness rule. Only *where the
 * record is read from and written back to* differs.
 *
 * So the steps that do not depend on storage live here, and each caller keeps
 * the one that does:
 *
 *   - `proposeAugmentation` — one provider call over a character record the
 *     caller already loaded. Writes NOTHING; returns before/after per field
 *     plus the fingerprint the apply must match.
 *   - `applyAugmentationToCharacter` — the pure merge + re-sanitize, so the
 *     caller only has to persist the record it gets back.
 *   - `augmentationIsStale` / the shared error constructors — the guards both
 *     surfaces must enforce identically, because "the author edited this while
 *     the model was thinking" has exactly one correct answer (refuse, 409).
 *
 * Both callers run those guards against the FRESHEST record they can read —
 * `universeCastIntegrity.js` inside its write queue, `writersRoom/castAugment.js`
 * immediately before its store write — rather than against the copy the
 * proposal was generated from.
 *
 * The prompt stage is shared too. `universe-character-augment` is written
 * against the field contract, not against universes: every rule in it is about
 * what a `psychology.drives.status.fear` may say, so a second near-identical
 * template for Writers Room would be a clone that drifts, and renaming the
 * shipped stage would drop any install's customized copy of it.
 */

import { ServerError } from '../lib/errorHandler.js';
import { sanitizeBibleField } from '../lib/storyBible.js';
import {
  characterFingerprint,
  characterIntegrityDepth,
  characterIntegrityDimensions,
  isAugmentableFieldPath,
  readIntegrityField,
  withIntegrityField,
} from '../lib/characterIntegrity.js';

/** The shipped stage both surfaces render — see the module note. */
const CHARACTER_AUGMENT_STAGE = 'universe-character-augment';

/**
 * The character record the review/augment prompts see: the integrity framework
 * plus the fields the dimensions judge against. Deliberately NOT the whole
 * record — wardrobes, identity packs and image refs cost context and answer
 * none of the questions being asked.
 */
export const characterForReview = (entry) => ({
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

/** Field paths the caller may ask to augment, narrowed to string-valued integrity paths. */
const resolveAugmentPaths = (fields) => {
  const requested = Array.isArray(fields) ? fields : [];
  return [...new Set(requested.filter((f) => typeof f === 'string' && isAugmentableFieldPath(f)))];
};

/**
 * The `{ field, value }` pairs an apply may act on. Anything outside the
 * contract, or carrying a non-string / blank value, is dropped here rather than
 * reaching the merge — the route schema already rejects them, and this keeps a
 * direct service caller honest too.
 */
export const acceptedAugmentFields = (fields) => (Array.isArray(fields) ? fields : []).filter((f) => (
  typeof f?.field === 'string' && isAugmentableFieldPath(f.field)
  && typeof f.value === 'string' && f.value.trim()
));

const noAugmentFieldsError = () => new ServerError('No augmentable fields requested', {
  status: 400, code: 'CHARACTER_AUGMENT_NO_FIELDS',
});

export const noAugmentSelectionError = () => new ServerError('No fields selected to apply', {
  status: 400, code: 'CHARACTER_AUGMENT_NO_SELECTION',
});

export const staleAugmentError = () => new ServerError(
  'This character changed since the proposal was generated — re-run the review and try again.',
  { status: 409, code: 'CHARACTER_AUGMENT_STALE' },
);

/**
 * Whether `current` has moved since the proposal was generated against
 * `fingerprint`. An absent fingerprint is an unchecked apply (a direct service
 * caller), not a match — the caller decides whether to require one.
 */
export const augmentationIsStale = (current, fingerprint) => (
  !!fingerprint && characterFingerprint(current) !== fingerprint
);

/**
 * Propose sharper values for POPULATED fields of one character. Writes nothing
 * — the whole point is that the author sees before/after and applies only what
 * they accept ("AI proposals are not automatically verified canon").
 *
 * @param {object} args
 * @param {object} args.entry   the character to sharpen (already loaded by the caller)
 * @param {Array}  args.peers   sibling cast, so the model keeps this character distinct from them
 * @param {Array}  args.fields  requested integrity field paths
 */
export async function proposeAugmentation({ entry, peers = [], fields, providerId, model }) {
  if (entry?.locked === true) return { locked: true, entry, proposals: [] };

  const paths = resolveAugmentPaths(fields);
  if (paths.length === 0) throw noAugmentFieldsError();

  // Deferred: `refineHelpers` drags the whole staged-LLM runner, and this
  // module is reached from the Writers Room ROUTER — a static edge would pull
  // that subtree into every suite that mounts those routes (server/AGENTS.md,
  // "Import scoping").
  const { runPromptRefineRaw } = await import('./pipeline/refineHelpers.js');
  const { content, rationale, runId, providerId: usedProvider, model: usedModel } = await runPromptRefineRaw({
    templateName: CHARACTER_AUGMENT_STAGE,
    variables: {
      characterJson: JSON.stringify(characterForReview(entry), null, 2),
      fieldsJson: JSON.stringify(paths.map((path) => ({ field: path, current: readIntegrityField(entry, path) })), null, 2),
      peersJson: JSON.stringify(peers.map((c) => ({ id: c.id, name: c.name, role: c.role || '' }))),
    },
    options: { providerId, model },
    source: CHARACTER_AUGMENT_STAGE,
    logTag: null,
    emptyError: {
      code: 'CHARACTER_AUGMENT_EMPTY',
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
    const before = readIntegrityField(entry, field);
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
    entry,
    proposals,
    // The author reviews against THIS version of the character; apply refuses
    // if it moved on. Returned rather than stored, so there is no proposal
    // record to garbage-collect.
    fingerprint: characterFingerprint(entry),
    rationale,
    runId,
    providerId: usedProvider || null,
    model: usedModel || null,
  };
}

/**
 * Merge accepted proposals into a character record. Pure: the caller persists
 * the result through whatever store owns the record.
 *
 * Touched containers are re-sanitized so caps/enums are enforced on values that
 * came back from a model and then round-tripped through the client.
 */
export function applyAugmentationToCharacter(current, accepted) {
  let next = current;
  const appliedFields = [];
  for (const { field, value } of accepted) {
    next = withIntegrityField(next, field, value.trim());
    appliedFields.push(field);
  }
  const psychology = sanitizeBibleField('character', current, 'psychology', next.psychology);
  next = psychology ? { ...next, psychology } : next;
  for (const field of new Set(appliedFields.filter((f) => !f.includes('.')))) {
    next = { ...next, [field]: sanitizeBibleField('character', current, field, next[field]) };
  }
  return { next, appliedFields };
}
