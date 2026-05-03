// Shared scene/character helpers used by both the storyboard sidebar and the
// (legacy) inline script result. Lives in its own module so SceneCard can be
// imported wherever scenes are rendered without dragging the whole AI panel.

// Mirror of server/lib/writersRoomStylePresets.js — kept in sync manually
// since client and server are separate bundles. Curated preset ids come from
// the /api/writers-room/style-presets endpoint at runtime; only the two
// special discriminators live here.
export const STYLE_ID = { NONE: 'none', CUSTOM: 'custom' };
export const EMPTY_IMAGE_STYLE = { presetId: STYLE_ID.NONE, prompt: '', negativePrompt: '' };

// Defaults for the per-scene image gen pipe. Klein-4B is the fastest FLUX.2
// variant on Apple Silicon, and 768×512 is a 3:2 aspect that suits scene work.
// steps + seed are stored as strings (or empty) so the form inputs can bind
// directly. Empty string = "use model default" for steps, "random per render"
// for seed. Parsed to numbers at the generateImage boundary in SceneCard.
export const WR_IMAGE_DEFAULTS = {
  modelId: 'flux2-klein-4b',
  mode: 'local',
  width: 768,
  height: 512,
  steps: '',
  seed: '',
};

export function readWrImageSettings(settings) {
  const stored = settings?.writersRoom?.imageGen || {};
  return {
    modelId: stored.modelId || WR_IMAGE_DEFAULTS.modelId,
    mode: stored.mode || WR_IMAGE_DEFAULTS.mode,
    width: Number.isFinite(stored.width) ? stored.width : WR_IMAGE_DEFAULTS.width,
    height: Number.isFinite(stored.height) ? stored.height : WR_IMAGE_DEFAULTS.height,
    steps: stored.steps != null && stored.steps !== '' ? String(stored.steps) : '',
    seed: stored.seed != null && stored.seed !== '' ? String(stored.seed) : '',
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

// Match server's normalizeSlugline in services/writersRoom/settings.js — the
// pair has to agree byte-for-byte or the bible's match keys won't line up
// with the live scene matching here.
export const normSlugline = (s) => String(s || '')
  .toUpperCase()
  .replace(/[—–-]/g, ' ')
  .replace(/[.,:;]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export function buildSettingByKey(allSettings) {
  const map = new Map();
  for (const setting of allSettings || []) {
    const key = normSlugline(setting.slugline || setting.name);
    if (!key) continue;
    map.set(key, setting);
  }
  return map;
}

export function matchSceneSetting(sceneSlugline, settingByKey) {
  if (!sceneSlugline) return null;
  return settingByKey?.get(normSlugline(sceneSlugline)) || null;
}

const PROMPT_MAX = 1900;

// Build the final image-gen prompt with priority order (diffusion models
// weight earlier tokens heaviest):
//   1. worldStyle preset (cinematic / film-noir / etc.) — broadest aesthetic
//   2. workTitle — gives the model story-context cues
//   3. setting baseline (description / palette / recurring details) — the place
//   4. Featuring — char1: desc, char2: desc — the subjects
//   5. scene.visualPrompt — what's NEW this beat
//
// Truncation priority is the inverse: visualPrompt survives unconditionally,
// then setting baseline, then characters. Style + title are short so they're
// always kept. Featuring drops characters one-by-one to fit; setting drops
// secondary fields (palette, recurring) before description.
export function buildScenePrompt(workTitle, scene, matchedCharacters, worldStyle = '', matchedSetting = null) {
  const stylePart = worldStyle && worldStyle.trim() ? `${worldStyle.trim()}. ` : '';
  const titlePart = workTitle ? `${workTitle}. ` : '';
  const visual = scene.visualPrompt || '';

  const settingFrags = matchedSetting ? [
    matchedSetting.description?.trim() || '',
    matchedSetting.palette ? `Palette: ${matchedSetting.palette.trim()}.` : '',
    matchedSetting.recurringDetails?.trim() || '',
  ].filter(Boolean) : [];

  const featuringFragments = (matchedCharacters || [])
    .filter((c) => c.physicalDescription && c.physicalDescription.trim())
    .map((c) => `${c.name}: ${c.physicalDescription.trim()}`);

  const PREFIX = 'Featuring — ';
  const reserveCore = stylePart.length + titlePart.length + visual.length + 4;
  let budget = PROMPT_MAX - reserveCore;

  // Setting first claim on remaining budget (place baseline > characters
  // for visual continuity across scenes).
  const settingFit = [];
  for (const frag of settingFrags) {
    const cost = (settingFit.length === 0 ? 0 : 1) + frag.length;
    if (cost > budget) break;
    settingFit.push(frag);
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
  if (settingFit.length > 0) segs.push(settingFit.join(' '));
  if (charFit.length > 0) segs.push(`${PREFIX}${charFit.join(' ')}`);
  if (visual) segs.push(visual);
  return segs.filter(Boolean).join(' ').slice(0, PROMPT_MAX);
}

// Backward-compatible alias — older callers (and tests) used the previous
// name. New code should use `buildScenePrompt` so the setting param is
// discoverable.
export const buildScenePromptWithCharacters = (workTitle, scene, matchedCharacters, worldStyle = '') =>
  buildScenePrompt(workTitle, scene, matchedCharacters, worldStyle, null);
