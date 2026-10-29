// A person's height as a scale cue for image models. A full-height character
// sheet composited onto an empty set plate carries no size of its own, so a
// child rendered from it comes out adult-sized beside a car or a door.

// Median standing height (cm) by whole year of age, boys and girls averaged
// (CDC growth charts, 50th percentile). Adults vary too widely for a default.
const TYPICAL_CM = [null, 76, 87, 95, 102, 109, 115, 122, 128, 133, 138, 144, 150, 157, 162, 166, 168, 169];

const MIN_CM = 40;
const MAX_CM = 260;

/** The median height in cm for a child's age (a number or text such as "7" / "age 7"), else null. */
export function typicalHeightCm(age) {
  const match = String(age ?? '').match(/\d{1,3}/);
  const years = match ? Number(match[0]) : NaN;
  return Number.isInteger(years) && years >= 1 && years < TYPICAL_CM.length ? TYPICAL_CM[years] : null;
}

/**
 * Centimeters stated in free height text: "122 cm", "1.22 m", "4 ft 2 in",
 * `4'2"`, "50 in". Null when no plausible human height is stated.
 */
function parseHeightCm(text) {
  const s = String(text ?? '').toLowerCase();
  const plausible = (cm) => (cm >= MIN_CM && cm <= MAX_CM ? Math.round(cm) : null);
  const cm = s.match(/(\d{2,3}(?:\.\d+)?)\s*cm\b/);
  if (cm) return plausible(Number(cm[1]));
  const ft = s.match(/(\d)(?:\.\d+)?\s*(?:ft|feet|foot|'|’)\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:in\b|inches|inch|"|”|″)?)?/);
  if (ft) return plausible(Number(ft[1]) * 30.48 + Number(ft[2] || 0) * 2.54);
  const m = s.match(/(\d(?:\.\d+)?)\s*m\b/);
  if (m) return plausible(Number(m[1]) * 100);
  const inches = s.match(/(\d{2}(?:\.\d+)?)\s*(?:in\b|inches|")/);
  return inches ? plausible(Number(inches[1]) * 2.54) : null;
}

/** `4 ft (122 cm)` / `5 ft 7 in (170 cm)`. */
export function formatHeight(cm) {
  const inches = Math.round(cm / 2.54);
  const rest = inches % 12;
  return `${Math.floor(inches / 12)} ft${rest ? ` ${rest} in` : ''} (${Math.round(cm)} cm)`;
}

/**
 * The height to state for a person: their own text when given (with its cm
 * when parseable), else the median for a child's age. `{ text, cm }` or null.
 */
export function resolveHeight(height, age) {
  const given = String(height ?? '').trim();
  if (given) return { text: given, cm: parseHeightCm(given) };
  const cm = typicalHeightCm(age);
  return cm ? { text: `about ${formatHeight(cm)}`, cm } : null;
}

// Everyday things in nearly every set, sized against the person.
function sizeCues(cm) {
  const cues = [];
  if (cm < 135) cues.push('shorter than the roof of a parked car (about 4 ft 9 in / 145 cm)');
  else if (cm <= 155) cues.push('about as tall as the roof of a parked car');
  else cues.push('a parked car\'s roof reaches about their chest');
  if (cm < 100) cues.push('their head below an adult\'s waist');
  else if (cm < 118) cues.push('their head at about an adult\'s waist');
  else if (cm < 140) cues.push('their head at about an adult\'s chest');
  else if (cm < 158) cues.push('their head at about an adult\'s shoulder');
  if (cm < 160) cues.push('a doorway (6 ft 8 in / 203 cm) towers over them');
  return cues;
}

/**
 * One prompt line placing a person at their true size in a set, e.g.
 * "Scale: Nora at age 7 is about 4 ft (122 cm) tall: shorter than …". Empty
 * without a height.
 */
export function heightScaleLine(who, height) {
  if (!height?.text) return '';
  const cues = height.cm ? sizeCues(height.cm) : [];
  return `Scale: ${who} is ${height.text} tall${cues.length ? `: ${cues.join(', ')}` : ''}. Keep that true size against the cars, doors, furniture and any people in the frame`;
}
