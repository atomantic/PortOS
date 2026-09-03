/** Shared vocabulary only; procedural Three.js clip definitions remain separate. */
export const COS_STATE_CLIP_VOCABULARY = {
  sleeping: ['sleeping', 'sleep', 'sit', 'sitting'],
  thinking: ['idle', 'thinking'],
  coding: ['coding', 'typing', 'work'],
  investigating: ['investigating', 'investigate', 'scan', 'look'],
  reviewing: ['reviewing', 'review', 'yes', 'nod'],
  planning: ['planning', 'plan', 'thumbsup'],
  ideating: ['ideating', 'idea', 'dance'],
  speaking: ['speaking', 'talk', 'wave'],
};

const key = (value) => String(value || '').trim().toLowerCase();

/** Reports exactly which CoS states a real clip roster supports. */
export function buildClipCoverage(clipNames, vocabulary = COS_STATE_CLIP_VOCABULARY) {
  const availableClips = [...new Set((Array.isArray(clipNames) ? clipNames : []).filter((name) => typeof name === 'string' && name.trim()))];
  const byKey = new Map(availableClips.map((name) => [key(name), name]));
  const coverageByState = Object.fromEntries(Object.entries(vocabulary).map(([state, candidates]) => {
    const clip = (Array.isArray(candidates) ? candidates : []).map((candidate) => byKey.get(key(candidate))).find(Boolean) || null;
    return [state, { covered: Boolean(clip), clip }];
  }));
  const coveredStates = Object.keys(coverageByState).filter((state) => coverageByState[state].covered);
  const missingStates = Object.keys(coverageByState).filter((state) => !coverageByState[state].covered);
  return { availableClips, coverageByState, coveredStates, missingStates, complete: missingStates.length === 0 };
}
