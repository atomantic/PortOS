/**
 * Subject-family checklists for Three.js model generation.
 *
 * `evaluateThreejsPartCoverage` proves a spec built what it promised, never that
 * it promised enough — a component nobody noticed is never inventoried, never
 * specified, and passes every structural gate. A family checklist closes that
 * direction: for a coarse subject family, the components a faithful
 * reconstruction has to account for, the material zones worth separating, the
 * axes a reviewer should judge, and the orbit views that expose the usual
 * failures.
 *
 * The cost of a taxonomy is that a THIN one is worse than none — it teaches the
 * model to stop at the checklist. Two things hold that off:
 *
 * 1. `general` is the default and splices nothing, so a user who does not opt in
 *    gets exactly the general-purpose prompt that shipped before this existed.
 * 2. Every spliced block says outright that the list is a floor, that the
 *    inventory must still carry everything else visible, and that a component
 *    genuinely absent from the reference belongs in `limitations` with a reason.
 *
 * Families are deliberately coarse and few. A component is matched textually
 * against the spec's own words, so the resulting findings are `warning`, never
 * `error` — the gate should not claim certainty a substring match cannot carry.
 */

/** The no-op family. Selecting it (or nothing) leaves generation unchanged. */
export const GENERAL_FAMILY_ID = 'general';

/**
 * @typedef {object} ThreejsModelFamily
 * @property {string} id stable id persisted on the record
 * @property {string} label human label for the picker
 * @property {string} description one line telling the user when to pick it
 * @property {Array<{name: string, aliases: string[]}>} components required components; `aliases` are
 *   the lowercase substrings that count as evidence the component was accounted for
 * @property {string[]} materialZones surfaces worth separating into their own material
 * @property {string[]} reviewAxes what a reviewer should judge the result on
 * @property {string[]} orbitViews the camera angles worth checking before accepting the model
 */

/** @type {ThreejsModelFamily[]} */
const FAMILY_DEFINITIONS = [
  {
    id: 'character',
    label: 'Character / creature',
    description: 'Humanoids, animals, and creatures — anything with a body plan and articulation.',
    components: [
      { name: 'Head', aliases: ['head', 'skull', 'cranium', 'muzzle', 'snout'] },
      { name: 'Eyes', aliases: ['eye', 'eyes', 'iris', 'pupil', 'eyeball', 'visor'] },
      { name: 'Torso', aliases: ['torso', 'chest', 'body', 'trunk', 'abdomen', 'ribcage'] },
      { name: 'Upper limbs', aliases: ['arm', 'arms', 'foreleg', 'forelimb', 'wing', 'shoulder', 'tentacle'] },
      { name: 'Hands or paws', aliases: ['hand', 'hands', 'paw', 'claw', 'finger', 'gauntlet', 'talon'] },
      { name: 'Lower limbs', aliases: ['leg', 'legs', 'hindleg', 'hindlimb', 'thigh', 'shin', 'haunch'] },
      { name: 'Feet or hooves', aliases: ['foot', 'feet', 'hoof', 'boot', 'shoe', 'toe'] },
      { name: 'Hair, fur, or headwear', aliases: ['hair', 'fur', 'mane', 'helmet', 'hat', 'hood', 'crest', 'horn'] },
      { name: 'Clothing or surface covering', aliases: ['cloth', 'shirt', 'coat', 'armor', 'armour', 'scale', 'skin', 'hide', 'plate', 'garment', 'robe'] },
      { name: 'Articulation joints', aliases: ['joint', 'elbow', 'knee', 'hip', 'wrist', 'ankle', 'neck', 'pivot', 'socket'] },
    ],
    materialZones: ['skin or hide', 'hair or fur', 'eyes', 'clothing or armor', 'metal fittings'],
    reviewAxes: [
      'head-to-body proportion',
      'limb length and articulation direction',
      'facial landmark placement and spacing',
      'silhouette readability at a distance',
    ],
    orbitViews: ['front', 'three-quarter', 'strict profile', 'back'],
  },
  {
    id: 'vehicle',
    label: 'Vehicle',
    description: 'Cars, ships, aircraft, mechs, and anything else built to carry and move.',
    components: [
      { name: 'Chassis or hull', aliases: ['chassis', 'hull', 'frame', 'fuselage', 'body', 'monocoque'] },
      { name: 'Body panels', aliases: ['panel', 'fender', 'hood', 'bonnet', 'door', 'bumper', 'skirt', 'cowl'] },
      { name: 'Ground contact or propulsion', aliases: ['wheel', 'tire', 'tyre', 'track', 'thruster', 'engine', 'propeller', 'rotor', 'rudder', 'leg'] },
      { name: 'Cockpit or cabin', aliases: ['cockpit', 'cabin', 'seat', 'interior', 'dashboard', 'bridge'] },
      { name: 'Glazing', aliases: ['window', 'windshield', 'windscreen', 'canopy', 'glass', 'porthole', 'viewport'] },
      { name: 'Lights', aliases: ['light', 'headlamp', 'headlight', 'lamp', 'beacon', 'taillight'] },
      { name: 'Intakes or exhaust', aliases: ['intake', 'exhaust', 'vent', 'grille', 'grill', 'nozzle', 'muffler'] },
      { name: 'Protrusions and hardware', aliases: ['mirror', 'antenna', 'aerial', 'handle', 'rail', 'wing', 'spoiler', 'fin', 'mast'] },
      { name: 'Suspension or landing gear', aliases: ['suspension', 'axle', 'strut', 'landing gear', 'skid', 'shock', 'spring'] },
    ],
    materialZones: ['painted bodywork', 'glazing', 'tire rubber or tread', 'bare or chromed metal', 'emissive lamps'],
    reviewAxes: [
      'wheelbase and track proportion',
      'ground clearance and stance',
      'panel gap and seam continuity',
      'how deeply the glazing sits in its frame',
    ],
    orbitViews: ['front three-quarter', 'side profile', 'rear three-quarter', 'top-down'],
  },
  {
    id: 'weapon',
    label: 'Weapon / handheld tool',
    description: 'Blades, firearms, staves, and hand tools — anything gripped and wielded.',
    components: [
      { name: 'Grip or handle', aliases: ['grip', 'handle', 'haft', 'hilt', 'shaft', 'stock', 'wrap'] },
      { name: 'Working end', aliases: ['blade', 'edge', 'head', 'barrel', 'tip', 'point', 'bit', 'muzzle', 'prong'] },
      { name: 'Guard or bolster', aliases: ['guard', 'bolster', 'crossguard', 'quillon', 'ferrule', 'collar', 'hand guard'] },
      { name: 'Pommel or butt', aliases: ['pommel', 'butt', 'cap', 'counterweight', 'heel', 'end cap'] },
      { name: 'Fasteners', aliases: ['pin', 'rivet', 'screw', 'bolt', 'peg', 'binding', 'lashing'] },
      { name: 'Actuator or mechanism', aliases: ['trigger', 'lever', 'catch', 'latch', 'hammer', 'bolt', 'switch', 'release'] },
      { name: 'Sights or alignment features', aliases: ['sight', 'scope', 'notch', 'bead', 'rail', 'aperture'] },
      { name: 'Carry points', aliases: ['sling', 'lanyard', 'strap', 'loop', 'ring', 'swivel', 'sheath'] },
    ],
    materialZones: ['working metal', 'grip material', 'fittings and furniture', 'worn or polished edges'],
    reviewAxes: [
      'grip length against the working end',
      'edge or bore geometry',
      'implied balance point',
      'clearance for a real hand on the grip',
    ],
    orbitViews: ['broad profile', 'edge-on', 'three-quarter', 'close orbit on the grip'],
  },
  {
    id: 'architecture',
    label: 'Building / structure',
    description: 'Buildings, towers, bridges, and built environments.',
    components: [
      { name: 'Base or foundation', aliases: ['base', 'foundation', 'plinth', 'footing', 'podium', 'ground', 'slab'] },
      { name: 'Walls', aliases: ['wall', 'facade', 'façade', 'cladding', 'siding', 'masonry', 'panel'] },
      { name: 'Roof', aliases: ['roof', 'eave', 'gable', 'dome', 'parapet', 'shingle', 'ridge'] },
      { name: 'Doors', aliases: ['door', 'doorway', 'entrance', 'gate', 'portal', 'threshold'] },
      { name: 'Windows', aliases: ['window', 'glazing', 'pane', 'sill', 'shutter', 'mullion'] },
      { name: 'Vertical supports', aliases: ['column', 'pillar', 'post', 'pier', 'buttress', 'beam', 'truss'] },
      { name: 'Circulation', aliases: ['stair', 'step', 'ramp', 'ladder', 'balcony', 'walkway', 'porch'] },
      { name: 'Railings and trim', aliases: ['rail', 'railing', 'balustrade', 'cornice', 'molding', 'moulding', 'trim', 'fascia'] },
      { name: 'Roofline hardware', aliases: ['chimney', 'vent', 'duct', 'antenna', 'aerial', 'spire', 'gutter', 'downspout'] },
      { name: 'Signage or markings', aliases: ['sign', 'signage', 'lettering', 'plaque', 'banner', 'number', 'awning'] },
    ],
    materialZones: ['wall cladding', 'roofing', 'glazing', 'trim and joinery', 'ground or paving'],
    reviewAxes: [
      'floor-height against overall mass',
      'rhythm and alignment of openings',
      'roof pitch and overhang depth',
      'how deep the window and door reveals sit',
    ],
    orbitViews: ['front elevation', 'corner three-quarter', 'rear', 'top-down massing'],
  },
  {
    id: 'device',
    label: 'Device / machine',
    description: 'Electronics, appliances, instruments, and mechanisms with controls and an enclosure.',
    components: [
      { name: 'Enclosure', aliases: ['housing', 'enclosure', 'case', 'casing', 'shell', 'chassis', 'body', 'cabinet'] },
      { name: 'Seams and panel lines', aliases: ['seam', 'panel line', 'split line', 'joint', 'gap', 'parting', 'panel'] },
      { name: 'Display or indicator', aliases: ['display', 'screen', 'lcd', 'led', 'indicator', 'dial', 'gauge', 'readout', 'lamp'] },
      { name: 'Controls', aliases: ['button', 'knob', 'switch', 'dial', 'slider', 'lever', 'key', 'trigger', 'wheel'] },
      { name: 'Ports or connectors', aliases: ['port', 'connector', 'jack', 'socket', 'plug', 'terminal', 'receptacle'] },
      { name: 'Vents or cooling', aliases: ['vent', 'grille', 'grill', 'louver', 'fan', 'slot', 'mesh', 'heatsink'] },
      { name: 'Cabling', aliases: ['cable', 'cord', 'wire', 'hose', 'lead', 'harness', 'strain relief'] },
      { name: 'Fasteners', aliases: ['screw', 'bolt', 'rivet', 'clip', 'latch', 'fastener', 'hinge'] },
      { name: 'Feet or mounting', aliases: ['foot', 'feet', 'stand', 'bracket', 'mount', 'pad', 'base', 'handle'] },
      { name: 'Branding or labelling', aliases: ['label', 'badge', 'logo', 'plate', 'marking', 'lettering', 'decal', 'sticker'] },
    ],
    materialZones: ['housing shell', 'screen glass', 'control caps', 'metal trim', 'emissive indicators'],
    reviewAxes: [
      'control spacing and reachability',
      'seam continuity around the enclosure',
      'port alignment along its face',
      'bezel thickness around the display',
    ],
    orbitViews: ['front', 'three-quarter', 'rear where the ports live', 'underside'],
  },
];

/** Every family a record may store, `general` first. */
export const THREEJS_MODEL_FAMILIES = FAMILY_DEFINITIONS;

/**
 * Picker options, including `general`. The general entry carries no checklist —
 * it exists so "no narrowing" is an explicit, labelled choice rather than a
 * blank in the form.
 */
export const THREEJS_MODEL_FAMILY_OPTIONS = [
  {
    id: GENERAL_FAMILY_ID,
    label: 'General (no checklist)',
    description: 'One general-purpose prompt. The inventory is bounded only by what the model notices.',
  },
  ...FAMILY_DEFINITIONS.map(({ id, label, description }) => ({ id, label, description })),
];

export const THREEJS_MODEL_FAMILY_IDS = [
  GENERAL_FAMILY_ID,
  ...FAMILY_DEFINITIONS.map((family) => family.id),
];

/**
 * The family definition for an id, or `null` for `general`, an absent value, and
 * an id this install no longer ships. A record written by a newer peer or an
 * older taxonomy must degrade to "no checklist" rather than throwing — the
 * stored spec is still perfectly renderable without one.
 */
export function getThreejsModelFamily(familyId) {
  if (!familyId || familyId === GENERAL_FAMILY_ID) return null;
  return FAMILY_DEFINITIONS.find((family) => family.id === familyId) || null;
}

/**
 * The prompt block spliced into generation when a family is chosen. Returns ''
 * for `general` so the caller emits nothing at all.
 */
export function buildThreejsFamilyChecklist(familyId) {
  const family = getThreejsModelFamily(familyId);
  if (!family) return '';
  const components = family.components.map((component) => `- ${component.name}`).join('\n');
  return `SUBJECT FAMILY — ${family.label}:
The user classified this subject as a ${family.label.toLowerCase()}. The list below is a FLOOR, not a
ceiling. It is the set of components a reconstruction of this family is usually judged on, so each one
must be resolved before you finish — but it is not the inventory. Everything else visible in the
reference still belongs in detailInventory exactly as it would without this list, and a subject with
components this list does not name is the normal case, not an exception.

Required components — for each, either build it as real geometry and name it in detailInventory, or
state in "limitations" that the reference does not show it and why (occluded, cropped, genuinely absent):
${components}

Separate materials for these zones where the reference distinguishes them: ${family.materialZones.join(', ')}.
Judge your own result on: ${family.reviewAxes.join('; ')}.
Choose a camera that holds up when the model is orbited to: ${family.orbitViews.join(', ')}.
`;
}

const normalize = (value) => String(value || '').toLowerCase();

/**
 * Which of a family's required components the spec never accounts for.
 *
 * Evidence is textual and deliberately generous: a component counts as accounted
 * for when any alias appears in a detailInventory feature/evidence string, in a
 * part name, or in the spec's own summary/limitations prose. A component the
 * model consciously ruled out ("no visible antenna") is therefore NOT reported —
 * the gate is looking for silence, not for a negative answer.
 *
 * @returns {{family: ThreejsModelFamily, missing: string[]}|null} null when no
 *   family applies, so callers can skip the whole check.
 */
export function findMissingFamilyComponents(spec, familyId) {
  const family = getThreejsModelFamily(familyId);
  if (!family) return null;
  const haystack = [
    ...(Array.isArray(spec?.detailInventory) ? spec.detailInventory : [])
      .flatMap((detail) => [detail?.feature, detail?.evidence]),
    ...collectPartNames(spec?.parts),
    spec?.summary,
    ...(Array.isArray(spec?.limitations) ? spec.limitations : []),
  ].map(normalize).filter(Boolean).join(' | ');
  const missing = family.components
    .filter((component) => !component.aliases.some((alias) => haystack.includes(alias)))
    .map((component) => component.name);
  return { family, missing };
}

function collectPartNames(parts, names = []) {
  for (const part of Array.isArray(parts) ? parts : []) {
    names.push(part?.name, part?.id);
    collectPartNames(part?.children, names);
  }
  return names;
}
