// Mirror of server/lib/scenePrompt.js — keep byte-for-byte in sync.
// The shape-invariant tests in server/lib/scenePrompt.test.js are the contract.

import { shortCanonDescriptorFragments } from './canonPrompt.js';

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

export function buildSettingByKey(allSettings) {
  const map = new Map();
  for (const setting of allSettings || []) {
    const key = normalizeSlugline(setting.slugline || setting.name);
    if (!key) continue;
    map.set(key, setting);
  }
  return map;
}

export function matchSceneSetting(sceneSlugline, settingByKey) {
  if (!sceneSlugline) return null;
  return settingByKey?.get(normalizeSlugline(sceneSlugline)) || null;
}

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

export function matchSettingsInText(text, allSettings) {
  return matchEntriesByCandidates(text, allSettings, (s) => [s.name]);
}

export function matchObjectsInText(text, allObjects) {
  return matchEntriesByCandidates(text, allObjects, (o) => [o.name, ...(o.aliases || [])]);
}

export function buildScenePrompt(workTitle, scene, matchedCharacters, worldStyle = '', matchedSetting = null) {
  const stylePart = worldStyle && worldStyle.trim() ? `${worldStyle.trim()}. ` : '';
  const titlePart = workTitle ? `${workTitle}. ` : '';
  const visual = scene?.visualPrompt || scene?.description || '';

  const intExtPart = matchedSetting?.intExt === 'INT'
    ? 'Interior'
    : matchedSetting?.intExt === 'EXT'
      ? 'Exterior'
      : '';
  const todPart = typeof matchedSetting?.timeOfDay === 'string' && matchedSetting.timeOfDay
    ? matchedSetting.timeOfDay
    : '';
  const settingMetaFrag = [intExtPart, todPart].filter(Boolean).join(', ');
  const baselineFrags = matchedSetting
    ? shortCanonDescriptorFragments('setting', matchedSetting)
      .map((f) => (f.prefix ? `${f.prefix}: ${f.value}.` : f.value))
    : [];
  const settingFrags = matchedSetting ? [
    settingMetaFrag ? `${settingMetaFrag}.` : '',
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

  const settingFit = [];
  for (const frag of settingFrags) {
    const cost = (settingFit.length === 0 ? 0 : 1) + frag.length;
    if (cost > budget) break;
    settingFit.push(frag);
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
  if (settingFit.length > 0) segs.push(settingFit.join(' '));
  if (charFit.length > 0) segs.push(`${PREFIX}${charFit.join(' ')}`);
  if (visual) segs.push(visual);
  return segs.filter(Boolean).join(' ').slice(0, PROMPT_MAX);
}
