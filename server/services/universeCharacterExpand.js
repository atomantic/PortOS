/**
 * Universe Character — LLM expansion.
 *
 * One LLM call that fleshes out blank fields on a universe canon character
 * without clobbering populated content. Merge follows the CLAUDE.md
 * "LLM response merging — distinguish absent vs intentionally empty"
 * convention: missing key = preserve, empty value = clear, populated proposal
 * = fill only when target field is blank.
 */

import { getUniverse, updateUniverse } from './universeBuilder.js';
import { buildStyleClause } from './universeCanon.js';
import { runStagedLLM } from '../lib/stageRunner.js';
import { ServerError } from '../lib/errorHandler.js';

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
    merged[field] = proposed;
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

  if (!content || typeof content !== 'object') {
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
  const updated = await updateUniverse(universeId, (latest) => {
    const latestList = Array.isArray(latest.characters) ? latest.characters : [];
    const latestIdx = latestList.findIndex((e) => e.id === entryId);
    if (latestIdx < 0) return null;
    const latestTarget = latestList[latestIdx];
    // Re-check the lock — could have been set during the LLM call.
    if (latestTarget.locked === true) return null;
    const { merged: next, updatedFields: fields } = applyExpansion(latestTarget, content);
    updatedFields = fields;
    if (fields.length === 0) return null;
    const nextList = latestList.map((e, i) => (i === latestIdx ? next : e));
    return { characters: nextList };
  });
  if (updatedFields.length === 0) {
    return { universe: updated, entry: (updated.characters || []).find((e) => e.id === entryId) || target, rationale, runId, providerId, model, updatedFields };
  }
  const updatedEntry = (updated.characters || []).find((e) => e.id === entryId) || null;
  console.log(`✨ Universe character expand — universe=${universeId.slice(0, 8)} entry=${entryId.slice(0, 8)} fields=${updatedFields.length} runId=${(runId || '').slice(0, 8)}`);
  return { universe: updated, entry: updatedEntry, rationale, runId, providerId, model, updatedFields };
}

