/**
 * Photoreal look for a Place: how Blender dresses its greybox (materials, lights,
 * atmosphere). Stored on the place as `payload.photoreal`, beside `payload.greybox`.
 * Declarative only: presets are an allowlist the PortOS Blender script maps to
 * procedural node setups, so neither a provider nor the user ever sends code.
 *
 * Also the prompt contract and parser for "Dress with AI" (draft → preview →
 * apply), composed so Show full prompt names every word the model read (#11317).
 *
 * Dependency-light: zod, greyboxScene.js and jsonExtract.js only.
 */

import { z } from 'zod';
import { GREYBOX_LIMITS } from './greyboxScene.js';
import { extractJson } from './jsonExtract.js';

export const PHOTOREAL_LOOK_VERSION = 1;
export const PHOTOREAL_LOOK_LIMITS = Object.freeze({ MATERIALS: 200, LIGHTS: 64 });

// One line each: what the model reads and what the Blender script builds.
export const PHOTOREAL_MATERIAL_PRESETS = Object.freeze({
  'wood-floor': 'varnished hardwood boards with grain and wax sheen',
  'painted-wall': 'matte or eggshell painted plaster',
  'painted-metal': 'enamel-painted steel (rails, lockers, doors)',
  carpet: 'low-pile commercial carpet',
  tile: 'glazed or acoustic tile',
  concrete: 'sealed concrete or terrazzo',
  plastic: 'molded plastic or laminate (counters, benches)',
  vinyl: 'upholstery vinyl (booth seats, stools)',
  fabric: 'woven fabric or curtain',
  glass: 'clear or tinted glass',
  mirror: 'mirror glass (mirror-ball facets, wall mirrors)',
  chrome: 'polished chrome or bright metal',
  neon: 'glowing neon tube or lit sign face (uses emission)',
});
export const PHOTOREAL_PRESET_IDS = Object.freeze(Object.keys(PHOTOREAL_MATERIAL_PRESETS));
export const PHOTOREAL_LIGHT_TYPES = Object.freeze(['point', 'spot', 'area']);

const idSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coord = z.number().finite().min(-GREYBOX_LIMITS.COORD).max(GREYBOX_LIMITS.COORD);
const vec3 = z.tuple([coord, coord, coord]);
const unit = z.number().finite().min(0).max(1);

// A rule dresses every part of one zone, or one part. Later rules win, so a
// part rule after its zone's rule overrides it.
const materialSchema = z.object({
  id: idSchema,
  zone: idSchema.optional(),
  part: idSchema.optional(),
  preset: z.enum(PHOTOREAL_PRESET_IDS),
  color: colorSchema,
  roughness: unit.optional(),
  wear: unit.default(0),
  emission: z.number().finite().min(0).max(50).default(0),
}).refine((m) => Boolean(m.zone) !== Boolean(m.part), 'a material names exactly one zone or one part');

const lightSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(120).optional(),
  type: z.enum(PHOTOREAL_LIGHT_TYPES),
  position: vec3,
  // Spot and area lights aim at it; a point light ignores it.
  target: vec3.optional(),
  color: colorSchema.default('#ffffff'),
  watts: z.number().finite().positive().max(100000),
  size: z.number().finite().min(0).max(50).default(0.25),
  spotDegrees: z.number().finite().min(1).max(180).default(45),
});

const atmosphereSchema = z.object({
  haze: unit.default(0),
  worldColor: colorSchema.default('#0d0d10'),
  worldStrength: z.number().finite().min(0).max(10).default(0.3),
  exposure: z.number().finite().min(-10).max(10).default(0),
  // The blockout's directional sun; most interiors want it off.
  sun: z.boolean().default(false),
});

const duplicateIds = (items) => {
  const seen = new Set();
  return items.filter(({ id }) => (seen.has(id) ? true : (seen.add(id), false))).map(({ id }) => id);
};

export const photorealLookSchema = z.object({
  version: z.literal(PHOTOREAL_LOOK_VERSION).default(PHOTOREAL_LOOK_VERSION),
  materials: z.array(materialSchema).max(PHOTOREAL_LOOK_LIMITS.MATERIALS).default([]),
  lights: z.array(lightSchema).max(PHOTOREAL_LOOK_LIMITS.LIGHTS).default([]),
  atmosphere: atmosphereSchema.default({}),
}).superRefine((look, ctx) => {
  for (const key of ['materials', 'lights']) {
    for (const id of duplicateIds(look[key])) ctx.addIssue({ code: 'custom', message: `duplicate ${key} id "${id}"`, path: [key] });
  }
});

/** The stored look, validated; null when absent or no longer parseable. */
export function resolvePhotorealLook(payload) {
  const raw = payload?.photoreal;
  if (raw == null) return null;
  const parsed = photorealLookSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Zones and parts a look names that the greybox does not have. */
export function photorealLookReferenceErrors(look, scene) {
  const zones = new Set((scene?.zones || []).map((z2) => z2.id));
  const parts = new Set((scene?.parts || []).map((p) => p.id));
  return look.materials.flatMap((m) => [
    ...(m.zone && !zones.has(m.zone) ? [`material "${m.id}" names unknown zone "${m.zone}"`] : []),
    ...(m.part && !parts.has(m.part) ? [`material "${m.id}" names unknown part "${m.part}"`] : []),
  ]);
}

/** The look contract and authoring rules, sent ahead of the user's words. */
export function photorealLookContractInstructions() {
  return [
    'You dress a GREYBOX layout for a photorealistic Blender render: you choose materials for its zones and parts, place lights, and set the atmosphere. You do not move, add or remove geometry.',
    'Units are meters, Y up, the floor at y=0, matching the greybox positions you are given.',
    'Answer with ONE raw JSON object and nothing else, in exactly this shape:',
    `{"version":${PHOTOREAL_LOOK_VERSION},"materials":[...],"lights":[...],"atmosphere":{...}}`,
    '- materials: {"id","zone"|"part","preset","color":"#RRGGBB","roughness"?:0..1,"wear":0..1,"emission":0..50}. Name exactly one zone id or one part id from the greybox. Later entries override earlier ones, so put zone-wide rules first and part exceptions after. color is the base (or glow) color. wear adds scuffs, dirt and uneven sheen. emission is only for glowing surfaces.',
    `  presets: ${PHOTOREAL_PRESET_IDS.map((id) => `"${id}" (${PHOTOREAL_MATERIAL_PRESETS[id]})`).join(', ')}`,
    `- lights: {"id","label"?,"type":${PHOTOREAL_LIGHT_TYPES.map((t) => `"${t}"`).join('|')},"position":[x,y,z],"target"?:[x,y,z],"color":"#RRGGBB","watts":n,"size":m,"spotDegrees"?:n}. Spot and area lights aim at target. Real fixtures: ceiling panels ~200-800 W area lights, spots 500-2000 W, small accents 20-100 W. At most ${PHOTOREAL_LOOK_LIMITS.LIGHTS} lights, at most ${PHOTOREAL_LOOK_LIMITS.MATERIALS} materials.`,
    '- atmosphere: {"haze":0..1 (0 clear, 0.2 light smoke, 0.6 thick),"worldColor":"#RRGGBB","worldStrength":0..10,"exposure":-10..10 stops,"sun":true|false}. sun keeps a daylight sun; leave it false indoors.',
    'Every id is unique within its list, starts with a letter, and uses only letters, digits, "_" and "-".',
    'Stay faithful to the place description and the user\'s request. When editing, return the COMPLETE updated look (not a patch), keeping the ids of everything you did not change.',
  ].join('\n');
}

/** The greybox as the model needs it: zones and parts, compact, no cameras. */
export function photorealGreyboxBlock(scene) {
  const parts = scene.parts.map((p) => ({
    id: p.id, ...(p.label ? { label: p.label } : {}), ...(p.zone ? { zone: p.zone } : {}), type: p.type, position: p.position,
    ...(p.size ? { size: p.size } : {}), ...(p.radius ? { radius: p.radius } : {}), ...(p.height ? { height: p.height } : {}),
  }));
  return `Greybox zones and parts (JSON):\n${JSON.stringify({ zones: scene.zones, parts, landmarks: scene.landmarks.map(({ id, label, position }) => ({ id, label, position })) })}`;
}

export const photorealCurrentLookBlock = (look) => (look ? `Current look (JSON):\n${JSON.stringify(look)}` : '');

/** The one text the model reads: contract, place, greybox, current look, request. */
export function photorealLookPrompt({ instructions, placeBlock, greyboxBlock, currentBlock, request }) {
  return [
    instructions, '---', placeBlock, '---', greyboxBlock,
    ...(currentBlock ? ['---', currentBlock] : []),
    '---', `${currentBlock ? 'Requested change' : 'Request'}:\n${request}`,
  ].join('\n\n');
}

/** The provider's answer as a validated look against this greybox; throws a readable Error. */
export function parsePhotorealLookAnswer(text, scene) {
  const { value } = extractJson(typeof text === 'string' ? text : '', {
    shapePredicate: (v) => v && typeof v === 'object' && !Array.isArray(v) && ('materials' in v || 'lights' in v),
  });
  if (!value) throw new Error('The model did not return a JSON look.');
  const parsed = photorealLookSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The look was invalid at ${issue.path.join('.') || 'the top level'}: ${issue.message}.`);
  }
  const [problem] = photorealLookReferenceErrors(parsed.data, scene);
  if (problem) throw new Error(`The look ${problem}.`);
  return parsed.data;
}
