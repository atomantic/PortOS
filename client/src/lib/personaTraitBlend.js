/**
 * Persona trait-blending (Digital Twin M34 P7).
 *
 * A persona is a named context (Professional, Casual, Family…). Beyond its
 * free-text `instructions`, a persona may carry structured `traitAdjustments`
 * that modulate the *base* twin's quantitative profile for that context —
 * relative nudges to the communication profile (formality / verbosity) plus
 * absolute overrides (emoji usage, tone) and directional Big-Five leans.
 *
 * This module blends those adjustments against the base twin's `traits` and
 * renders a "Communication Calibration" directive that prepends to the persona
 * preamble (see `digital-twin-context.js`), so the embodied twin shifts voice
 * per context without forking the underlying identity documents.
 *
 * Pure ESM, no Node-only deps — mirrored byte-for-byte to
 * `client/src/lib/personaTraitBlend.js` so the Personas UI can preview the same
 * directional wording. The server copy is authoritative; the matching server
 * test file (`personaTraitBlend.test.js`) is the contract.
 */

// communicationProfile.formality / .verbosity live on a 1..10 scale; a persona
// nudges them with a relative integer delta in this range.
export const COMM_DELTA_MIN = -9;
export const COMM_DELTA_MAX = 9;

// Big-Five (OCEAN) base traits live on a 0..1 scale; a persona leans them with
// a relative delta in this range.
export const BIG_FIVE_DELTA_MIN = -1;
export const BIG_FIVE_DELTA_MAX = 1;

// Emoji-usage vocabulary, shared by the base twin's communication profile, a
// persona's trait-adjustment override (server Zod), and the Personas UI
// dropdown. Living in this byte-parity-guarded mirror means the parity test
// catches any client↔server drift in the enum.
export const EMOJI_USAGE_VALUES = ['never', 'rare', 'occasional', 'frequent'];

export const BIG_FIVE_LEAN = {
  O: { more: 'more open and curious', less: 'more conventional and focused' },
  C: { more: 'more conscientious and organized', less: 'more relaxed and spontaneous' },
  E: { more: 'more outgoing and expressive', less: 'more reserved and measured' },
  A: { more: 'warmer and more accommodating', less: 'more direct and challenging' },
  N: { more: 'more emotionally expressive', less: 'more even-keeled and calm' }
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Bin a delta's magnitude into slightly / notably / much against the [notably,
// much] thresholds for its scale. One ladder, two scales (1..10 comm deltas use
// [3, 5]; 0..1 Big-Five deltas use [0.2, 0.4]).
function magnitudeAdverb(delta, notably, much) {
  const mag = Math.abs(delta);
  if (mag >= much) return 'much';
  if (mag >= notably) return 'notably';
  return 'slightly';
}

// Bare adverb for a 1..10-scale delta — used where the paired verb already
// encodes direction (e.g. "more concise").
const commAdverb = (delta) => magnitudeAdverb(delta, 3, 5);

// Adverb for a 0..1-scale Big-Five delta.
const bigFiveMagnitude = (delta) => magnitudeAdverb(delta, 0.2, 0.4);

// Signed wording for a fixed-quality 1..10 trait (e.g. formality): the quality
// word stays put and direction is "more"/"less" of it — "much more formal".
function commMagnitude(delta) {
  return `${commAdverb(delta)} ${delta > 0 ? 'more' : 'less'}`;
}

// Verbosity flips its quality word with sign — negative = more concise,
// positive = more elaborate — so it always reads "{adverb} more {quality}".
function verbosityPhrase(delta) {
  return `${commAdverb(delta)} more ${delta > 0 ? 'elaborate' : 'concise'}`;
}

/**
 * Does this persona carry any structured trait adjustment worth rendering?
 * Empty objects / all-absent fields count as "none".
 */
export function hasTraitAdjustments(adjustments) {
  if (!adjustments || typeof adjustments !== 'object') return false;
  const { formality, verbosity, emojiUsage, tone, bigFive } = adjustments;
  if (typeof formality === 'number' && formality !== 0) return true;
  if (typeof verbosity === 'number' && verbosity !== 0) return true;
  if (typeof emojiUsage === 'string' && emojiUsage) return true;
  if (typeof tone === 'string' && tone.trim()) return true;
  if (bigFive && typeof bigFive === 'object') {
    return Object.keys(BIG_FIVE_LEAN).some(k => typeof bigFive[k] === 'number' && bigFive[k] !== 0);
  }
  return false;
}

/**
 * Blend a persona's adjustments against the base communication profile,
 * returning the effective values plus the base for "X → Y" rendering. Missing
 * base values surface as `null` so callers can render a directional-only line.
 */
export function blendCommunicationProfile(baseProfile, adjustments) {
  const base = baseProfile && typeof baseProfile === 'object' ? baseProfile : {};
  const adj = adjustments && typeof adjustments === 'object' ? adjustments : {};

  const blendScale = (baseVal, delta) => {
    const hasBase = typeof baseVal === 'number';
    const hasDelta = typeof delta === 'number' && delta !== 0;
    if (!hasDelta) return { base: hasBase ? baseVal : null, effective: hasBase ? baseVal : null, delta: 0 };
    return {
      base: hasBase ? baseVal : null,
      effective: hasBase ? clamp(baseVal + delta, 1, 10) : null,
      delta
    };
  };

  return {
    formality: blendScale(base.formality, adj.formality),
    verbosity: blendScale(base.verbosity, adj.verbosity),
    emojiUsage: typeof adj.emojiUsage === 'string' && adj.emojiUsage
      ? { base: base.emojiUsage ?? null, effective: adj.emojiUsage }
      : null,
    tone: typeof adj.tone === 'string' && adj.tone.trim()
      ? { base: base.preferredTone ?? null, effective: adj.tone.trim() }
      : null
  };
}

/**
 * Human-readable, base-agnostic descriptions of each adjustment — used by the
 * Personas UI preview where the base profile isn't loaded. One short phrase per
 * active adjustment; empty array when there's nothing to say.
 */
export function describeTraitAdjustments(adjustments) {
  if (!hasTraitAdjustments(adjustments)) return [];
  const adj = adjustments;
  const lines = [];

  if (typeof adj.formality === 'number' && adj.formality !== 0) {
    lines.push(`${commMagnitude(adj.formality)} formal`);
  }
  if (typeof adj.verbosity === 'number' && adj.verbosity !== 0) {
    lines.push(verbosityPhrase(adj.verbosity));
  }
  if (typeof adj.emojiUsage === 'string' && adj.emojiUsage) {
    lines.push(`emoji usage: ${adj.emojiUsage}`);
  }
  if (typeof adj.tone === 'string' && adj.tone.trim()) {
    lines.push(`tone: ${adj.tone.trim()}`);
  }
  if (adj.bigFive && typeof adj.bigFive === 'object') {
    for (const k of Object.keys(BIG_FIVE_LEAN)) {
      const d = adj.bigFive[k];
      if (typeof d === 'number' && d !== 0) {
        const lean = d > 0 ? BIG_FIVE_LEAN[k].more : BIG_FIVE_LEAN[k].less;
        lines.push(`${bigFiveMagnitude(d)} ${lean}`);
      }
    }
  }
  return lines;
}

/**
 * Render the "Communication Calibration" directive block that prepends to a
 * persona's preamble. Blends `adjustments` against the base twin's `traits`
 * (communicationProfile + bigFive). Returns '' when the persona has no
 * adjustments so the preamble stays unchanged for instructions-only personas.
 */
export function renderTraitBlendDirective(baseTraits, adjustments, personaName = '') {
  if (!hasTraitAdjustments(adjustments)) return '';

  const traits = baseTraits && typeof baseTraits === 'object' ? baseTraits : {};
  const blended = blendCommunicationProfile(traits.communicationProfile, adjustments);
  const lines = [];

  // `phrase(delta)` returns the full directional description for this scale's
  // delta (e.g. "notably more formal" / "much more concise").
  const renderScale = (label, slot, phrase) => {
    if (!slot || slot.delta === 0) return;
    const text = phrase(slot.delta);
    if (slot.base !== null && slot.effective !== null) {
      lines.push(`- ${label}: ${slot.base} → ${slot.effective} (${text})`);
    } else {
      // No baseline recorded — render the directional intent relative to default.
      lines.push(`- ${label}: ${text} than your natural default`);
    }
  };

  renderScale('Formality', blended.formality, (d) => `${commMagnitude(d)} formal`);
  renderScale('Verbosity', blended.verbosity, verbosityPhrase);

  if (blended.emojiUsage) {
    const from = blended.emojiUsage.base ? ` (baseline ${blended.emojiUsage.base})` : '';
    lines.push(`- Emoji usage: ${blended.emojiUsage.effective}${from}`);
  }
  if (blended.tone) {
    const from = blended.tone.base ? ` (baseline ${blended.tone.base})` : '';
    lines.push(`- Tone: ${blended.tone.effective}${from}`);
  }

  // Big-Five leans, rendered as directional personality nudges.
  const adjBigFive = adjustments.bigFive && typeof adjustments.bigFive === 'object' ? adjustments.bigFive : {};
  const baseBigFive = traits.bigFive && typeof traits.bigFive === 'object' ? traits.bigFive : {};
  const leanLines = [];
  for (const k of Object.keys(BIG_FIVE_LEAN)) {
    const d = adjBigFive[k];
    if (typeof d !== 'number' || d === 0) continue;
    const lean = d > 0 ? BIG_FIVE_LEAN[k].more : BIG_FIVE_LEAN[k].less;
    const baseVal = typeof baseBigFive[k] === 'number' ? baseBigFive[k] : null;
    if (baseVal !== null) {
      const eff = clamp(baseVal + d, 0, 1);
      leanLines.push(`${bigFiveMagnitude(d)} ${lean} (${baseVal.toFixed(2)} → ${eff.toFixed(2)})`);
    } else {
      leanLines.push(`${bigFiveMagnitude(d)} ${lean}`);
    }
  }
  if (leanLines.length > 0) {
    lines.push(`- Personality lean: ${leanLines.join('; ')}`);
  }

  if (lines.length === 0) return '';

  const heading = personaName
    ? `## Communication Calibration (${personaName} context)`
    : '## Communication Calibration';

  return [
    heading,
    'Modulate your baseline communication for this context:',
    ...lines,
    'Where a baseline value is unknown, apply the directional adjustment relative to your natural default.'
  ].join('\n');
}
