// Shared scene/character helpers used by both the storyboard sidebar and the
// (legacy) inline script result. Lives in its own module so SceneCard can be
// imported wherever scenes are rendered without dragging the whole AI panel.

// Defaults for the per-scene image gen pipe. Klein-4B is the fastest FLUX.2
// variant on Apple Silicon, and 768×512 is a 3:2 aspect that suits scene work.
export const WR_IMAGE_DEFAULTS = {
  modelId: 'flux2-klein-4b',
  mode: 'local',
  width: 768,
  height: 512,
};

export function readWrImageSettings(settings) {
  const stored = settings?.writersRoom?.imageGen || {};
  return {
    modelId: stored.modelId || WR_IMAGE_DEFAULTS.modelId,
    mode: stored.mode || WR_IMAGE_DEFAULTS.mode,
    width: Number.isFinite(stored.width) ? stored.width : WR_IMAGE_DEFAULTS.width,
    height: Number.isFinite(stored.height) ? stored.height : WR_IMAGE_DEFAULTS.height,
  };
}

// LLM scene lists use bare names ("ARIA"), profiles may use full names
// ("Aria Reyes") or "the bartender" — strip leading "the " and lowercase so
// either side resolves to the same key.
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
    if (profile && !seen.has(profile.id)) {
      matched.push(profile);
      seen.add(profile.id);
    }
  }
  return matched;
}

const PROMPT_MAX = 1900;

// scene.visualPrompt is the load-bearing part of the image prompt — it must
// always survive truncation. Reserve room for style + title + visual prompt
// first, then fit the "Featuring" block into whatever is left, dropping
// characters one-by-one if needed. The world style goes FIRST because
// diffusion models weight early tokens heaviest.
export function buildScenePromptWithCharacters(workTitle, scene, matchedCharacters, worldStyle = '') {
  const stylePart = worldStyle && worldStyle.trim() ? `${worldStyle.trim()}. ` : '';
  const titlePart = workTitle ? `${workTitle}. ` : '';
  const visual = scene.visualPrompt || '';
  const featuringFragments = (matchedCharacters || [])
    .filter((c) => c.physicalDescription && c.physicalDescription.trim())
    .map((c) => `${c.name}: ${c.physicalDescription.trim()}`);
  const PREFIX = 'Featuring — ';
  const reserveForVisual = stylePart.length + titlePart.length + visual.length + 1;
  let budget = PROMPT_MAX - reserveForVisual - PREFIX.length;
  const fitFragments = [];
  for (const frag of featuringFragments) {
    const cost = (fitFragments.length === 0 ? 0 : 1) + frag.length;
    if (cost > budget) break;
    fitFragments.push(frag);
    budget -= cost;
  }
  const segs = [];
  if (stylePart) segs.push(stylePart.trim());
  if (titlePart) segs.push(titlePart.trim());
  if (fitFragments.length > 0) segs.push(`${PREFIX}${fitFragments.join(' ')}`);
  if (visual) segs.push(visual);
  return segs.filter(Boolean).join(' ').slice(0, PROMPT_MAX);
}
