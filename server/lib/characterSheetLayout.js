/**
 * Shared panel wording and ruler scale for the face, headless-front and back photographic sheets.
 *
 * The comparison sheet (two people, services/catalog/catalogComparisonSheet.js)
 * and the single-character standard sheet (services/universeCharacterSheet.js)
 * draw the same three panels per person: one large face, a headless FRONT and a
 * BACK, measured by a ruler beside the standing figures. Keeping the panel text
 * and the ruler arithmetic in one place keeps a person's half of a comparison
 * sheet and their own standard sheet drawn to one standard.
 */

export const FACE_PORTRAIT_FRAMING = 'showing the whole head with a little space above the hair, the chin, the full neck and the collar, relaxed natural expression, looking at the camera';
export const HEADLESS_FRONT_VIEW = 'FRONT, a full-body standing view from the front with the head absent, the figure ending cleanly at the neck inside the collar like a headless display mannequin, with no face and no hair';
export const BACK_VIEW = 'BACK, a full-body standing view from behind, including the back of the head and hair';

const IMPERIAL_HEIGHT = /\d\s*(?:ft|feet|foot|'|’)|\d\s*(?:in|inch|inches)\b/i;
const feetAndInches = (inches) => `${Math.floor(inches / 12)} ft${inches % 12 ? ` ${inches % 12} in` : ''}`;
const intervals = (value) => String(Math.round(value * 10) / 10);

/**
 * The ruler's range and marks, worked out in code: an image model asked for
 * "evenly spaced ticks reaching a little above" draws uneven marks that end
 * level with the taller head, then stretches the figures past them. A ruler
 * that runs well past the tallest person, cut into whole equal intervals, plus
 * where each head falls on it, gives the figures a fixed scale to be drawn to.
 * Units follow the height captions: feet when any height is stated in feet or
 * inches, else centimetres. `people` are `{ name, height }` with `height` from
 * resolveHeight (`{ cm, text }`) or null; one person reads as a single ruler.
 */
export function rulerScaleLine(people) {
  const single = people.length === 1;
  const ruler = single ? 'The ruler' : 'Each ruler';
  const above = single ? 'well above the head' : "well above the taller person's head";
  const measured = people.filter((person) => Number.isFinite(person.height?.cm));
  if (!measured.length) {
    return single
      ? 'Every ruler interval is the same length and numbered, and the ruler runs well above the head. Draw both standing figures against this ruler.'
      : 'Every ruler interval is the same length, numbered in the units of the height captions, and the ruler runs well above the taller person. Draw every standing figure against these rulers.';
  }
  const tallest = Math.max(...measured.map((person) => person.height.cm));
  if (people.some((person) => IMPERIAL_HEIGHT.test(person.height?.text || ''))) {
    const top = Math.ceil((tallest / 2.54 + 6) / 12);
    const marks = Array.from({ length: top + 1 }, (_, foot) => (foot ? `${foot} ft` : '0')).join(', ');
    const heads = measured.map((person) => {
      const inches = Math.round(person.height.cm / 2.54);
      return `${person.name}'s head top sits at ${feetAndInches(inches)}, ${intervals(inches / 12)} of the ${top} intervals up from the floor`;
    });
    return `${ruler} runs from 0 at the floor line to ${top} ft, ${above}, and is divided into ${top} one-foot intervals of exactly equal length, the first (0 to 1 ft) the same as every other. A long tick and a small number mark every foot (${marks}), and one shorter tick marks each half foot exactly midway between them; no other ticks. The figures are drawn to this scale: ${heads.join('; ')}.`;
  }
  const top = Math.ceil((tallest + 15) / 50) * 50;
  const heads = measured.map((person) => `${person.name}'s head top sits at ${Math.round(person.height.cm)} cm, ${intervals(person.height.cm / 50)} of the ${top / 50} intervals up from the floor`);
  return `${ruler} runs from 0 at the floor line to ${top} cm, ${above}, and is divided into ${top / 50} intervals of 50 cm, all exactly equal in length, the first (0 to 50 cm) the same as every other. A long tick and a small number mark every 50 cm (${Array.from({ length: top / 50 + 1 }, (_, i) => (i ? `${i * 50} cm` : '0')).join(', ')}), and a shorter tick marks every 10 cm between them; no other ticks. The figures are drawn to this scale: ${heads.join('; ')}.`;
}

/**
 * One person's description block. `heading` opens it ("LEFT HALF: Ana." on a
 * comparison sheet); `common` is extractCharacterPromptCommon's field bag and
 * `height` resolveHeight's result or null.
 */
export function sheetPersonBlock(heading, { common, height }) {
  const { age, physical, visualIdentity, special, wardrobeLine, propsLine } = common;
  return [
    heading,
    age ? `Age: ${age}, and they look exactly that age.` : '',
    height ? `Height: ${height.text}.` : '',
    physical ? `Physical description: ${physical}` : '',
    visualIdentity ? `Facial identity: ${visualIdentity}` : '',
    special ? `Distinctive traits: ${special}` : '',
    wardrobeLine ? `Wardrobe, identical in every view: ${wardrobeLine}.` : '',
    propsLine ? `Carried or worn where natural: ${propsLine}.` : '',
  ].filter(Boolean).join(' ');
}
