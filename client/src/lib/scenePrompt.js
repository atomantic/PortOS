// Mirror of server/lib/scenePrompt.js — keep byte-for-byte in sync.
// The shape-invariant tests in server/lib/scenePrompt.test.js are the contract.

import { mapCanonDescriptorFragments, richCanonDescriptorFragments } from './canonPrompt.js';

const PROMPT_MAX = 1900;

export const normalizeSlugline = (s) => String(s || '')
  .toUpperCase()
  .replace(/[—–-]/g, ' ')
  .replace(/[.,:;]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export const normCharKey = (s) => String(s || '').trim().toLowerCase().replace(/^the\s+/, '');

export function buildCharByKey(allCharacters) {
  const map = new Map();
  for (const profile of allCharacters || []) {
    map.set(normCharKey(profile.name), profile);
    for (const alias of profile.aliases || []) map.set(normCharKey(alias), profile);
  }
  return map;
}

export function matchSceneCharacters(sceneCharacterNames = [], charByKey) {
  if (!Array.isArray(sceneCharacterNames) || !sceneCharacterNames.length) return [];
  const matched = [];
  const seen = new Set();
  for (const name of sceneCharacterNames) {
    const profile = charByKey?.get(normCharKey(name));
    if (profile && !seen.has(profile.id || profile.name)) {
      matched.push(profile);
      seen.add(profile.id || profile.name);
    }
  }
  return matched;
}

export function matchCharactersInText(text, allCharacters) {
  return matchEntriesByCandidates(text, allCharacters, (c) => [c.name, ...(c.aliases || [])]);
}

export function buildPlaceByKey(allSettings) {
  const map = new Map();
  for (const setting of allSettings || []) {
    const key = normalizeSlugline(setting.slugline || setting.name);
    if (!key) continue;
    map.set(key, setting);
  }
  return map;
}

export function matchScenePlace(sceneSlugline, placeByKey) {
  if (!sceneSlugline) return null;
  return placeByKey?.get(normalizeSlugline(sceneSlugline)) || null;
}

function matchEntriesByCandidates(text, entries, candidatesFn) {
  if (!text || !Array.isArray(entries) || !entries.length) return [];
  const haystack = String(text);
  const matched = [];
  const seen = new Set();
  const wordBoundary = (needle) => {
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Unicode-aware boundary instead of ASCII `\b`: a name starting/ending with a
    // non-ASCII letter (José, Élodie, Zoë) has no `\b` adjacent to the accented
    // char, so `\b…\b` would silently miss it. Lookarounds over `[\p{L}\p{N}_]`
    // with the `u` flag reproduce word-boundary semantics for all scripts
    // (still won't match "Mira" inside "Miranda").
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(haystack);
  };
  for (const entry of entries) {
    const key = entry.id || entry.name;
    if (!key || seen.has(key)) continue;
    const candidates = candidatesFn(entry).filter(Boolean);
    if (candidates.some(wordBoundary)) {
      matched.push(entry);
      seen.add(key);
    }
  }
  return matched;
}

export function matchPlacesInText(text, allPlaces) {
  return matchEntriesByCandidates(text, allPlaces, (p) => [p.name]);
}

export function matchObjectsInText(text, allObjects) {
  return matchEntriesByCandidates(text, allObjects, (o) => [o.name, ...(o.aliases || [])]);
}

// Append a user-selected wardrobe description AFTER physicalDescription
// without clobbering it — mirror of server/lib/scenePrompt.js#appendWardrobe.
function appendWardrobe(base, wardrobeDesc) {
  if (!wardrobeDesc) return base;
  const wearing = `Wearing: ${wardrobeDesc}`;
  if (!base) return wearing;
  const sep = /[.!?]$/.test(base) ? ' ' : '. ';
  return `${base}${sep}${wearing}`;
}

export function buildScenePrompt(workTitle, scene, matchedCharacters, worldStyle = '', matchedPlace = null) {
  const stylePart = worldStyle && worldStyle.trim() ? `${worldStyle.trim()}. ` : '';
  const titlePart = workTitle ? `${workTitle}. ` : '';
  const visual = scene?.visualPrompt || scene?.description || '';

  const intExtPart = matchedPlace?.intExt === 'INT'
    ? 'Interior'
    : matchedPlace?.intExt === 'EXT'
      ? 'Exterior'
      : '';
  const todPart = typeof matchedPlace?.timeOfDay === 'string' && matchedPlace.timeOfDay
    ? matchedPlace.timeOfDay
    : '';
  const placeMetaFrag = [intExtPart, todPart].filter(Boolean).join(', ');
  const baselineFrags = matchedPlace
    ? mapCanonDescriptorFragments(richCanonDescriptorFragments('place', matchedPlace), { trailingPeriod: true })
    : [];
  const placeFrags = matchedPlace ? [
    placeMetaFrag ? `${placeMetaFrag}.` : '',
    ...baselineFrags,
  ].filter(Boolean) : [];

  // Per-scene wardrobe picks: `scene.characterAppearances` is
  // [{ characterId, wardrobeId? }]. Mirror of server/lib/scenePrompt.js.
  const appearanceByCharId = new Map(
    (Array.isArray(scene?.characterAppearances) ? scene.characterAppearances : [])
      .filter((a) => a && a.characterId)
      .map((a) => [a.characterId, a]),
  );

  // Accept either `physicalDescription` (writers-room shape) or
  // `description` (pipeline shape) — the composer doesn't care which
  // field carries the visual descriptor.
  const featuringFragments = (matchedCharacters || [])
    .map((c) => {
      const base = (c.physicalDescription || c.description || '').trim();
      const appearance = appearanceByCharId.get(c.id);
      const wardrobe = appearance?.wardrobeId
        ? (c.wardrobes || []).find((w) => w && w.id === appearance.wardrobeId)
        : null;
      return { name: c.name, desc: appendWardrobe(base, (wardrobe?.description || '').trim()) };
    })
    .filter((c) => c.desc)
    .map((c) => `${c.name}: ${c.desc}`);

  const PREFIX = 'Featuring — ';
  const reserveCore = stylePart.length + titlePart.length + visual.length + 4;
  let budget = PROMPT_MAX - reserveCore;

  const placeFit = [];
  for (const frag of placeFrags) {
    const cost = (placeFit.length === 0 ? 0 : 1) + frag.length;
    if (cost > budget) break;
    placeFit.push(frag);
    budget -= cost;
  }

  budget -= PREFIX.length;
  const charFit = [];
  for (const frag of featuringFragments) {
    const cost = (charFit.length === 0 ? 0 : 1) + frag.length;
    if (cost > budget) break;
    charFit.push(frag);
    budget -= cost;
  }

  const segs = [];
  if (stylePart) segs.push(stylePart.trim());
  if (titlePart) segs.push(titlePart.trim());
  if (placeFit.length > 0) segs.push(placeFit.join(' '));
  if (charFit.length > 0) segs.push(`${PREFIX}${charFit.join(' ')}`);
  if (visual) segs.push(visual);
  return segs.filter(Boolean).join(' ').slice(0, PROMPT_MAX);
}
