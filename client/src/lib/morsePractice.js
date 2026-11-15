// Pure adaptive Morse-practice selection. The trainer owns the UI and audio
// lifecycle; this module only decides bounded, reproducible material.
//
// Pure deterministic adaptive Morse sampler — `selectMorsePrompt` combines bounded
// weak-character/confusion weighting with a non-zero exploration floor and only emits material valid
// for the active Koch pool; `canAdvanceMorseLevel` guards level advancement on sample count, accuracy,
// and effective speed.

export const MORSE_SAMPLER_VERSION = 'adaptive-v1';
export const MORSE_MATERIAL_MODES = ['groups', 'words', 'callsigns', 'qso'];

const EXPLORATION_WEIGHT = 1;
const MIN_CHARACTER_SAMPLES = 4;
const MIN_ADVANCE_EFFECTIVE_WPM = 10;
const MAX_TARGET_WEIGHT = 6;

// Kept deliberately small and synthetic so material is available offline and
// never needs a provider/network call. Every candidate is filtered to the
// unlocked Koch pool before it can be selected.
const MATERIAL = {
  words: ['TEST', 'TEN', 'SET', 'METER', 'SAME', 'NAME', 'TUNE', 'WAVE'],
  callsigns: ['K1AM', 'N2ET', 'W3AR', 'K4ME', 'N5TS', 'W6EN'],
  qso: ['CQ TEST', 'DE K1AM', 'UR RST 599', 'TNX 73', 'NAME IS EM'],
};

function hashSeed(seed) {
  let hash = 2166136261;
  for (const char of String(seed ?? 'morse')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizedPool(pool) {
  return [...new Set((Array.isArray(pool) ? pool : []).filter((char) => typeof char === 'string' && char.length === 1))];
}

function availableMaterials(mode, pool) {
  const allowed = new Set(pool);
  return (MATERIAL[mode] || []).filter((text) => [...text].every((char) => char === ' ' || allowed.has(char)));
}

function weightedPick(items, random) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = random() * total;
  for (const item of items) {
    cursor -= item.weight;
    if (cursor <= 0) return item;
  }
  return items[items.length - 1];
}

function characterWeights(pool, progress, recentChars) {
  const stats = new Map((progress?.charAccuracy || []).map((entry) => [entry.char, entry]));
  const pairCounts = new Map();
  for (const pair of progress?.confusionPairs || []) {
    if (pool.includes(pair.sent) && pool.includes(pair.guessed)) {
      pairCounts.set(pair.sent, (pairCounts.get(pair.sent) || 0) + Math.max(0, Number(pair.count) || 0));
      pairCounts.set(pair.guessed, (pairCounts.get(pair.guessed) || 0) + Math.max(0, Number(pair.count) || 0));
    }
  }
  const recent = new Set((recentChars || []).filter((char) => pool.includes(char)));
  return pool.map((char) => {
    const stat = stats.get(char);
    const attempts = Math.max(0, Number(stat?.attempts) || 0);
    const accuracy = attempts > 0 ? Math.max(0, Math.min(100, Number(stat?.accuracy) || 0)) : 100;
    const weakness = attempts >= MIN_CHARACTER_SAMPLES ? (100 - accuracy) / 20 : 0;
    const confusion = Math.min(3, (pairCounts.get(char) || 0) / MIN_CHARACTER_SAMPLES);
    const baseWeight = EXPLORATION_WEIGHT + Math.min(MAX_TARGET_WEIGHT, weakness + confusion);
    // A target remains eligible, but recent appearances are deliberately cooled
    // so one miss cannot monopolize a short round.
    return { char, attempts, accuracy, weight: recent.has(char) ? Math.max(EXPLORATION_WEIGHT, baseWeight / 3) : baseWeight };
  });
}

export function selectMorsePrompt({ seed, pool, progress, materialMode = 'groups', adaptive = true, groupLength = 1, recentChars = [] } = {}) {
  const unlocked = normalizedPool(pool);
  if (unlocked.length === 0) return { text: '', samplerVersion: MORSE_SAMPLER_VERSION, materialMode: 'groups', targetedChars: [], reason: 'No unlocked characters.' };

  const random = seededRandom(seed);
  const mode = MORSE_MATERIAL_MODES.includes(materialMode) ? materialMode : 'groups';
  const weights = characterWeights(unlocked, adaptive ? progress : null, adaptive ? recentChars : []);
  const targeted = [...weights].sort((a, b) => b.weight - a.weight || a.char.localeCompare(b.char)).filter((entry) => entry.weight > EXPLORATION_WEIGHT);
  const material = mode === 'groups' ? [] : availableMaterials(mode, unlocked);
  if (material.length > 0) {
    const text = material[Math.floor(random() * material.length)];
    const targetChars = [...new Set([...text].filter((char) => targeted.some((entry) => entry.char === char)))];
    return {
      text,
      samplerVersion: MORSE_SAMPLER_VERSION,
      materialMode: mode,
      targetedChars: targetChars,
      reason: targetChars.length > 0 ? `Includes practice for ${targetChars.join(', ')}.` : 'Balanced transfer practice from your unlocked Koch pool.',
    };
  }

  const length = Math.max(1, Math.min(12, Math.round(groupLength) || 1));
  const balancedWeights = weights.map((entry) => ({ ...entry, weight: EXPLORATION_WEIGHT }));
  const picks = Array.from({ length }, () => weightedPick(adaptive ? weights : balancedWeights, random).char);
  const targetChars = [...new Set(picks.filter((char) => targeted.some((entry) => entry.char === char)))];
  const primaryPair = (progress?.confusionPairs || []).find((pair) => targetChars.includes(pair.sent) && targetChars.includes(pair.guessed));
  return {
    text: picks.join(''),
    samplerVersion: MORSE_SAMPLER_VERSION,
    materialMode: 'groups',
    targetedChars: targetChars,
    reason: primaryPair ? `Targeting the ${primaryPair.sent} / ${primaryPair.guessed} confusion while keeping every unlocked character in rotation.` : targetChars.length > 0 ? `Targeting ${targetChars.join(', ')} while keeping every unlocked character in rotation.` : 'Balanced coverage across every unlocked character.',
  };
}

export function canAdvanceMorseLevel({ items, accuracy, wpm, effectiveWpm } = {}) {
  const sampleCount = Array.isArray(items) ? items.filter((item) => item?.sent).length : 0;
  const speed = Number.isFinite(effectiveWpm) ? effectiveWpm : wpm;
  return sampleCount >= 10 && Number(accuracy) >= 90 && Number(speed) >= MIN_ADVANCE_EFFECTIVE_WPM;
}
