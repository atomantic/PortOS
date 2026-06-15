/**
 * Character → trained-LoRA resolution. Always a LOCAL sidecar scan — the
 * character/universe record never stores a LoRA pointer (those records
 * federate; the weights don't). On a peer without the file, listLoras()
 * simply doesn't list it, so resolution degrades to "no LoRA" with no
 * dangling links.
 *
 * Matching: a trained sidecar carries `character: { entryId, entryKind,
 * ingredientId, universeId, name }`. Canon entries are keyed by per-universe
 * `entryId` AND catalog `ingredientId` — match on either, since some surfaces
 * (the catalog detail page) only know the ingredient id.
 *
 * Both resolution paths here are CHARACTER lookups, so a non-character
 * trained LoRA (object/place datasets now carry `entryKind: 'objects'|'places'`)
 * must never match — otherwise, in the newly supported case where the same
 * entry id exists in multiple bible kinds, an object/place LoRA would be
 * auto-applied to a character render. A legacy sidecar with no `entryKind`
 * predates the object/place feature and is therefore a character.
 */

import { listLoras } from './loras.js';

const matchesCharacter = (sidecarCharacter, { entryId = null, ingredientId = null }) => {
  if (!sidecarCharacter) return false;
  if ((sidecarCharacter.entryKind || 'characters') !== 'characters') return false;
  if (entryId && sidecarCharacter.entryId === entryId) return true;
  if (ingredientId && sidecarCharacter.ingredientId === ingredientId) return true;
  return false;
};

const isCompat = (lora, compatKey) => {
  if (!compatKey) return true;
  if (!lora.loraCompatKey) return false;
  // Bare 'flux2' (size unknown) is compatible with either sized key — same
  // tolerance the picker applies.
  return lora.loraCompatKey === compatKey
    || (compatKey.startsWith('flux2') && lora.loraCompatKey === 'flux2');
};

/**
 * Resolve trained LoRAs for a list of matched canon characters
 * (`[{ id?, ingredientId?, name }]` — pipeline character matches). Caps at
 * `max` so character LoRAs leave stacking room (MAX_LORAS=8) for the
 * user's style LoRAs. Returns
 * `[{ filename, scale, triggerWord, character }]`.
 */
export async function resolveCharacterLoras(matchedCharacters, { compatKey = null, max = 3 } = {}) {
  const characters = (matchedCharacters || []).filter(Boolean);
  if (!characters.length) return [];
  const loras = await listLoras();
  const trained = loras.filter((l) => l.source === 'trained' && l.character);
  const out = [];
  const usedFilenames = new Set();
  for (const character of characters) {
    if (out.length >= max) break;
    const match = trained.find((l) =>
      !usedFilenames.has(l.filename)
      && matchesCharacter(l.character, { entryId: character.id, ingredientId: character.ingredientId })
      && isCompat(l, compatKey));
    if (!match) continue;
    usedFilenames.add(match.filename);
    out.push({
      filename: match.filename,
      scale: Number.isFinite(match.recommendedScale) ? match.recommendedScale : 1.0,
      triggerWord: match.triggerWords?.[0] || null,
      character: match.character,
    });
  }
  return out;
}

/** Single-character variant for UI chips — returns all matches, newest first. */
export async function findLorasByCharacter({ entryId = null, ingredientId = null }) {
  if (!entryId && !ingredientId) return [];
  const loras = await listLoras();
  return loras
    .filter((l) => l.source === 'trained' && matchesCharacter(l.character, { entryId, ingredientId }))
    .map((l) => ({
      filename: l.filename,
      name: l.name,
      loraCompatKey: l.loraCompatKey,
      triggerWords: l.triggerWords,
      recommendedScale: l.recommendedScale,
      character: l.character,
      datasetId: l.trainedFromDatasetId || null,
      installedAt: l.installedAt,
    }));
}
