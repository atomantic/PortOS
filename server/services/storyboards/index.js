/**
 * Storyboards service — CRUD over boards, beats, panels and panel art takes.
 *
 * Every write funnels through `mutateStoryboard` (per-record write queue, then
 * a full re-sanitize), so concurrent edits from two open tabs or a beat edit
 * racing a panel add merge against the freshest record and a malformed
 * mutation never persists. A tombstoned board reads as missing.
 *
 * Federated as record kind `storyboard` (sync.js): every write emits a record
 * event so subscribed peers get the new revision, and a delete is a tombstone.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { sanitizeStoryboard, sanitizeTake, summarizeStoryboard } from '../../lib/storyboardRecord.js';
import { defaultStoryboardStyle, defaultStoryboardSystemPrompt } from '../../lib/storyboardRecipe.js';
import {
  isValidStoryboardId, newStoryboardEntityId, newStoryboardId, STORYBOARD_LIMITS,
} from '../../lib/storyboardVocabulary.js';
import { autoSubscribeRecordToAllPeers, emitRecordDeleted, emitRecordUpdated } from '../sharing/recordEvents.js';
import { listRaw, queueStoryboardWrite, readRaw, writeRaw } from './store.js';
import { STORYBOARD_KIND } from './sync.js';

export * from './sync.js';

const notFound = (what = 'Storyboard') => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });
const tooMany = (message) => new ServerError(message, { status: 409, code: 'STORYBOARD_LIMIT' });

const BOARD_FIELDS = ['name', 'logline', 'aspectRatio', 'artStyle', 'universeId', 'moodBoardId', 'plot', 'tempTrack'];
const BEAT_FIELDS = ['title', 'what', 'why', 'emotion', 'musicalRole', 'sectionHint', 'pin', 'beforeSong'];
const PANEL_FIELDS = ['action', 'dialogue', 'framing', 'angle', 'facing', 'composition', 'camera', 'seconds', 'castIds', 'environmentIds', 'objectIds', 'notes'];

const pickFields = (patch, fields) => Object.fromEntries(
  fields.filter((key) => Object.hasOwn(patch || {}, key)).map((key) => [key, patch[key]]),
);

const clampIndex = (index, length) => (Number.isInteger(index) ? Math.max(0, Math.min(index, length)) : length);

async function readLive(id) {
  if (!isValidStoryboardId(id)) return null;
  const raw = await readRaw(id);
  const board = sanitizeStoryboard(raw);
  return board && !board.deleted ? board : null;
}

export async function listStoryboards() {
  const rows = await listRaw();
  return rows
    .map(sanitizeStoryboard)
    .filter((board) => board && !board.deleted)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summarizeStoryboard);
}

export async function getStoryboard(id) {
  const board = await readLive(id);
  if (!board) throw notFound();
  return board;
}

/**
 * A new board; `beats` seeds it (e.g. built from a music video's shots) and
 * `source` names the production it was made from (server-set, never patched).
 */
export async function createStoryboard(input = {}, { beats = [], source = null } = {}) {
  const now = new Date().toISOString();
  const board = sanitizeStoryboard({ ...pickFields(input, BOARD_FIELDS), id: newStoryboardId(), beats, source, createdAt: now, updatedAt: now });
  await writeRaw(board.id, board);
  emitRecordUpdated(STORYBOARD_KIND, board.id);
  autoSubscribeRecordToAllPeers(STORYBOARD_KIND, board.id).catch(() => {});
  console.log(`🎬 Created storyboard ${board.id}`);
  return board;
}

/**
 * Run `mutate(board)` against the freshest live record under the per-record
 * queue. The mutator edits the draft in place and may return a value for the
 * caller; the sanitized board is persisted with a fresh `updatedAt`.
 */
export async function mutateStoryboard(id, mutate) {
  if (!isValidStoryboardId(id)) throw notFound();
  const outcome = await queueStoryboardWrite(id, async () => {
    const current = await readLive(id);
    if (!current) throw notFound();
    const draft = structuredClone(current);
    const result = mutate(draft);
    const next = sanitizeStoryboard({ ...draft, id, updatedAt: new Date().toISOString() });
    await writeRaw(id, next);
    return { board: next, result };
  });
  (outcome.board.deleted ? emitRecordDeleted : emitRecordUpdated)(STORYBOARD_KIND, id);
  return outcome;
}

// A new art style restyles a saved recipe's style nodes that still hold the
// old style's default; a style prompt the user edited is theirs and stays.
function restyleRecipe(draft, artStyle) {
  if (!artStyle || artStyle === draft.artStyle || !Array.isArray(draft.recipe?.nodes)) return;
  const defaults = [defaultStoryboardStyle, defaultStoryboardSystemPrompt];
  for (const node of draft.recipe.nodes) {
    const kind = node?.type === 'system' ? defaults.find((text) => node.text === text(draft.artStyle)) : null;
    if (kind) node.text = kind(artStyle);
  }
}

export async function updateStoryboard(id, patch) {
  const { board } = await mutateStoryboard(id, (draft) => {
    restyleRecipe(draft, patch?.artStyle);
    Object.assign(draft, pickFields(patch, BOARD_FIELDS));
  });
  return board;
}

export async function deleteStoryboard(id) {
  await mutateStoryboard(id, (draft) => {
    draft.deleted = true;
    draft.deletedAt = new Date().toISOString();
  });
  return { ok: true };
}

const findBeat = (board, beatId) => {
  const beat = board.beats.find((b) => b.id === beatId);
  if (!beat) throw notFound('Beat');
  return beat;
};

const findPanel = (board, panelId) => {
  for (const beat of board.beats) {
    const index = beat.panels.findIndex((p) => p.id === panelId);
    if (index >= 0) return { beat, panel: beat.panels[index], index };
  }
  throw notFound('Panel');
};

const panelCount = (board) => board.beats.reduce((sum, beat) => sum + beat.panels.length, 0);

export async function addBeat(id, fields = {}, { index } = {}) {
  const { board, result } = await mutateStoryboard(id, (draft) => {
    if (draft.beats.length >= STORYBOARD_LIMITS.beats) throw tooMany(`A storyboard holds at most ${STORYBOARD_LIMITS.beats} beats.`);
    const beat = { ...pickFields(fields, BEAT_FIELDS), id: newStoryboardEntityId('beat'), panels: [] };
    draft.beats.splice(clampIndex(index, draft.beats.length), 0, beat);
    return beat.id;
  });
  return { board, beatId: result };
}

export async function updateBeat(id, beatId, patch) {
  const { board } = await mutateStoryboard(id, (draft) => { Object.assign(findBeat(draft, beatId), pickFields(patch, BEAT_FIELDS)); });
  return board;
}

export async function deleteBeat(id, beatId) {
  const { board } = await mutateStoryboard(id, (draft) => {
    findBeat(draft, beatId);
    draft.beats = draft.beats.filter((b) => b.id !== beatId);
  });
  return board;
}

export async function moveBeat(id, beatId, toIndex) {
  const { board } = await mutateStoryboard(id, (draft) => {
    const beat = findBeat(draft, beatId);
    draft.beats = draft.beats.filter((b) => b.id !== beatId);
    draft.beats.splice(clampIndex(toIndex, draft.beats.length), 0, beat);
  });
  return board;
}

export async function addPanel(id, beatId, fields = {}, { index } = {}) {
  const { board, result } = await mutateStoryboard(id, (draft) => {
    const beat = findBeat(draft, beatId);
    if (beat.panels.length >= STORYBOARD_LIMITS.panelsPerBeat) throw tooMany(`A beat holds at most ${STORYBOARD_LIMITS.panelsPerBeat} panels.`);
    if (panelCount(draft) >= STORYBOARD_LIMITS.panelsTotal) throw tooMany(`A storyboard holds at most ${STORYBOARD_LIMITS.panelsTotal} panels.`);
    const panel = { ...pickFields(fields, PANEL_FIELDS), id: newStoryboardEntityId('panel'), takes: [], selectedTakeId: null };
    beat.panels.splice(clampIndex(index, beat.panels.length), 0, panel);
    return panel.id;
  });
  return { board, panelId: result };
}

export async function updatePanel(id, panelId, patch) {
  const { board } = await mutateStoryboard(id, (draft) => { Object.assign(findPanel(draft, panelId).panel, pickFields(patch, PANEL_FIELDS)); });
  return board;
}

export async function deletePanel(id, panelId) {
  const { board } = await mutateStoryboard(id, (draft) => {
    const { beat } = findPanel(draft, panelId);
    beat.panels = beat.panels.filter((p) => p.id !== panelId);
  });
  return board;
}

/** Move a panel to `index` within `beatId` (its own beat when omitted). */
export async function movePanel(id, panelId, { beatId, index } = {}) {
  const { board } = await mutateStoryboard(id, (draft) => {
    const { beat: from, panel } = findPanel(draft, panelId);
    const to = beatId ? findBeat(draft, beatId) : from;
    if (to !== from && to.panels.length >= STORYBOARD_LIMITS.panelsPerBeat) throw tooMany(`A beat holds at most ${STORYBOARD_LIMITS.panelsPerBeat} panels.`);
    from.panels = from.panels.filter((p) => p.id !== panelId);
    to.panels.splice(clampIndex(index, to.panels.length), 0, panel);
  });
  return board;
}

/** Add a take to a panel's art and make it the selected one. */
export async function addPanelTake(id, panelId, take) {
  const entry = sanitizeTake({ ...take, id: newStoryboardEntityId('take'), addedAt: new Date().toISOString() });
  if (!entry) throw new ServerError('Panel art must be a gallery image or a sketch.', { status: 400, code: 'VALIDATION_ERROR' });
  const { board } = await mutateStoryboard(id, (draft) => {
    const { panel } = findPanel(draft, panelId);
    if (panel.takes.length >= STORYBOARD_LIMITS.takes) throw tooMany(`A panel keeps at most ${STORYBOARD_LIMITS.takes} takes; remove one first.`);
    panel.takes.push(entry);
    panel.selectedTakeId = entry.id;
  });
  return { board, takeId: entry.id };
}

export async function selectPanelTake(id, panelId, takeId) {
  const { board } = await mutateStoryboard(id, (draft) => {
    const { panel } = findPanel(draft, panelId);
    if (!panel.takes.some((t) => t.id === takeId)) throw notFound('Take');
    panel.selectedTakeId = takeId;
  });
  return board;
}

export async function removePanelTake(id, panelId, takeId) {
  const { board } = await mutateStoryboard(id, (draft) => {
    const { panel } = findPanel(draft, panelId);
    if (!panel.takes.some((t) => t.id === takeId)) throw notFound('Take');
    panel.takes = panel.takes.filter((t) => t.id !== takeId);
    if (panel.selectedTakeId === takeId) panel.selectedTakeId = panel.takes.at(-1)?.id ?? null;
  });
  return board;
}
