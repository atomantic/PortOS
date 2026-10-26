// Visual fields and tags seed both the editor and the one-click card action.
// Keep full descriptions: model limits must refuse, never silently truncate.
export const GENERATION_VISUAL_KEYS = [
  'physicalDescription', 'visualNotes', 'visualIdentity',
  'silhouetteNotes', 'postureNotes', 'specialTraits',
  'description', 'summary',
  'palette', 'recurringDetails', 'era', 'weather', 'intExt', 'timeOfDay',
];
export function buildGenerationPromptSeed(payload, typeDef, tags = []) {
  const parts = [];
  if (payload && typeof payload === 'object') {
    const keys = [typeDef?.primaryContentKey, ...GENERATION_VISUAL_KEYS].filter(Boolean);
    const seen = new Set();
    for (const k of keys) {
      if (seen.has(k)) continue;
      seen.add(k);
      const v = payload[k];
      if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
  }
  const tagList = Array.isArray(tags)
    ? tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  let seed = parts.join('. ');
  if (tagList.length) seed = seed ? `${seed}. ${tagList.join(', ')}` : tagList.join(', ');
  return seed;
}
