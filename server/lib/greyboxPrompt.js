/**
 * What a provider is told when it creates or edits a Place's greybox, and the
 * parser for its answer.
 *
 * The user's instruction is sent as written. The contract below is one visible
 * block the UI lists beside it, and the place's own description and (for an
 * edit) the current scene are two more, so "Show full prompt" names every word
 * the model read (#11317). The answer is a preview: nothing is stored until the
 * user applies it.
 *
 * Dependency-light: zod via greyboxScene.js only.
 */

import { GREYBOX_LIMITS, GREYBOX_SCHEMA_VERSION, greyboxSceneSchema } from './greyboxScene.js';
import { GREYBOX_ASPECTS } from './greyboxVocabulary.js';
import { extractJson } from './jsonExtract.js';

export { GREYBOX_INSTRUCTION_MAX } from './greyboxVocabulary.js';

/** The scene contract and authoring rules, sent ahead of the user's words. */
export function greyboxContractInstructions() {
  return [
    'You build a GREYBOX: a coarse, untextured 3D layout of one location, used to keep the placement of objects and people consistent across the shots of a film. It is a layout aid, not a finished model: prefer a few large, correctly placed primitives over fine detail.',
    'Units are meters, Y up, the floor at y=0. X is right, Z is toward the default viewer. Keep the whole place within about 200 m of the origin and give things real-world sizes (a door is ~2.1 m tall, a person ~1.7 m).',
    'Answer with ONE raw JSON object and nothing else, in exactly this shape:',
    `{"version":${GREYBOX_SCHEMA_VERSION},"source":"spec","parts":[...],"zones":[...],"landmarks":[...],"anchors":[...],"shots":[...]}`,
    '- parts: {"id","label"?,"zone"?,"position":[x,y,z],"rotationDegrees":[x,y,z]} plus ONE of:',
    '  {"type":"box","size":[width,height,depth]} (centered on position)',
    '  {"type":"cylinder","radius":n,"height":n} (centered on position)',
    '  {"type":"plane","size":[width,depth]} (flat, at position)',
    `  {"type":"extrude","outline":[[x,z],...],"height":n} (a closed floor outline of 3..${GREYBOX_LIMITS.OUTLINE_POINTS} points swept up from position.y; use it for floors, ovals and irregular footprints)`,
    '- zones: {"id","label","color":"#RRGGBB"}: named tints for areas (skate floor, seating, stage). A part joins a zone by naming its id.',
    '- landmarks: {"id","label","position":[x,y,z],"note"?}: named things worth pointing at in a shot description (DJ booth, north rail, exit door).',
    '- anchors: {"id","label","kind":"figure"|"prop","position":[x,y,z],"facingDegrees":n,"heightMeters":n}: floor marks for people and props, so each stays in the same spot from shot to shot. position.y is 0 for a figure on the floor.',
    `- shots: {"id","label","position":[x,y,z],"target":[x,y,z],"focalLengthMm":n,"aspect":${GREYBOX_ASPECTS.map((a) => `"${a}"`).join('|')},"figures":[{"anchorId","pose"?}],"note"?}: saved cameras. The camera looks from position at target. Include a wide establishing shot and a few angles that show the landmarks. A shot may only name anchors you defined.`,
    'Every id is unique within its list, starts with a letter, and uses only letters, digits, "_" and "-" (shot ids at most 51 characters). Every zone a part names and every anchor a shot names must exist.',
    `Limits: at most ${GREYBOX_LIMITS.PARTS} parts, ${GREYBOX_LIMITS.ZONES} zones, ${GREYBOX_LIMITS.LANDMARKS} landmarks, ${GREYBOX_LIMITS.ANCHORS} anchors, ${GREYBOX_LIMITS.SHOTS} shots.`,
    'When the place has a street (a road, neighborhood, town or roadside), model its infrastructure as it really works, because image models copy what the greybox shows:',
    '- Pole line: wooden utility poles (cylinders ~0.15 m radius, 10-12 m tall) in ONE line along one side of the street, 35-45 m apart, each with a crossarm (~2.4 m box) at the top, across the road direction. The line changes sides only at a corner, with one crossing span. Zone "pole".',
    '- Wires: 2-3 primary wires strung pole to pole along that line, from crossarm to crossarm (thin boxes ~0.04 m square, rotated to span exactly between their two ends). They follow the street and never zig-zag across it. Zone "wire".',
    '- Service drops: every house gets ONE thin wire from the top or crossarm of its nearest pole down to a short mast or bracket on its roof edge (never to the middle of a pole); houses across the street get drops that cross the road. Model the mast as a small cylinder on the roof. Zone "drop" for drops and masts.',
    '- Streetlights: cobra-head lamps mounted on the utility poles about 8 m up, on an arm reaching out over the road, the head over the road and never facing the houses. No separate lamp posts on a street that has a pole line. Zone "lamp" for arms and heads.',
    '- Back-lot utilities: only when the description says utilities run along rear lot lines (or are buried) do the poles go behind the houses (or disappear); the street then has lamp posts only, each head reaching over the road, and drops come from the back.',
    '- Nothing floats: every wire ends at a pole or a building, and every lamp is attached to a pole or post.',
    '- Road and sidewalks: put the road surface in zone "road". Decide sidewalks on purpose from the era, region and description: either sidewalks (~1.2-1.5 m wide with a curb, and a ~1-2 m grass strip between curb and walk, zone "sidewalk") or none at all (many 1950s-80s suburban, rural and edge-of-town streets had none: lawns or gravel shoulders run to the road edge), and add a landmark that says which, e.g. "No sidewalks" or "Sidewalks both sides".',
    '- Houses and driveways: houses face the street across a front yard (~6-10 m setback) with a defined front: a front door (a dark box ~1 m wide, 2.1 m tall, zone "door") on the street side, a porch or stoop, and a front walk to the sidewalk or driveway. Keep every walk, porch and doorway clear: bushes, trees and other landscaping sit beside them, never on a walk or in front of a door. Every house also gets a driveway (~3-4 m wide, zone "driveway") from its garage or carport to the road, with a curb cut where there is a curb, so the street reads as a front street, not an alley.',
    '- Derelict houses: when the description calls for abandoned or run-down houses, mark each one by putting all of its parts in zone "derelict" with the same label (e.g. "Derelict house 4"). Keep them rare, about one house in eight at most unless the description asks for more, so neglect reads as occasional, not everywhere. Every other house is lived-in.',
    'Stay faithful to the place description and the user\'s request. Do not invent features they contradict. When editing, return the COMPLETE updated scene (not a patch), keeping the ids of everything you did not change.',
  ].join('\n');
}

/** The one text the model reads: contract, place, current scene (if any), request. */
export function greyboxPrompt({ instructions, placeBlock, currentBlock, request }) {
  return [
    instructions,
    '---',
    placeBlock,
    ...(currentBlock ? ['---', currentBlock] : []),
    '---',
    `${currentBlock ? 'Requested change' : 'Request'}:\n${request}`,
  ].join('\n\n');
}

/** The place's own words, as the model sees them. */
export function greyboxPlaceBlock({ name, description }) {
  return `Place: ${name}\nDescription: ${description || '(none given)'}`;
}

/** The scene being edited, compact JSON so a long one still fits the context. */
export function greyboxCurrentBlock(scene) {
  return scene ? `Current greybox (JSON):\n${JSON.stringify(scene)}` : '';
}

/**
 * The provider's text answer as a validated scene (`extractJson` tolerates a
 * code fence, surrounding prose and echoed schema examples); throws an Error whose message names the first problem so
 * the caller can show it and the user can retry or pick another model.
 */
export function parseGreyboxAnswer(text) {
  const { value } = extractJson(typeof text === 'string' ? text : '', {
    // Skip an echoed schema example: the answer is the object carrying scene lists.
    shapePredicate: (v) => v && typeof v === 'object' && !Array.isArray(v) && ('parts' in v || 'shots' in v),
  });
  if (!value) throw new Error('The model did not return a JSON scene.');
  const parsed = greyboxSceneSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The scene was invalid at ${issue.path.join('.') || 'the top level'}: ${issue.message}.`);
  }
  return parsed.data;
}
