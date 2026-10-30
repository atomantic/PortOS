// Casting > Design: rounds of face variations for one cast member.
//
// A take is an ordinary catalog reference whose role is `design:<roundId>:<n>`
// (n = its place in the round, since takes finish out of order),
// left out of likeness (so sheets, guides and conditioning never pick it) and
// carrying its variation line as review feedback. Pure helpers only, shared
// by the server service and the Design tab.

export const DESIGN_ROLE_PREFIX = 'design:';
export const DESIGN_MAX_TAKES = 12;
export const DESIGN_LINE_MAX = 1000;
export const DESIGN_NOTE_MAX = 2000;

export const isDesignRole = (role) => typeof role === 'string' && role.startsWith(DESIGN_ROLE_PREFIX);
export const designTakeRole = (roundId, index) => `${DESIGN_ROLE_PREFIX}${roundId}:${index}`;
const designParts = (role) => (isDesignRole(role) ? role.slice(DESIGN_ROLE_PREFIX.length).split(':') : null);
export const designRoundId = (role) => designParts(role)?.[0] || null;
export const designTakeIndex = (role) => {
  const n = Number(designParts(role)?.[1]);
  return Number.isInteger(n) ? n : 0;
};

export const DESIGN_FRAMINGS = Object.freeze({
  threeQuarterAway: { label: '3/4, looking off camera', text: 'Three-quarter view, head and shoulders, eyes looking off camera, never into the lens. Candid, unposed.' },
  profile: { label: 'Profile', text: 'Side profile, head and shoulders, looking away from the camera. Candid, unposed.' },
  lookingDown: { label: 'Looking down', text: 'Three-quarter view, head and shoulders, eyes lowered and looking down, away from the camera. Candid, unposed.' },
  front: { label: 'Front', text: 'Front view, head and shoulders, neutral expression.' },
  fullBody: { label: 'Full body', text: 'Full body, standing, three-quarter view, looking off camera. Candid, unposed.' },
});
export const DEFAULT_DESIGN_FRAMING = 'threeQuarterAway';

// A scale feature runs from its `less` end to its `more` end; a shape feature
// offers named shapes. The base face sits in the middle of the grid.
export const DESIGN_FEATURES = Object.freeze({
  noseSize: { label: 'Nose size', noun: 'nose', less: 'smaller', more: 'larger' },
  noseShape: { label: 'Nose shape', noun: 'nose', shapes: ['straight', 'with a bump on the bridge', 'hooked (Roman)', 'upturned', 'button', 'broad with a low bridge', 'long and narrow', 'with a rounded, bulbous tip'] },
  chin: { label: 'Chin', noun: 'chin', less: 'more receding', more: 'more prominent' },
  jaw: { label: 'Jaw', noun: 'jaw', less: 'narrower and softer', more: 'wider and squarer' },
  eyeSize: { label: 'Eye size', noun: 'eyes', less: 'smaller', more: 'larger' },
  eyeShape: { label: 'Eye shape', noun: 'eyes', shapes: ['hooded', 'deep-set', 'almond-shaped', 'round', 'downturned at the outer corners', 'upturned at the outer corners', 'wide-set', 'close-set'] },
  brows: { label: 'Brows', noun: 'eyebrows', less: 'thinner and lighter', more: 'thicker and heavier' },
  lips: { label: 'Lips', noun: 'lips', less: 'thinner', more: 'fuller' },
  cheekbones: { label: 'Cheekbones', noun: 'cheekbones', less: 'flatter', more: 'higher and more prominent' },
  faceLength: { label: 'Face length', noun: 'face', less: 'shorter and rounder', more: 'longer and narrower' },
});
const SCALE_STEPS = ['far', 'much', 'noticeably', 'slightly'];

/** The variation lines (one per take) for a feature grid, smallest to largest. */
export function featureLines(featureKey) {
  const f = DESIGN_FEATURES[featureKey];
  if (!f) return [];
  if (f.shapes) return f.shapes.map((shape) => `Make the ${f.noun} ${shape}.`);
  const side = (word, steps) => steps.map((step) => `Make the ${f.noun} ${step} ${word}.`);
  return [...side(f.less, SCALE_STEPS), ...side(f.more, [...SCALE_STEPS].reverse())];
}

export const BLEND_STEPS = Object.freeze(['a little (about a fifth of the way)', 'about a third of the way', 'halfway', 'mostly (about four fifths of the way)']);

export const DESIGN_MAX_BLEND_REFS = 3;
export const BLEND_MAX_STRENGTH_TAKES = 4;

/** Where the reference faces sit in the attached images (the base is always first). */
function blendTarget(refCount) {
  return refCount > 1 ? `a blend of the faces in images 2 to ${refCount + 1}` : 'the face in the second image';
}

/**
 * The variation lines for a blend toward one or more reference faces,
 * optionally limited to some features. Without a strength the round spreads
 * across BLEND_STEPS; with one, every take moves that far.
 */
export function blendLines(featureKeys = [], { refCount = 1, strength, count = 2 } = {}) {
  const nouns = [...new Set(featureKeys.map((key) => DESIGN_FEATURES[key]?.noun).filter(Boolean))];
  const only = nouns.length ? ` Change only the ${nouns.join(', ')}.` : '';
  const target = blendTarget(refCount);
  if (strength) return Array.from({ length: count }, () => `Move the face about ${strength}% of the way toward ${target}.${only}`);
  return BLEND_STEPS.map((step) => `Move the face ${step} toward ${target}.${only}`);
}
