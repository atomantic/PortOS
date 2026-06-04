// Pure, deterministic helpers for CyberCity's chronotype energy overlay (roadmap 3.1):
// the city brightens and quickens during the user's peak focus hours and dims/slows
// during wind-down and sleep. Energy is derived from the digital-twin chronotype
// profile's recommended daily schedule (wake / peak focus / wind-down / sleep). No
// three.js / React imports so the topology is unit-testable (mirrors cityBackupVault.js).
//
// The hour-of-day is ALWAYS injected as a parameter — no `new Date()` here — so the
// energy curve is deterministic in tests. The component computes the live hour and
// passes it in.

// Sentinel energy for "no usable profile" — distinct from any real curve value so a
// missing profile is recognizable. It maps to NEUTRAL_MODIFIERS (no visible change),
// NOT to peak brightness, so an unconfigured city looks untouched rather than washed out.
export const NEUTRAL_ENERGY = 1.0;

// Tasteful clamp ranges so the overlay stays atmospheric, never washing out or
// blacking out the existing scene. Brightness rides slightly above/below 1; tempo
// (animation-speed multiplier) is gentler still.
export const ENERGY_RANGE = {
  brightnessMin: 0.7,
  brightnessMax: 1.15,
  tempoMin: 0.8,
  tempoMax: 1.15,
};

// What the overlay applies when there's no usable chronotype profile: a true no-op —
// brightness and tempo at 1.0 so the scene renders exactly as it would without the
// overlay. Keeps "unconfigured / failed to fetch" visually distinct from "low energy."
export const NEUTRAL_MODIFIERS = { energy: NEUTRAL_ENERGY, brightness: 1.0, tempo: 1.0 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Parse "HH:MM" → fractional hours in [0,24). Returns NaN for unparseable input.
// Hours past midnight that belong to "today's" late night (e.g. a 00:30 sleep time)
// are returned as-is (0.5); callers that need a continuous timeline normalize.
export function parseHour(str) {
  if (typeof str !== 'string') return NaN;
  const [h, m] = str.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  const val = h + m / 60;
  return val >= 0 && val < 24 ? val : NaN;
}

// Circular distance between two hours on a 24h clock (shortest arc), in [0,12].
function hourDistance(a, b) {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

// Build the set of energy anchor points from the chronotype recommendations.
// Each anchor is { hour, energy } where energy ∈ [0,1]: 1 at the center of peak
// focus, low through wind-down and sleep, mid on waking. Returns null when the
// profile lacks the timing fields we need (caller falls back to neutral).
function buildAnchors(profile) {
  const rec = profile?.recommendations;
  if (!rec) return null;

  const wake = parseHour(rec.wakeTime);
  const peakStart = parseHour(rec.peakFocusStart);
  const peakEnd = parseHour(rec.peakFocusEnd);
  const windDown = parseHour(rec.windDownStart);
  const sleep = parseHour(rec.sleepTime);

  const anchors = [];

  // Peak focus center → maximum energy. This is the anchor the overlay is built
  // around, so we require at least the peak window to be present.
  if (Number.isFinite(peakStart) && Number.isFinite(peakEnd)) {
    const center = peakStart + ((peakEnd - peakStart + 24) % 24) / 2;
    anchors.push({ hour: center % 24, energy: 1.0 });
  } else {
    return null;
  }

  // Waking → ramping up (mid energy).
  if (Number.isFinite(wake)) anchors.push({ hour: wake, energy: 0.55 });

  // Wind-down → low energy.
  if (Number.isFinite(windDown)) anchors.push({ hour: windDown, energy: 0.3 });

  // Sleep → lowest energy (recovery / dim city).
  if (Number.isFinite(sleep)) anchors.push({ hour: sleep, energy: 0.12 });

  return anchors;
}

// Given the chronotype profile and the current hour (0..23, fractional ok), compute
// an energy level in [0,1]. Energy is the inverse-distance-weighted blend of the
// nearest anchors on the 24h clock — smooth, wrap-around-aware, no hard edges.
// Returns `null` (sentinel) when there's no usable profile or the hour is non-finite,
// so callers can distinguish "no profile" from a real curve value that happens to be
// 1.0 (peak focus center). Callers map null → neutral (no visible change).
export function computeEnergy(profile, hour) {
  const anchors = buildAnchors(profile);
  if (!anchors || !Number.isFinite(hour)) return null;

  let weightSum = 0;
  let energySum = 0;
  for (const a of anchors) {
    const dist = hourDistance(hour, a.hour);
    // Exact hit on an anchor returns it directly (avoids divide-by-zero).
    if (dist < 1e-6) return clamp(a.energy, 0, 1);
    const weight = 1 / (dist * dist);
    weightSum += weight;
    energySum += weight * a.energy;
  }
  return clamp(energySum / weightSum, 0, 1);
}

// Map an energy level 0..1 → the tasteful, clamped display modifiers the overlay
// applies: a brightness multiplier and a tempo (animation-speed) multiplier. Energy
// 1 → top of each range, energy 0 → bottom; linear in between. A null/non-finite
// energy (no usable profile) returns NEUTRAL_MODIFIERS — a true no-op.
export function energyModifiers(energy) {
  if (!Number.isFinite(energy)) return { ...NEUTRAL_MODIFIERS };
  const e = clamp(energy, 0, 1);
  const { brightnessMin, brightnessMax, tempoMin, tempoMax } = ENERGY_RANGE;
  return {
    energy: e,
    brightness: clamp(brightnessMin + e * (brightnessMax - brightnessMin), brightnessMin, brightnessMax),
    tempo: clamp(tempoMin + e * (tempoMax - tempoMin), tempoMin, tempoMax),
  };
}

// Full derived view-model for the component: energy + brightness + tempo. `hour` is
// injected so the whole view-model is deterministic under test. A missing/partial
// profile (or non-finite hour) yields NEUTRAL_MODIFIERS — a true no-op (brightness
// and tempo at 1.0), so an unconfigured city is untouched rather than washed out or
// dimmed. A real curve value of exactly 1.0 (peak focus center) still maps to peak
// brightness because computeEnergy returns null — not 1.0 — for the "no profile" case.
export function computeChronotypeEnergy(profile, hour) {
  return energyModifiers(computeEnergy(profile, hour));
}
