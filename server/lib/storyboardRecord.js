/**
 * Storyboard records — the shared planning board under Create › Storyboards.
 *
 * A storyboard holds beats, and a beat holds panels; a panel is one planned
 * shot. Productions (music videos, Creative Director videos, FableLoom,
 * Series Pipeline) link a board rather than keeping a private plan, so the
 * board is written to work before a song or edit exists: each panel carries
 * estimated seconds and each beat a musical role, both optional.
 *
 * Panels point at catalog records (cast, environments, objects) by id only;
 * the catalog stays the store for those. Panel art is a list of takes, each a
 * gallery image filename (upload, catalog image, mood board pin, generated
 * frame) or a blank-canvas sketch key (`sketch:<uuid>`, owned by
 * services/mediaSketches.js); `selectedTakeId` names the one shown.
 *
 * Vocabulary and caps live in storyboardVocabulary.js (browser-safe).
 * `sanitizeStoryboard` is the single normalizer every write passes through:
 * it never invents content, drops malformed entries, and keeps a stale
 * `selectedTakeId` from pointing at a removed take.
 */

import { isNonBlankStr, trimTo } from './textUtils.js';
import { localImageFilename } from './localImageFilename.js';
import { sanitizeSoftDeleteFields } from './syncWire.js';
import {
  isValidStoryboardId, isValidStoryboardRecipeId, newStoryboardEntityId, STORYBOARD_ART_STYLES, STORYBOARD_ASPECT_RATIOS, STORYBOARD_LIMITS,
  STORYBOARD_MUSICAL_ROLES, STORYBOARD_PANEL_FRAMINGS, STORYBOARD_TAKE_SOURCES,
} from './storyboardVocabulary.js';
import { RECIPE_LIMITS, sanitizePanelMake, sanitizeRecipe } from './storyboardRecipe.js';

const SKETCH_KEY_PATTERN = /^sketch:[A-Za-z0-9-]{1,80}$/;
const ENTITY_ID_PATTERN = /^[a-z]+-[A-Za-z0-9-]{1,80}$/;

const ASPECT_SET = new Set(STORYBOARD_ASPECT_RATIOS);
const ART_STYLE_SET = new Set(STORYBOARD_ART_STYLES);
const ROLE_SET = new Set(STORYBOARD_MUSICAL_ROLES);
const FRAMING_SET = new Set(STORYBOARD_PANEL_FRAMINGS);
const SOURCE_SET = new Set(STORYBOARD_TAKE_SOURCES);

const pick = (value, set, fallback = null) => (set.has(value) ? value : fallback);
const isoOr = (value, fallback) => (isNonBlankStr(value) && Number.isFinite(Date.parse(value)) ? value : fallback);
const entityId = (value, prefix) => (typeof value === 'string' && ENTITY_ID_PATTERN.test(value) ? value : newStoryboardEntityId(prefix));

function refList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const id = trimTo(item, STORYBOARD_LIMITS.refId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= STORYBOARD_LIMITS.refs) break;
  }
  return out;
}

/** Seconds as a positive number rounded to hundredths, or null when unset. */
function sanitizePanelSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(Math.min(value, STORYBOARD_LIMITS.panelSecondsMax) * 100) / 100;
}

/** A take is a gallery image or a sketch key; anything else is dropped. */
export function sanitizeTake(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = pick(raw.source, SOURCE_SET);
  if (!source) return null;
  if (source === 'sketch') {
    if (typeof raw.sketchKey !== 'string' || !SKETCH_KEY_PATTERN.test(raw.sketchKey)) return null;
    return { id: entityId(raw.id, 'take'), source, image: null, sketchKey: raw.sketchKey, refId: null, addedAt: isoOr(raw.addedAt, new Date().toISOString()) };
  }
  const image = localImageFilename(raw.image);
  if (!image) return null;
  return {
    id: entityId(raw.id, 'take'),
    source,
    image,
    sketchKey: null,
    refId: trimTo(raw.refId, STORYBOARD_LIMITS.refId) || null,
    addedAt: isoOr(raw.addedAt, new Date().toISOString()),
  };
}

function sanitizePanel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const takes = [];
  const takeIds = new Set();
  for (const item of Array.isArray(raw.takes) ? raw.takes : []) {
    const take = sanitizeTake(item);
    if (!take || takeIds.has(take.id)) continue;
    takeIds.add(take.id);
    takes.push(take);
    if (takes.length >= STORYBOARD_LIMITS.takes) break;
  }
  const selectedTakeId = takeIds.has(raw.selectedTakeId) ? raw.selectedTakeId : (takes.at(-1)?.id ?? null);
  return {
    id: entityId(raw.id, 'panel'),
    action: trimTo(raw.action, STORYBOARD_LIMITS.panelText),
    dialogue: trimTo(raw.dialogue, STORYBOARD_LIMITS.panelText),
    framing: pick(raw.framing, FRAMING_SET),
    camera: trimTo(raw.camera, STORYBOARD_LIMITS.camera),
    seconds: sanitizePanelSeconds(raw.seconds),
    castIds: refList(raw.castIds),
    environmentIds: refList(raw.environmentIds),
    objectIds: refList(raw.objectIds),
    notes: trimTo(raw.notes, STORYBOARD_LIMITS.notes),
    takes,
    selectedTakeId,
    make: sanitizePanelMake(raw.make, takeIds),
  };
}

function sanitizeBeat(raw, budget = { panels: STORYBOARD_LIMITS.panelsTotal }) {
  if (!raw || typeof raw !== 'object') return null;
  const panels = [];
  const ids = new Set();
  for (const item of Array.isArray(raw.panels) ? raw.panels : []) {
    if (panels.length >= STORYBOARD_LIMITS.panelsPerBeat || budget.panels <= 0) break;
    const panel = sanitizePanel(item);
    if (!panel || ids.has(panel.id)) continue;
    ids.add(panel.id);
    panels.push(panel);
    budget.panels -= 1;
  }
  return {
    id: entityId(raw.id, 'beat'),
    title: trimTo(raw.title, STORYBOARD_LIMITS.beatTitle),
    what: trimTo(raw.what, STORYBOARD_LIMITS.beatText),
    why: trimTo(raw.why, STORYBOARD_LIMITS.beatText),
    emotion: trimTo(raw.emotion, STORYBOARD_LIMITS.emotion),
    musicalRole: pick(raw.musicalRole, ROLE_SET),
    sectionHint: trimTo(raw.sectionHint, STORYBOARD_LIMITS.sectionHint),
    panels,
  };
}

/** Normalize a whole storyboard record, or null when it has no valid id. */
export function sanitizeStoryboard(raw) {
  if (!raw || typeof raw !== 'object' || !isValidStoryboardId(raw.id)) return null;
  const now = new Date().toISOString();
  const budget = { panels: STORYBOARD_LIMITS.panelsTotal };
  const beats = [];
  const ids = new Set();
  for (const item of Array.isArray(raw.beats) ? raw.beats : []) {
    if (beats.length >= STORYBOARD_LIMITS.beats) break;
    const beat = sanitizeBeat(item, budget);
    if (!beat || ids.has(beat.id)) continue;
    ids.add(beat.id);
    beats.push(beat);
  }
  const createdAt = isoOr(raw.createdAt, now);
  return {
    id: raw.id,
    name: trimTo(raw.name, STORYBOARD_LIMITS.name) || 'Untitled storyboard',
    logline: trimTo(raw.logline, STORYBOARD_LIMITS.logline),
    aspectRatio: pick(raw.aspectRatio, ASPECT_SET, '16:9'),
    artStyle: pick(raw.artStyle, ART_STYLE_SET, 'pencil'),
    universeId: trimTo(raw.universeId, STORYBOARD_LIMITS.refId) || null,
    moodBoardId: trimTo(raw.moodBoardId, STORYBOARD_LIMITS.refId) || null,
    recipe: sanitizeRecipe(raw.recipe),
    beats,
    createdAt,
    updatedAt: isoOr(raw.updatedAt, createdAt),
    ...sanitizeSoftDeleteFields(raw),
  };
}

/**
 * A saved recipe in the Make tab's library: a named copy of a board's node
 * graph that any board can load. Per-panel run state never travels with it.
 */
export function sanitizeSavedRecipe(raw) {
  if (!raw || typeof raw !== 'object' || !isValidStoryboardRecipeId(raw.id)) return null;
  const recipe = sanitizeRecipe(raw.recipe);
  if (!recipe) return null;
  const createdAt = isoOr(raw.createdAt, new Date().toISOString());
  return {
    id: raw.id,
    name: trimTo(raw.name, RECIPE_LIMITS.title) || 'Untitled recipe',
    recipe,
    createdAt,
    updatedAt: isoOr(raw.updatedAt, createdAt),
    ...sanitizeSoftDeleteFields(raw),
  };
}

/** Estimated runtime of a board in seconds (panels without seconds count 0). */
function storyboardRuntime(board) {
  return (board?.beats || []).reduce(
    (sum, beat) => sum + (beat.panels || []).reduce((s, panel) => s + (panel.seconds || 0), 0),
    0,
  );
}

/** List-row projection: no panels or takes, just what the index shows. */
export function summarizeStoryboard(board) {
  const panels = (board.beats || []).flatMap((beat) => beat.panels || []);
  const cover = panels.map((panel) => panel.takes.find((take) => take.id === panel.selectedTakeId)).find(Boolean) || null;
  return {
    id: board.id,
    name: board.name,
    logline: board.logline,
    aspectRatio: board.aspectRatio,
    beatCount: board.beats.length,
    panelCount: panels.length,
    runtimeSec: storyboardRuntime(board),
    cover: cover ? { image: cover.image, sketchKey: cover.sketchKey } : null,
    updatedAt: board.updatedAt,
  };
}
