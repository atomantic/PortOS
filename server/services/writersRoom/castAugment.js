/**
 * Writers Room — selective cast augmentation (the last remaining half of #6417).
 *
 * The synced review's Cast pane already reports where a character's authored
 * framework is thin (`syncedReview.js`, via the shared
 * `lib/characterIntegrity.js` contract). This is the write surface that answers
 * those findings: propose a sharper value for a populated-but-generic field,
 * show the author before/after, and take back only what they tick.
 *
 * Everything except the storage is shared with the Universe cast editor via
 * `services/characterAugmentation.js` — same prompt stage, same field contract,
 * same fingerprint rule. What this module owns is the per-work bible:
 *
 *   - Peers are the SIBLING CAST OF THIS WORK, never a universe roster. A work
 *     bible is work-local (`wr-char-` ids), and handing the model a universe's
 *     characters would push a Writers Room draft toward a cast it has not been
 *     promoted into.
 *   - The apply re-reads the entry through the store and re-checks the
 *     fingerprint immediately before writing, so an author edit made while the
 *     model was thinking is refused (409) rather than silently overwritten.
 *   - The write goes through `updateCharacter`, so the bible sanitizer,
 *     `editableFields` and the `source: 'user'` stamp all apply exactly as they
 *     do for a hand edit. An augmented field is authored material the writer
 *     accepted, not an extraction.
 *
 * No provider call happens on read. Both entry points are explicit user actions.
 */

import { shortId } from '../../lib/fileUtils.js';
import { characterFingerprint } from '../../lib/characterIntegrity.js';
import {
  acceptedAugmentFields,
  applyAugmentationToCharacter,
  augmentationIsStale,
  noAugmentSelectionError,
  proposeAugmentation,
  staleAugmentError,
} from '../characterAugmentation.js';
import { listCharacters, updateCharacter } from './characters.js';
import { assertValidWorkId, notFound } from './_shared.js';

/** The work's cast plus the requested entry, or a 404 when it isn't in there. */
async function loadCast(workId, characterId) {
  assertValidWorkId(workId);
  const cast = (await listCharacters(workId)).filter((c) => c?.id);
  const entry = cast.find((c) => c.id === characterId);
  if (!entry) throw notFound('Character');
  return { cast, entry };
}

/**
 * Propose sharper values for populated framework fields. Writes nothing.
 */
export async function proposeWorkCharacterAugmentation(workId, characterId, {
  fields, providerId, model,
} = {}) {
  const { cast, entry } = await loadCast(workId, characterId);
  return proposeAugmentation({
    entry,
    peers: cast.filter((c) => c.id !== characterId),
    fields,
    providerId,
    model,
  });
}

/**
 * Apply the subset of a proposal the author accepted.
 *
 * Locked / deleted / edited-since are all checked against the record as it is
 * NOW, not against the copy the proposal was built from.
 */
export async function applyWorkCharacterAugmentation(workId, characterId, { fields = [], fingerprint } = {}) {
  const accepted = acceptedAugmentFields(fields);
  if (accepted.length === 0) throw noAugmentSelectionError();

  const { entry } = await loadCast(workId, characterId);
  if (entry.locked === true) return { locked: true, entry, appliedFields: [] };
  if (augmentationIsStale(entry, fingerprint)) throw staleAugmentError();

  const { next, appliedFields } = applyAugmentationToCharacter(entry, accepted);
  // Patch only the containers the merge actually touched: a whole-record patch
  // would hand every editable field back to the store on every apply, turning
  // an unrelated concurrent edit into a silent revert.
  const patch = {};
  for (const field of appliedFields) {
    const key = field.split('.')[0];
    patch[key] = next[key];
  }
  const updated = await updateCharacter(workId, characterId, patch);
  console.log(`🩹 Writers Room character augment — work=${shortId(workId)} entry=${shortId(characterId)} fields=${appliedFields.length}`);
  return {
    entry: updated,
    appliedFields,
    fingerprint: characterFingerprint(updated),
  };
}
