/**
 * Lighting rules for people in Music Video images. A person lit cleaner or
 * brighter than the place around them reads as pasted in, and an amateur
 * snapshot or home-video look is allowed, even expected, to light people badly.
 */
const AMATEUR_LOOK = /\b(snapshots?|home[- ]?video|home movies?|camcorders?|vhs(?:-c)?|super[- ]?8|found[- ]footage|polaroids?|instamatic|disposable cameras?|point[- ]and[- ]shoot|amateur|pop-?up flash)\b/i;

export const SCENE_LIGHT_ON_PEOPLE = 'People are lit only by the light already in the place, with the same exposure, color cast, grain and softness as their surroundings; never studio-lit, rim-lit or brighter and cleaner than the room';
export const AMATEUR_SNAPSHOT_LIGHT = 'Authentic amateur snapshot lighting: people are lit only by the scene\'s own light or the camera\'s flash, often underexposed, unevenly lit or half in shadow, never studio-lit, rim-lit or brighter and cleaner than their surroundings';

export const isAmateurLook = (...texts) => texts.some((text) => AMATEUR_LOOK.test(String(text || '')));

/** The lighting line for a frame with people: '' unless the look is amateur, unless `always`. */
export function peopleLightLine(lookTexts, { always = false } = {}) {
  if (isAmateurLook(...lookTexts)) return AMATEUR_SNAPSHOT_LIGHT;
  return always ? SCENE_LIGHT_ON_PEOPLE : '';
}
