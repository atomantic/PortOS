// Meatspace / MortalLoom voice tools: alcohol, nicotine, weight, workout, and
// a today-summary. Free-form category presets keep the spoken UX terse ("I had
// a beer" needs no oz/ABV recitation).

import { logDrink, getAlcoholSummary } from '../../meatspaceAlcohol.js';
import { logNicotine, getNicotineSummary } from '../../meatspaceNicotine.js';
import { addBodyEntry, addWorkout } from '../../meatspaceHealth.js';

// `run`/`ran` were dropped — they collide with common command phrasing
// ("run the pipeline", "I ran the report") and would expose the workout tool
// on non-fitness turns. Genuine run-logging is recovered via the "went
// for/on a … run" phrasing and the "ran …" branch below, which requires a
// fitness OBJECT — a distance/race ("ran a 5k", "ran 3 miles", "ran a
// marathon"), a route ("ran my usual route", "ran my loop"), or a duration
// WITH a time unit ("ran for 30 minutes", "ran for an hour"). The duration
// branch insists on a minute/hour/second unit so "ran for a report", "ran for
// office", and "ran for president" no longer match, just as "I ran a report",
// "ran an errand", and "ran my mouth" don't. Other activity nouns
// (jog/yoga/cardio/gym/…) rarely collide in voice commands.
export const MEATSPACE_INTENT_RE = /\b(drink|drank|beer|wine|whiskey|shot|cocktail|cigarette|vape|pouch|nicotine|weigh|pound|kilo|kg|smoke|smoking|workout|exercise|exercised|jog|yoga|lift(?:ed|ing)?|cardio|gym|cycling|cycled|swim|swam|how am I|summary today|log (?:a|my) (?:drink|weight|nicotine|workout|run|exercise))\b|\bwent (?:for|on) (?:a |an )?(?:\w+ ){0,2}(?:run|jog|swim|ride|walk|hike|workout)\b|\bran (?:a |an |my )?(?:\w+ ){0,2}(?:\d+\s?k\b|\d+\s?km\b|miles?\b|marathons?\b|half[- ]?marathons?\b|5k\b|10k\b|loops?\b|routes?\b|trails?\b|laps?\b)|\bran for (?:\w+ ){0,3}(?:hours?|hrs?|mins?|minutes?|seconds?|secs?)\b/i;

// Shorthand presets for voice logging. A user saying "I had a beer" should
// not need to recite oz + ABV — these defaults match typical US servings.
const DRINK_PRESETS = {
  beer:    { oz: 12,  abv: 5  },
  wine:    { oz: 5,   abv: 13 },
  whiskey: { oz: 1.5, abv: 40 },
  shot:    { oz: 1.5, abv: 40 },
  cocktail:{ oz: 3,   abv: 20 },
};

const NICOTINE_PRESETS = {
  cigarette: { mgPerUnit: 1 },
  vape:      { mgPerUnit: 1 },
  pouch:     { mgPerUnit: 6 },
};

const resolveDrinkPreset = (name) => {
  const key = Object.keys(DRINK_PRESETS).find((k) => name.toLowerCase().includes(k));
  return key ? DRINK_PRESETS[key] : DRINK_PRESETS.beer;
};

const resolveNicotinePreset = (product) => {
  const key = Object.keys(NICOTINE_PRESETS).find((k) => product.toLowerCase().includes(k));
  return key ? NICOTINE_PRESETS[key] : NICOTINE_PRESETS.cigarette;
};

export const MEATSPACE_TOOLS = [
  {
    name: 'meatspace_log_drink',
    description:
      'Log an alcoholic drink to MortalLoom / Meatspace tracking. Use when the user says things like "I had a beer", "log a glass of wine", "I just had two whiskeys". The "name" field takes free-form ("IPA", "Cabernet", "Old Fashioned") — known categories (beer/wine/whiskey/shot/cocktail) get sensible oz+ABV defaults, otherwise the user should specify oz+abv explicitly.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drink name or category (e.g. "beer", "IPA", "Cabernet", "whiskey").' },
        count: { type: 'number', description: 'How many (default 1).' },
        oz: { type: 'number', description: 'Serving size in ounces. Omit to use category default.' },
        abv: { type: 'number', description: 'Alcohol by volume percent (e.g. 5 for 5%). Omit to use category default.' },
      },
      required: ['name'],
    },
    execute: async ({ name, count = 1, oz, abv }) => {
      if (!name || typeof name !== 'string') throw new Error('name is required');
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('name must not be empty');
      // Tool args come from an LLM — guard against negative/NaN counts, absurd
      // serving sizes (gallons), and impossible ABV (>100%) before persistence.
      if (!Number.isFinite(count) || count <= 0 || count > 50) {
        throw new Error('count must be a positive number (≤50)');
      }
      const preset = resolveDrinkPreset(trimmedName);
      const resolvedOz = oz ?? preset.oz;
      const resolvedAbv = abv ?? preset.abv;
      if (!Number.isFinite(resolvedOz) || resolvedOz <= 0 || resolvedOz > 128) {
        throw new Error('oz must be a positive number (≤128)');
      }
      if (!Number.isFinite(resolvedAbv) || resolvedAbv < 0 || resolvedAbv > 100) {
        throw new Error('abv must be between 0 and 100');
      }
      const result = await logDrink({
        name: trimmedName,
        oz: resolvedOz,
        abv: resolvedAbv,
        count,
      });
      return {
        ok: true,
        summary: `Logged ${count} ${trimmedName} (${result.standardDrinks.toFixed(1)} std drinks). Day total: ${result.dayTotal.toFixed(1)} std drinks.`,
      };
    },
  },

  {
    name: 'meatspace_log_nicotine',
    description:
      'Log nicotine use (cigarette, vape puff, pouch) to MortalLoom / Meatspace tracking. Use when the user says "I had a cigarette", "two pouches", "just vaped". Known categories (cigarette/vape/pouch) get sensible mgPerUnit defaults; otherwise specify mgPerUnit explicitly.',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product type (e.g. "cigarette", "vape", "Zyn pouch", "cigar").' },
        count: { type: 'number', description: 'How many units (default 1).' },
        mgPerUnit: { type: 'number', description: 'Nicotine milligrams per unit. Omit to use category default.' },
      },
      required: ['product'],
    },
    execute: async ({ product, count = 1, mgPerUnit }) => {
      if (!product || typeof product !== 'string') throw new Error('product is required');
      const trimmedProduct = product.trim();
      if (!trimmedProduct) throw new Error('product must not be empty');
      if (!Number.isFinite(count) || count <= 0 || count > 100) {
        throw new Error('count must be a positive number (≤100)');
      }
      const preset = resolveNicotinePreset(trimmedProduct);
      const resolvedMg = mgPerUnit ?? preset.mgPerUnit;
      if (!Number.isFinite(resolvedMg) || resolvedMg < 0 || resolvedMg > 200) {
        throw new Error('mgPerUnit must be between 0 and 200');
      }
      const result = await logNicotine({
        product: trimmedProduct,
        mgPerUnit: resolvedMg,
        count,
      });
      return {
        ok: true,
        summary: `Logged ${count} ${trimmedProduct} (${result.totalMg}mg). Day total: ${result.dayTotal.toFixed(1)}mg nicotine.`,
      };
    },
  },

  {
    name: 'meatspace_summary_today',
    description:
      'Report today\'s alcohol and nicotine totals against rolling averages. Use when the user asks "how am I doing today?", "what\'s my drink count?", "have I had any cigarettes today?".',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const [alcohol, nicotine] = await Promise.all([getAlcoholSummary(), getNicotineSummary()]);
      const parts = [
        alcohol.today > 0
          ? `${alcohol.today.toFixed(1)} standard drinks today`
          : 'No drinks logged today',
        nicotine.today > 0
          ? `${nicotine.today.toFixed(1)}mg nicotine today`
          : 'No nicotine logged today',
      ];
      if (alcohol.avg7day) parts.push(`7-day avg ${alcohol.avg7day.toFixed(1)} drinks/day`);
      if (nicotine.avg7day) parts.push(`${nicotine.avg7day.toFixed(1)}mg/day nicotine avg`);
      return { ok: true, summary: parts.join('. ') + '.' };
    },
  },

  {
    name: 'meatspace_log_weight',
    description:
      'Log a body weight entry to MortalLoom / Meatspace tracking. Use when the user says "log my weight at 180", "I weigh 175 today", "weigh-in at eighty kilos". Defaults to today. Unit is lb unless the user explicitly mentions kg.',
    parameters: {
      type: 'object',
      properties: {
        weight: { type: 'number', description: 'Body weight value.' },
        unit: { type: 'string', enum: ['lb', 'kg'], description: 'Unit (lb or kg). Default lb.' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD). Omit for today.' },
      },
      required: ['weight'],
    },
    execute: async ({ weight, unit = 'lb', date }) => {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        throw new Error('weight must be a positive number');
      }
      // Validate unit explicitly — tool args come from an LLM, so "kgs"
      // or "pounds" would otherwise silently be treated as lb and corrupt
      // the body-weight log.
      if (unit !== 'lb' && unit !== 'kg') {
        throw new Error('unit must be either "lb" or "kg"');
      }
      const weightLb = unit === 'kg' ? weight * 2.2046226218 : weight;
      // Upper guard catches STT mis-transcriptions ("eighty" → "1800") before
      // they silently corrupt body-weight history.
      if (weightLb > 800) throw new Error(`weight ${weight}${unit} is out of realistic range`);
      const entry = await addBodyEntry({ date, weight: weightLb });
      return {
        ok: true,
        summary: `Logged ${weight}${unit} on ${entry.date}.`,
      };
    },
  },

  {
    name: 'meatspace_log_workout',
    description:
      'Log a workout / exercise session to Meatspace tracking. Use when the user says "log a workout", "I went for a 30 minute run", "did an hour of yoga", "lifted weights for 45 minutes". The `type` is free-form (run, yoga, lifting, cycling, swim, etc.). Duration and intensity are optional.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Workout type (e.g. "run", "yoga", "weightlifting", "cycling").' },
        durationMinutes: { type: 'number', description: 'How long, in minutes. Omit if unknown.' },
        intensity: { type: 'string', enum: ['light', 'moderate', 'vigorous'], description: 'Optional perceived intensity.' },
        notes: { type: 'string', description: 'Optional free-form notes about the session.' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD). Omit for today.' },
      },
      required: ['type'],
    },
    execute: async ({ type, durationMinutes, intensity, notes, date } = {}) => {
      if (typeof type !== 'string' || !type.trim()) throw new Error('type is required');
      let resolvedDuration;
      if (durationMinutes !== undefined && durationMinutes !== null && durationMinutes !== '') {
        const parsed = Number(durationMinutes);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1440) {
          throw new Error('durationMinutes must be a positive number (≤1440)');
        }
        resolvedDuration = parsed;
      }
      if (intensity !== undefined && intensity !== null && !['light', 'moderate', 'vigorous'].includes(intensity)) {
        throw new Error('intensity must be light, moderate, or vigorous');
      }
      const entry = await addWorkout({
        date,
        type: type.trim(),
        durationMinutes: resolvedDuration,
        intensity,
        notes,
      });
      const durPart = entry.durationMinutes ? ` (${entry.durationMinutes} min)` : '';
      return {
        ok: true,
        date: entry.date,
        type: entry.type,
        summary: `Logged ${entry.type}${durPart} on ${entry.date}.`,
      };
    },
  },
];
