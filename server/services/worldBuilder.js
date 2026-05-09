/**
 * World Builder Service
 *
 * Stores user-created "world templates" — sci-fi/fantasy/etc. universe
 * descriptions expanded by an LLM into a structured prompt set:
 *
 *   - stylePrompt + negativePrompt (positive style fragment + negative prompt)
 *   - categories: landscapes / environments / characters / structures / vehicles
 *     (each with a list of `variations` — short prompt fragments)
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
export const VARIATION_LABEL_MAX = 120;
export const VARIATIONS_PER_CATEGORY_MAX = 50;

// Five canonical buckets the UI surfaces. Stored on the template so a
// future template type (e.g. "creatures") only needs adding here. Order
// is the user-facing display order.
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

const sanitizeVariation = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, VARIATION_LABEL_MAX);
  const prompt = trimTo(raw.prompt, PROMPT_FRAGMENT_MAX);
  if (!label || !prompt) return null;
  return { label, prompt };
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

const sanitizeTemplate = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, NAME_MAX_LENGTH);
  if (!name) return null;
  const starterPrompt = trimTo(raw.starterPrompt, STARTER_PROMPT_MAX);
  const stylePrompt = trimTo(raw.stylePrompt, PROMPT_FRAGMENT_MAX);
  const negativePrompt = trimTo(raw.negativePrompt, PROMPT_FRAGMENT_MAX);
  const categories = {};
  for (const key of WORLD_CATEGORIES) {
    categories[key] = sanitizeCategory(raw.categories?.[key]);
  }
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
    categories,
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
    categories: input.categories || {},
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

  const merged = sanitizeTemplate({
    ...cur,
    ...('name' in patch ? { name: patch.name } : {}),
    ...('starterPrompt' in patch ? { starterPrompt: patch.starterPrompt } : {}),
    ...('stylePrompt' in patch ? { stylePrompt: patch.stylePrompt } : {}),
    ...('negativePrompt' in patch ? { negativePrompt: patch.negativePrompt } : {}),
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
  if (!world || !world.categories) return [];
  const selection = options.selection && typeof options.selection === 'object'
    ? options.selection
    : Object.fromEntries(WORLD_CATEGORIES.map((c) => [c, 'all']));
  const batchPerVariation = Math.max(1, Math.min(20, Number(options.batchPerVariation) || 1));

  const stylePart = world.stylePrompt?.trim();
  const negativePrompt = world.negativePrompt?.trim() || '';
  const compiled = [];

  for (const category of WORLD_CATEGORIES) {
    const sel = selection[category];
    if (!sel) continue;
    const variations = world.categories[category]?.variations || [];
    const filtered = sel === 'all'
      ? variations
      : variations.filter((v) => Array.isArray(sel) && sel.some((s) => s.toLowerCase() === v.label.toLowerCase()));
    for (const variation of filtered) {
      const prompt = [stylePart, variation.prompt].filter(Boolean).join(', ');
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

  return compiled;
}
