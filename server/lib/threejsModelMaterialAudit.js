/**
 * Audits material plausibility and lighting in an already-validated Three.js scene spec.
 */

import { resolveThreejsEnvironment } from './threejsModelEnvironment.js';
import { listSpecNames, tokenizeSpecIdentifier } from './threejsModelSpecNames.js';

// Material-plausibility gate. `threejsMaterialSchema` bounds every PBR channel
// to what Three.js itself accepts, which says nothing about whether the values
// describe the substance the material is named for: metalness 0.9 oak and
// transmission 1.0 steel both parse, and both light completely wrong.
//
// The priors below are per-family plausible ranges, keyed off tokens in the
// material's own id — the only name a material carries in the spec. Matching is
// deliberately conservative: a material keys a prior only when exactly ONE
// family's keywords appear in it, so an unrecognized id (`mat_primary`) or a
// genuinely mixed one (`wood_metal_trim`) produces no feedback rather than a
// wrong one. That trade is affordable because this gate NEVER clamps — a
// stylized model is entitled to break every prior here, and the only cost of a
// missed match is a skipped hint.
//
// Bounds are stated only where a family really constrains the channel, and only
// in the direction it constrains: `undefined` is "this family says nothing",
// which is different from a bound of 0. Channels left out entirely (thickness,
// iridescence, anisotropy, emissive) are art direction, not substance.
const MATERIAL_FAMILY_PRIORS = [
  {
    family: 'metal',
    keywords: ['metal', 'metallic', 'steel', 'iron', 'chrome', 'brass', 'bronze', 'copper', 'aluminum', 'aluminium', 'silver', 'gold', 'gilt', 'titanium', 'pewter', 'nickel', 'alloy', 'gunmetal'],
    // The one family with a metalness FLOOR: a bare metal surface that is not
    // metallic is the single most common way a generated spec reads as plastic.
    channels: { metalness: [0.6, 1], roughness: [0.02, 0.6], transmission: [0, 0.05], sheen: [0, 0.1] },
  },
  {
    family: 'wood',
    keywords: ['wood', 'wooden', 'timber', 'oak', 'walnut', 'birch', 'maple', 'pine', 'mahogany', 'teak', 'bamboo', 'plank', 'lumber'],
    channels: { metalness: [0, 0.15], roughness: [0.35, 1], transmission: [0, 0.05], sheen: [0, 0.3] },
  },
  {
    family: 'plastic',
    keywords: ['plastic', 'abs', 'pvc', 'nylon', 'resin', 'acrylic', 'vinyl', 'polymer', 'polycarbonate'],
    channels: { metalness: [0, 0.1], roughness: [0.05, 0.95], ior: [1.3, 1.8] },
  },
  {
    family: 'glass',
    keywords: ['glass', 'crystal', 'lens', 'glazing', 'pane', 'windshield', 'quartz'],
    // The transmission floor is the point of this entry: opaque "glass" is the
    // mirror image of the metalness case above.
    channels: { metalness: [0, 0.1], roughness: [0, 0.35], transmission: [0.4, 1], ior: [1.3, 1.9] },
  },
  {
    family: 'fabric',
    keywords: ['fabric', 'cloth', 'cotton', 'linen', 'wool', 'velvet', 'silk', 'canvas', 'denim', 'textile', 'felt', 'upholstery', 'curtain'],
    channels: { metalness: [0, 0.1], roughness: [0.5, 1], clearcoat: [0, 0.2], transmission: [0, 0.15] },
  },
  {
    family: 'ceramic',
    keywords: ['ceramic', 'porcelain', 'clay', 'terracotta', 'tile', 'earthenware'],
    channels: { metalness: [0, 0.1], roughness: [0.03, 0.7], transmission: [0, 0.2], ior: [1.3, 1.9] },
  },
  {
    family: 'rubber',
    keywords: ['rubber', 'tire', 'tyre', 'tread', 'silicone', 'neoprene', 'gasket'],
    channels: { metalness: [0, 0.1], roughness: [0.5, 1], clearcoat: [0, 0.2], transmission: [0, 0.05] },
  },
  {
    family: 'stone',
    keywords: ['stone', 'rock', 'granite', 'marble', 'concrete', 'cement', 'slate', 'brick', 'asphalt', 'sandstone'],
    channels: { metalness: [0, 0.15], roughness: [0.3, 1], transmission: [0, 0.1] },
  },
  {
    family: 'leather',
    keywords: ['leather', 'suede', 'hide'],
    channels: { metalness: [0, 0.1], roughness: [0.3, 0.95], transmission: [0, 0.05] },
  },
  {
    family: 'paper',
    keywords: ['paper', 'cardboard', 'carton', 'paperboard', 'parchment'],
    channels: { metalness: [0, 0.1], roughness: [0.5, 1], transmission: [0, 0.2] },
  },
];

// A keyword claimed by two families would silently resolve to whichever entry
// is declared last, which is exactly the confident-nonsense the ambiguity rule
// above exists to prevent — so a collision fails at import rather than at
// review time.
const MATERIAL_KEYWORD_FAMILIES = MATERIAL_FAMILY_PRIORS.reduce((map, prior) => {
  for (const keyword of prior.keywords) {
    const owner = map.get(keyword);
    if (owner) throw new Error(`material family keyword "${keyword}" is claimed by both ${owner.family} and ${prior.family}`);
    map.set(keyword, prior);
  }
  return map;
}, new Map());

// `basic` is unlit, so none of these channels reach the renderer at all; the
// physical-only ones are parsed for every type but only forwarded by
// `type: 'physical'` (see `createMaterial`). Reporting a channel that cannot
// affect the render would be a finding the user can do nothing useful with.
const MATERIAL_CHANNELS_BY_TYPE = {
  basic: [],
  standard: ['metalness', 'roughness'],
  physical: ['metalness', 'roughness', 'clearcoat', 'ior', 'transmission', 'sheen'],
};

// The channels that read off an ENVIRONMENT rather than off the punctual lights:
// with nothing to reflect, a conductor renders near-black and transmission,
// clearcoat and iridescence do essentially nothing. Same type filter as above —
// `basic` is unlit and the physical-only channels are forwarded only by
// `type: 'physical'` — so the note never names a channel that could not have
// rendered anyway. The metalness threshold is the metal family's own floor: a
// dielectric with a little metalness has almost nothing to lose here.
const REFLECTIVE_METALNESS_FLOOR = 0.6;
const REFLECTIVE_CHANNELS_BY_TYPE = {
  basic: [],
  standard: ['metalness'],
  physical: ['metalness', 'transmission', 'clearcoat', 'iridescence'],
};

// A channel counts as authored when it is above the floor its own absence would
// sit at: metalness has a real threshold, the rest are opt-in from zero.
const reflectiveChannelFloor = (channel) => (channel === 'metalness' ? REFLECTIVE_METALNESS_FLOOR : 0);

/**
 * The single family a material id names, or `null` when it names none or more
 * than one. Ambiguity is deliberately NOT resolved by precedence — picking one
 * of two competing substances is how a prior table starts producing confident
 * nonsense.
 */
const matchMaterialFamily = (id) => {
  const matched = new Set();
  for (const token of tokenizeSpecIdentifier(id)) {
    const prior = MATERIAL_KEYWORD_FAMILIES.get(token);
    if (prior) matched.add(prior);
  }
  return matched.size === 1 ? [...matched][0] : null;
};

/**
 * Report PBR channels whose values are implausible for the substance a material
 * id names. Advisory ONLY — nothing here rewrites a spec, because a stylized
 * model may legitimately break every prior in the table.
 *
 * @param {object} spec a spec that has already passed `threejsSculptSpecSchema`
 * @returns {{findings: Array, errorCount: number, warningCount: number, noteCount: number,
 *   materialCount: number, matchedMaterialCount: number}}
 */
export function evaluateThreejsMaterialPlausibility(spec) {
  const materials = (spec?.materials && typeof spec.materials === 'object') ? spec.materials : {};
  const findings = [];
  const unlitReflective = [];
  const environment = resolveThreejsEnvironment(spec);
  let matched = 0;

  for (const [id, material] of Object.entries(materials)) {
    if (environment.preset === 'none') {
      const reflective = (REFLECTIVE_CHANNELS_BY_TYPE[material?.type] || REFLECTIVE_CHANNELS_BY_TYPE.standard)
        .filter((channel) => {
          const value = material?.[channel];
          return typeof value === 'number' && Number.isFinite(value) && value > reflectiveChannelFloor(channel);
        });
      if (reflective.length > 0) unlitReflective.push({ id, channels: reflective });
    }
    const prior = matchMaterialFamily(id);
    if (!prior) continue;
    matched += 1;
    const channels = MATERIAL_CHANNELS_BY_TYPE[material?.type] || MATERIAL_CHANNELS_BY_TYPE.standard;
    const offenders = [];
    for (const channel of channels) {
      const range = prior.channels[channel];
      const value = material?.[channel];
      // A stored spec predating a channel reads back undefined — unevaluated,
      // not out of range.
      if (!range || typeof value !== 'number' || !Number.isFinite(value)) continue;
      const [min, max] = range;
      if (value >= min && value <= max) continue;
      offenders.push({ channel, value, min, max });
    }
    if (offenders.length === 0) continue;
    findings.push({
      code: 'implausible-material-values',
      severity: 'warning',
      materialIds: [id],
      family: prior.family,
      channels: offenders,
      message: `Material "${id}" reads as ${prior.family}, but ${offenders
        .map(({ channel, value, min, max }) => `${channel} ${value} is outside the ${min}–${max} a ${prior.family} surface normally sits in`)
        .join(', and ')}. Re-derive those channels from the substance (or rename the material if it is not ${prior.family} at all) — unless the look is deliberately stylized, in which case leave it.`,
    });
  }

  // One finding per implausible material, so the warning tally is also the count
  // of materials that failed — no separate tally that could disagree with it.
  const warningCount = findings.length;

  // One note for the whole spec rather than one per material: the remedy is a
  // single spec-level choice, and repeating it per material would bury the
  // substance warnings above it.
  if (unlitReflective.length > 0) {
    findings.push({
      code: 'reflective-material-without-environment',
      severity: 'note',
      materialIds: unlitReflective.map((entry) => entry.id),
      channels: unlitReflective,
      message: `${listSpecNames(unlitReflective.map((entry) => entry.id))} author reflective channels (${listSpecNames([...new Set(unlitReflective.flatMap((entry) => entry.channels))])}) while "environment.preset" is "none". Those channels read off an environment, so in this scene a conductor renders near-black and transmission, clearcoat and iridescence do essentially nothing — the values cannot be judged as authored. Give the spec an environment ("neutral" or "studio") to see them.`,
    });
  }

  return {
    findings,
    errorCount: 0,
    warningCount,
    noteCount: findings.length - warningCount,
    materialCount: Object.keys(materials).length,
    matchedMaterialCount: matched,
  };
}

/**
 * Default refinement feedback derived from a stored material-plausibility
 * result: the substance warnings, then the unlit-reflective note if the spec
 * authored reflective channels with no environment. Returns '' when there is
 * neither, so the caller falls through to whatever other feedback it has.
 */
export function buildThreejsMaterialFeedback(plausibility) {
  const findings = plausibility?.findings || [];
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const substance = warnings.length === 0 ? [] : [
    'The previous pass gave some materials values that do not match the substance they are named for:',
    ...warnings.map((finding, index) => `${index + 1}. ${finding.message}`),
    'Set each channel from what the surface actually is — bare metal is metallic and fairly smooth, wood and stone are rough dielectrics, glass transmits — and keep any deliberate stylization you still want.',
  ];
  // The unlit-reflective note is fed back as well as displayed: choosing an
  // environment preset is a change the next pass can actually make, and leaving
  // it out is what lets a refinement "fix" a black conductor by dropping its
  // metalness instead.
  const unlit = findings.filter((finding) => finding.code === 'reflective-material-without-environment');
  return [...substance, ...unlit.map((finding) => finding.message)].join('\n');
}
