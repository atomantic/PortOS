// Mirror of server/lib/scenePrompt.js — keep byte-for-byte in sync.
// The shape-invariant tests in server/lib/scenePrompt.test.js are the contract.

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

export function buildScenePrompt(workTitle, scene, matchedCharacters, worldStyle = '', matchedSetting = null) {
  const stylePart = worldStyle && worldStyle.trim() ? `${worldStyle.trim()}. ` : '';
  const titlePart = workTitle ? `${workTitle}. ` : '';
  const visual = scene?.visualPrompt || scene?.description || '';

  const settingFrags = matchedSetting ? [
    matchedSetting.description?.trim() || '',
    matchedSetting.palette ? `Palette: ${matchedSetting.palette.trim()}.` : '',
    matchedSetting.recurringDetails?.trim() || '',
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
