/**
 * Universe Character — LLM expansion.
 *
 * One LLM call that fleshes out blank fields on a universe canon character
 * without clobbering populated content. Strict "fill blanks only" semantics:
 *   - key absent from LLM response → preserve existing value
 *   - key present with empty string/array → IGNORED (no-op; expand flow has
 *     no "clear" intent — an empty proposal just means the LLM had nothing
 *     to add). Distinct from the CLAUDE.md merge convention used for
 *     direct-user PATCHes, where empty CAN mean clear.
 *   - key present with non-empty value → fill ONLY when target field is blank.
 */

import { getUniverse, updateUniverse } from './universeBuilder.js';
import { buildStyleClause } from './universeCanon.js';
import { runStagedLLM } from '../lib/stageRunner.js';
import { ServerError } from '../lib/errorHandler.js';
import { sanitizeCharacter } from '../lib/storyBible.js';

// Adding a new extended field on `sanitizeCharacter` requires adding it here
// too — otherwise the expand response key is silently dropped.
const STRING_FIELDS = Object.freeze([
  'pronouns', 'age', 'coreTheme', 'speechAccent', 'visualNotes',
  'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity',
  'motivations', 'likes', 'dislikes', 'mannerisms', 'relationships', 'skills',
]);
const LIST_FIELDS = Object.freeze([
  'stats', 'colorPalette', 'props', 'expressions', 'handGestures',
]);

// Distinct from universeCanon's peerForPrompt: the expand prompt benefits from
// the extended visual / theme fields for richer distinctness signals.
const peerForExpandPrompt = (entry) => ({
  id: entry.id,
  name: entry.name,
  role: entry.role || '',
  pronouns: entry.pronouns || '',
  physicalDescription: entry.physicalDescription || '',
  visualNotes: entry.visualNotes || '',
  coreTheme: entry.coreTheme || '',
});

const isAbsent = (v) => v === undefined || v === null;
const isBlankString = (v) => typeof v !== 'string' || v.trim() === '';
const isBlankArray = (v) => !Array.isArray(v) || v.length === 0;

/**
 * Pure no-clobber merge of an LLM payload onto a character. Exported so the
 * route tests can exercise the merge semantics without an LLM round-trip.
 */
export function applyExpansion(target, content) {
  if (!target || typeof target !== 'object' || !content || typeof content !== 'object') {
    return { merged: target, updatedFields: [] };
  }
  const merged = { ...target };
  const updatedFields = [];
  for (const field of STRING_FIELDS) {
    if (!(field in content)) continue;
    const proposed = content[field];
    if (isAbsent(proposed) || typeof proposed !== 'string') continue;
    if (!isBlankString(target[field])) continue;
    if (isBlankString(proposed)) continue;
    merged[field] = proposed.trim();
    updatedFields.push(field);
  }
  for (const field of LIST_FIELDS) {
    if (!(field in content)) continue;
    const proposed = content[field];
    if (isAbsent(proposed) || !Array.isArray(proposed)) continue;
    if (!isBlankArray(target[field])) continue;
    if (isBlankArray(proposed)) continue;
    // Sanitize the proposed list before recording the update. The bible
    // sanitizer drops rows missing required keys (stats without `label`,
    // props/expressions/gestures without `name`, palette without `name`),
    // so a raw acceptance would report `updatedFields: ['stats']` while
    // the persisted character actually saves `stats: []`. Run the proposal
    // through `sanitizeCharacter` (target's name carries the record so the
    // top-level sanitizer accepts it) and use the cleaned rows; skip the
    // field entirely when nothing survives.
    const sanitized = sanitizeCharacter(
      { name: target.name, [field]: proposed },
      { preserveTimestamps: false },
    );
    const cleaned = Array.isArray(sanitized?.[field]) ? sanitized[field] : [];
    if (cleaned.length === 0) continue;
    merged[field] = cleaned;
    updatedFields.push(field);
  }
  return { merged, updatedFields };
}

export async function expandUniverseCharacter(universeId, entryId, options = {}) {
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  const target = list[idx];
  if (target.locked === true) {
    return { universe, entry: target, locked: true, updatedFields: [] };
  }
  const peers = list.filter((_, i) => i !== idx);

  const { content, runId, providerId, model } = await runStagedLLM(
    'universe-character-expand',
    {
      styleClause: buildStyleClause(universe),
      characterJson: JSON.stringify(target),
      peersJson: JSON.stringify(peers.map(peerForExpandPrompt)),
    },
    {
      providerOverride: options.providerId,
      modelOverride: options.model,
      returnsJson: true,
      source: 'universe-character-expand',
    },
  );

  // Reject array AND non-object — `typeof [] === 'object'` would otherwise
  // let an LLM that returned `[{...}]` slip through `applyExpansion` as a
  // valid-but-empty payload (no string keys match) and silently no-op.
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new ServerError('LLM returned an empty character expansion', {
      status: 502, code: 'UNIVERSE_CHARACTER_EXPAND_EMPTY',
    });
  }

  const rationale = typeof content.rationale === 'string' ? content.rationale.trim() : '';

  // Re-derive the merge INSIDE the write queue against the freshest persisted
  // universe so a user edit (or another LLM call) that landed during the
  // expand LLM round-trip isn't silently overwritten. The mutator returns
  // null to short-circuit the write when nothing changed.
  let updatedFields = [];
  // Track WHY the write was skipped so the caller can distinguish "nothing
  // to fill" (no-op success) from "user locked the character mid-LLM-call"
  // (preserves the locked-character contract — UI shows the same "Locked"
  // badge it would for the pre-LLM-call lock check).
  let lockedDuringRender = false;
  const updated = await updateUniverse(universeId, (latest) => {
    const latestList = Array.isArray(latest.characters) ? latest.characters : [];
    const latestIdx = latestList.findIndex((e) => e.id === entryId);
    if (latestIdx < 0) return null;
    const latestTarget = latestList[latestIdx];
    // Re-check the lock — could have been set during the LLM call.
    if (latestTarget.locked === true) {
      lockedDuringRender = true;
      return null;
    }
    const { merged: next, updatedFields: fields } = applyExpansion(latestTarget, content);
    updatedFields = fields;
    if (fields.length === 0) return null;
    const nextList = latestList.map((e, i) => (i === latestIdx ? next : e));
    return { characters: nextList };
  });
  const latestEntry = (updated.characters || []).find((e) => e.id === entryId) || target;
  if (lockedDuringRender) {
    return { universe: updated, entry: latestEntry, locked: true, updatedFields: [], rationale, runId, providerId, model };
  }
  if (updatedFields.length === 0) {
    return { universe: updated, entry: latestEntry, rationale, runId, providerId, model, updatedFields };
  }
  console.log(`✨ Universe character expand — universe=${universeId.slice(0, 8)} entry=${entryId.slice(0, 8)} fields=${updatedFields.length} runId=${(runId || '').slice(0, 8)}`);
  return { universe: updated, entry: latestEntry, rationale, runId, providerId, model, updatedFields };
}

