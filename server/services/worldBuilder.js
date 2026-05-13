/**
 * World Builder Service
 *
 * Stores user-created "world templates" — sci-fi/fantasy/etc. universe
 * descriptions expanded by an LLM into a structured prompt set:
 *
 *   - stylePrompt + negativePrompt (positive style fragment + negative prompt)
 *   - categories: named prompt buckets, seeded with common world-art buckets
 *     like landscapes / characters / vehicles, but open to project-specific
 *     buckets like colonies, factions, species, clothing_styles, or raider_clans
 *     (each with a list of `variations` — short prompt fragments)
 *   - compositeSheets: complete board/poster prompts that combine several
 *     buckets into one image, e.g. a colony costume guide or a world summary
 *     concept pitch poster
 *
 * From those pieces the route can compile a flat list of full prompts and
 * enqueue them as image-gen jobs, all tagged with the same `worldId` and
 * `runId` so the resulting renders form a self-contained collection.
 *
 * Persisted to data/world-builder.json. Renders for a run land in a
 * media-collections.json collection named "World: <worldName>" (or any
 * other name the user picks at kickoff).
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { composeStyledPrompt } from '../lib/composeStyledPrompt.js';

const STATE_PATH = join(PATHS.data, 'world-builder.json');

export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const NAME_MAX_LENGTH = 100;
// A render can enqueue up to 5 categories × 50 variations × 20 batchPerVariation
// = 5000 jobs. Cap at 10k to leave headroom against future bumps to those caps.
const MAX_RUN_JOB_IDS = 10000;
export const STARTER_PROMPT_MAX = 4000;
export const PROMPT_FRAGMENT_MAX = 2000;
export const COMPOSITE_PROMPT_MAX = 4000;
export const VARIATION_LABEL_MAX = 120;
// Narrative bible fields — surfaced into the Pipeline "new series" form so a
// world's logline/premise/style notes can seed a production series in one click.
export const LOGLINE_MAX = 500;
export const PREMISE_MAX = 4000;
export const STYLE_NOTES_MAX = 4000;
export const VARIATIONS_PER_CATEGORY_MAX = 50;
export const COMPOSITE_SHEETS_MAX = 50;
export const COMPOSITE_SHEET_KINDS = Object.freeze([
  'reference_sheet',
  'world_pitch_poster',
]);
export const WORLD_CATEGORY_KEY_MAX = 64;
export const WORLD_CATEGORY_COUNT_MAX = 30;

// Starter buckets the UI surfaces for a fresh world. They remain for
// compatibility, but saved templates may carry any additional sanitized
// category keys the LLM or user creates.
export const WORLD_CATEGORIES = Object.freeze([
  'landscapes',
  'environments',
  'characters',
  'structures',
  'vehicles',
]);

const DEFAULT_STATE = { worlds: [], runs: [] };

const isStr = (v) => typeof v === 'string';
const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

export const normalizeCategoryKey = (raw) => {
  if (!isStr(raw)) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, WORLD_CATEGORY_KEY_MAX);
};

const sanitizeVariation = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, VARIATION_LABEL_MAX);
  const prompt = trimTo(raw.prompt, PROMPT_FRAGMENT_MAX);
  if (!label || !prompt) return null;
  return { label, prompt };
};

const sanitizeCompositeSheet = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, VARIATION_LABEL_MAX);
  const prompt = trimTo(raw.prompt, COMPOSITE_PROMPT_MAX);
  if (!label || !prompt) return null;
  const kind = COMPOSITE_SHEET_KINDS.includes(raw.kind) ? raw.kind : 'reference_sheet';
  return { kind, label, prompt };
};

const sanitizeCategory = (raw) => {
  // Per-category structure: { variations: [{ label, prompt }] }. Cap so a
  // runaway LLM can't blow up the world template; matches the route schema.
  if (!raw || typeof raw !== 'object') return { variations: [] };
  const variations = [];
  if (Array.isArray(raw.variations)) {
    for (const v of raw.variations) {
      const s = sanitizeVariation(v);
      if (!s) continue;
      variations.push(s);
      if (variations.length >= VARIATIONS_PER_CATEGORY_MAX) break;
    }
  }
  return { variations };
};

const mergeCategories = (base, next) => {
  const merged = { ...base };
  for (const [key, category] of Object.entries(next)) {
    const current = merged[key]?.variations || [];
    const incoming = category?.variations || [];
    merged[key] = { variations: [...current, ...incoming].slice(0, VARIATIONS_PER_CATEGORY_MAX) };
  }
  return merged;
};

export const sanitizeCategories = (raw = {}) => {
  const categories = Object.fromEntries(WORLD_CATEGORIES.map((key) => [key, { variations: [] }]));
  if (!raw || typeof raw !== 'object') return categories;

  let customCount = WORLD_CATEGORIES.length;
  for (const [rawKey, rawCategory] of Object.entries(raw)) {
    const key = normalizeCategoryKey(rawKey);
    if (!key) continue;
    if (!categories[key] && customCount >= WORLD_CATEGORY_COUNT_MAX) continue;
    if (!categories[key]) customCount += 1;
    Object.assign(categories, mergeCategories(categories, { [key]: sanitizeCategory(rawCategory) }));
  }
  return categories;
};

export const getWorldCategoryKeys = (categories = {}) => {
  const seen = new Set();
  const keys = [];
  for (const key of [...WORLD_CATEGORIES, ...Object.keys(categories || {})]) {
    const normalized = normalizeCategoryKey(key);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    keys.push(normalized);
  }
  return keys;
};

export const sanitizeCompositeSheets = (raw = []) => {
  if (!Array.isArray(raw)) return [];
  const sheets = [];
  for (const sheet of raw) {
    const sanitized = sanitizeCompositeSheet(sheet);
    if (!sanitized) continue;
    sheets.push(sanitized);
    if (sheets.length >= COMPOSITE_SHEETS_MAX) break;
  }
  return sheets;
};

const sanitizeTemplate = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, NAME_MAX_LENGTH);
  if (!name) return null;
  const starterPrompt = trimTo(raw.starterPrompt, STARTER_PROMPT_MAX);
  const stylePrompt = trimTo(raw.stylePrompt, PROMPT_FRAGMENT_MAX);
  const negativePrompt = trimTo(raw.negativePrompt, PROMPT_FRAGMENT_MAX);
  const logline = trimTo(raw.logline, LOGLINE_MAX);
  const premise = trimTo(raw.premise, PREMISE_MAX);
  const styleNotes = trimTo(raw.styleNotes, STYLE_NOTES_MAX);
  const categories = sanitizeCategories(raw.categories || {});
  const compositeSheets = sanitizeCompositeSheets(raw.compositeSheets || []);
  const llm = raw.llm && typeof raw.llm === 'object'
    ? {
      provider: trimTo(raw.llm.provider, 80) || null,
      model: trimTo(raw.llm.model, 200) || null,
    }
    : { provider: null, model: null };
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  return {
    id: raw.id,
    name,
    starterPrompt,
    stylePrompt,
    negativePrompt,
    logline,
    premise,
    styleNotes,
    categories,
    compositeSheets,
    llm,
    createdAt,
    updatedAt,
  };
};

const sanitizeRun = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  if (!isStr(raw.worldId) || !raw.worldId) return null;
  return {
    id: raw.id,
    worldId: raw.worldId,
    collectionId: isStr(raw.collectionId) ? raw.collectionId : null,
    jobIds: Array.isArray(raw.jobIds) ? raw.jobIds.filter(isStr).slice(0, MAX_RUN_JOB_IDS) : [],
    promptCount: Number.isFinite(raw.promptCount) ? raw.promptCount : 0,
    createdAt: isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
  };
};

async function readState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(STATE_PATH, DEFAULT_STATE, { logError: false });
  const worlds = Array.isArray(raw.worlds) ? raw.worlds.map(sanitizeTemplate).filter(Boolean) : [];
  const runs = Array.isArray(raw.runs) ? raw.runs.map(sanitizeRun).filter(Boolean) : [];
  return { worlds, runs };
}

async function writeState(state) {
  await atomicWrite(STATE_PATH, state);
}

export async function listWorlds() {
  const { worlds } = await readState();
  // Newest first — matches user expectation for a "your worlds" list.
  return [...worlds].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function getWorld(id) {
  const { worlds } = await readState();
  const w = worlds.find((x) => x.id === id);
  if (!w) throw makeErr(`World not found: ${id}`, ERR_NOT_FOUND);
  return w;
}

export async function createWorld(input = {}) {
  const name = trimTo(input.name, NAME_MAX_LENGTH);
  if (!name) throw makeErr(`World name is required (1..${NAME_MAX_LENGTH} chars)`, ERR_VALIDATION);
  const state = await readState();
  const now = new Date().toISOString();
  const next = sanitizeTemplate({
    id: randomUUID(),
    name,
    starterPrompt: input.starterPrompt || '',
    stylePrompt: input.stylePrompt || '',
    negativePrompt: input.negativePrompt || '',
    logline: input.logline || '',
    premise: input.premise || '',
    styleNotes: input.styleNotes || '',
    categories: input.categories || {},
    compositeSheets: input.compositeSheets || [],
    llm: input.llm || {},
    createdAt: now,
    updatedAt: now,
  });
  state.worlds.push(next);
  await writeState(state);
  return next;
}

export async function updateWorld(id, patch = {}) {
  const state = await readState();
  const idx = state.worlds.findIndex((w) => w.id === id);
  if (idx < 0) throw makeErr(`World not found: ${id}`, ERR_NOT_FOUND);
  const cur = state.worlds[idx];

  // Merge `categories` per-key — a partial PATCH that only includes
  // `landscapes` must NOT wipe characters/structures/etc. Whole categories
  // not present in the patch are kept as-is from the current world.
  const mergedCategories = 'categories' in patch
    ? { ...cur.categories, ...(patch.categories || {}) }
    : cur.categories;

  // Merge `llm` field-by-field — sending only `{ provider }` shouldn't
  // clear `model` and vice versa.
  const mergedLlm = 'llm' in patch
    ? { ...(cur.llm || {}), ...(patch.llm || {}) }
    : cur.llm;

  // Scalar fields: only apply what the patch actually carries, so a partial
  // PATCH never clobbers a field the caller didn't send. `categories` + `llm`
  // are handled above (they need per-key merging, not replacement).
  const PATCHABLE_SCALARS = [
    'name', 'starterPrompt', 'stylePrompt', 'negativePrompt',
    'logline', 'premise', 'styleNotes', 'compositeSheets',
  ];
  const scalarPatch = Object.fromEntries(
    PATCHABLE_SCALARS.filter((k) => k in patch).map((k) => [k, patch[k]]),
  );

  const merged = sanitizeTemplate({
    ...cur,
    ...scalarPatch,
    categories: mergedCategories,
    llm: mergedLlm,
    updatedAt: new Date().toISOString(),
  });
  if (!merged) throw makeErr('Invalid world payload', ERR_VALIDATION);
  state.worlds[idx] = merged;
  await writeState(state);
  return merged;
}

export async function deleteWorld(id) {
  const state = await readState();
  const before = state.worlds.length;
  state.worlds = state.worlds.filter((w) => w.id !== id);
  if (state.worlds.length === before) throw makeErr(`World not found: ${id}`, ERR_NOT_FOUND);
  // Drop runs referencing the deleted world — they're useless without it.
  state.runs = state.runs.filter((r) => r.worldId !== id);
  await writeState(state);
  return { id };
}

export async function recordRun(run) {
  const sanitized = sanitizeRun(run);
  if (!sanitized) throw makeErr('Invalid run payload', ERR_VALIDATION);
  const state = await readState();
  state.runs.push(sanitized);
  // Keep last 200 runs to bound state growth.
  if (state.runs.length > 200) state.runs = state.runs.slice(-200);
  await writeState(state);
  return sanitized;
}

export async function listRuns(worldId = null) {
  const { runs } = await readState();
  const filtered = worldId ? runs.filter((r) => r.worldId === worldId) : runs;
  return [...filtered].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * Compile the world template into an ordered list of full image-gen
 * prompts. Each entry combines the world's style prompt with one
 * variation from a chosen category.
 *
 *   selection: { landscapes: 'all' | string[], characters: ... }
 *     - 'all' → use every variation
 *     - array of labels → only those labels (case-insensitive match)
 *     - missing key → skip the category entirely
 *
 *   batchPerVariation: how many renders per variation (1..20)
 */
export function compilePrompts(world, options = {}) {
  if (!world) return [];
  const promptMode = ['variations', 'sheets', 'all'].includes(options.promptMode)
    ? options.promptMode
    : 'variations';
  const selection = options.selection && typeof options.selection === 'object'
    ? options.selection
    : Object.fromEntries(getWorldCategoryKeys(world.categories).map((c) => [c, 'all']));
  const normalizedSelection = {};
  for (const [key, value] of Object.entries(selection)) {
    const normalized = normalizeCategoryKey(key);
    if (normalized) normalizedSelection[normalized] = value;
  }
  const batchPerVariation = Math.max(1, Math.min(20, Number(options.batchPerVariation) || 1));

  const stylePreset = {
    prompt: world.stylePrompt?.trim() || '',
    negativePrompt: world.negativePrompt?.trim() || '',
  };
  const compiled = [];

  if (promptMode === 'variations' || promptMode === 'all') {
    for (const category of getWorldCategoryKeys(normalizedSelection)) {
      const sel = normalizedSelection[category];
      if (!sel) continue;
      const variations = world.categories?.[category]?.variations || [];
      const filtered = sel === 'all'
        ? variations
        : variations.filter((v) => Array.isArray(sel) && sel.some((s) => s.toLowerCase() === v.label.toLowerCase()));
      for (const variation of filtered) {
        const { prompt, negativePrompt } = composeStyledPrompt(variation.prompt, '', stylePreset);
        for (let i = 0; i < batchPerVariation; i += 1) {
          compiled.push({
            category,
            label: variation.label,
            prompt,
            negativePrompt,
            batchIndex: i,
          });
        }
      }
    }
  }

  if (promptMode === 'sheets' || promptMode === 'all') {
    const sheetSelection = options.sheetSelection || 'all';
    const sheets = world.compositeSheets || [];
    const filteredSheets = sheetSelection === 'all'
      ? sheets
      : sheets.filter((s) => Array.isArray(sheetSelection) && sheetSelection.some((label) => label.toLowerCase() === s.label.toLowerCase()));
    for (const sheet of filteredSheets) {
      const { prompt, negativePrompt } = composeStyledPrompt(sheet.prompt, '', stylePreset);
      const category = sheet.kind === 'world_pitch_poster'
        ? 'world_pitch_posters'
        : 'composite_sheets';
      for (let i = 0; i < batchPerVariation; i += 1) {
        compiled.push({
          category,
          label: sheet.label,
          prompt,
          negativePrompt,
          batchIndex: i,
        });
      }
    }
  }

  return compiled;
}
