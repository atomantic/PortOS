/**
 * Shared scene-prompt composer + bible matchers. Pure ESM, no Node-only
 * deps — mirrored to `client/src/lib/scenePrompt.js` for the client bundle.
 */

import { shortCanonDescriptorFragments } from './canonPrompt.js';

const PROMPT_MAX = 1900;

// Normalize a screenplay slugline so case/punctuation/dash variants collapse:
// `INT. KITCHEN — NIGHT` and `INT KITCHEN - NIGHT` both become `INT KITCHEN NIGHT`.
export const normalizeSlugline = (s) => String(s || '')
  .toUpperCase()
  .replace(/[—–-]/g, ' ')
  .replace(/[.,:;]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// LLM scenes name characters bare ("ARIA"); profiles may use full names
// ("Aria Reyes") or "the bartender". Strip leading "the " and lowercase.
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

/**
 * Scan a free-form text blob (panel/scene description) for any character
 * names or aliases from the bible. Word-boundary matching, case-insensitive.
 * Used when the visual record doesn't carry a structured character list (e.g.
 * storyboard scenes only have a free-text description). Keeps the prompt
 * grounded in bible-canonical descriptions for everyone the LLM named.
 */
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

// Shared word-boundary scanner used by the *-InText helpers below. Returns
// the entries whose `candidates(entry)` strings appear in the haystack.
function matchEntriesByCandidates(text, entries, candidatesFn) {
  if (!text || !Array.isArray(entries) || !entries.length) return [];
  const haystack = String(text);
  const matched = [];
  const seen = new Set();
  const wordBoundary = (needle) => {
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
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

// Scan free-form prose for bible-canonical places. Mirrors
// `matchCharactersInText` but tests against `name` (places have no aliases
// in the canonical schema — slugline is for screenplay matching, not prose).
export function matchPlacesInText(text, allPlaces) {
  return matchEntriesByCandidates(text, allPlaces, (p) => [p.name]);
}

// Scan free-form prose for bible-canonical objects. Mirrors
// `matchCharactersInText` — objects carry `name` + `aliases[]` per
// `server/lib/storyBible.js:PROMPT_FIELDS`.
export function matchObjectsInText(text, allObjects) {
  return matchEntriesByCandidates(text, allObjects, (o) => [o.name, ...(o.aliases || [])]);
}

/**
 * Compose the final image-gen prompt with priority order (diffusion models
 * weight earlier tokens heaviest):
 *   1. worldStyle preset (cinematic / film-noir / etc.) — broadest aesthetic
 *   2. workTitle — gives the model story-context cues
 *   3. setting baseline (description / palette / recurring details) — the place
 *   4. Featuring — char1: desc, char2: desc — the subjects
 *   5. scene.visualPrompt — what's NEW this beat
 *
 * Truncation priority is the inverse: visualPrompt survives unconditionally,
 * then setting baseline, then characters. Style + title are short so they're
 * always kept. Featuring drops characters one-by-one to fit; setting drops
 * secondary fields (palette, recurring) before description.
 *
 * Positional API kept for parity with the long-running Writers Room caller
 * (`SceneCard.jsx`) — adding new optional kwargs at the tail is fine.
 */
export function buildScenePrompt(workTitle, scene, matchedCharacters, worldStyle = '', matchedPlace = null) {
  const stylePart = worldStyle && worldStyle.trim() ? `${worldStyle.trim()}. ` : '';
  const titlePart = workTitle ? `${workTitle}. ` : '';
  const visual = scene?.visualPrompt || scene?.description || '';

  // INT/EXT + time-of-day claim the first setting slot — they're cheap
  // (≤30 chars combined) and load-bearing for lighting/composition cues
  // diffusion models actually weight.
  const intExtPart = matchedPlace?.intExt === 'INT'
    ? 'Interior'
    : matchedPlace?.intExt === 'EXT'
      ? 'Exterior'
      : '';
  const todPart = typeof matchedPlace?.timeOfDay === 'string' && matchedPlace.timeOfDay
    ? matchedPlace.timeOfDay
    : '';
  const placeMetaFrag = [intExtPart, todPart].filter(Boolean).join(', ');
  // Pull descriptor fragments via the shared canon-prompt helper so the
  // setting baseline shares the *SHORT* spec subset (description / Palette /
  // recurringDetails) with `KINDS[].descFor` (UI summary). Note:
  // `synthesizeCanonPrompt` uses the *RICH* spec — same helper, broader
  // field set (adds era / weather). Both call sites stay coherent via the
  // shared helper, but they are not byte-equivalent prompts. Trailing-period
  // on prefixed fragments preserves the pre-extraction "Palette: X." sentence
  // boundary so palette + recurringDetails don't run together when the
  // budget-truncation join collapses fragments with a single space.
  const baselineFrags = matchedPlace
    ? shortCanonDescriptorFragments('place', matchedPlace)
      .map((f) => (f.prefix ? `${f.prefix}: ${f.value}.` : f.value))
    : [];
  const placeFrags = matchedPlace ? [
    placeMetaFrag ? `${placeMetaFrag}.` : '',
    ...baselineFrags,
  ].filter(Boolean) : [];

  // Accept either `physicalDescription` (writers-room shape) or
  // `description` (pipeline shape) — the composer doesn't care which
  // field carries the visual descriptor.
  const featuringFragments = (matchedCharacters || [])
    .map((c) => ({ name: c.name, desc: (c.physicalDescription || c.description || '').trim() }))
    .filter((c) => c.desc)
    .map((c) => `${c.name}: ${c.desc}`);

  const PREFIX = 'Featuring — ';
  const reserveCore = stylePart.length + titlePart.length + visual.length + 4;
  let budget = PROMPT_MAX - reserveCore;

  // Setting first claim on remaining budget (place baseline > characters
  // for visual continuity across scenes).
  const placeFit = [];
  for (const frag of placeFrags) {
    const cost = (placeFit.length === 0 ? 0 : 1) + frag.length;
    if (cost > budget) break;
    placeFit.push(frag);
    budget -= cost;
  }

  // Then characters fill what's left, prefix included.
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

export const __testing = { PROMPT_MAX };
