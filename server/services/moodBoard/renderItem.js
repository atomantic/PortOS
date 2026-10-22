/**
 * Render a mood board text note into an image (#10531).
 *
 * A board built from words alone (the autonomous Music Video brief writes one)
 * shows nothing visual. This queues an image job for a text note — the note's
 * words plus the board's composed style — and the completion hook
 * (moodBoardItemRenderHook.js) turns the note into an image item in place.
 *
 * The backend is the caller's pin when given, else the render target's saved
 * default, else the install's default image backend. Only queueable backends
 * (local + the cloud lanes) apply: the completion hook rides the media queue.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr } from '../../lib/textUtils.js';
import { promptAddition } from '../../lib/modelInput.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { queueableImageParams } from '../imageGen/queueableParams.js';
import * as store from './db.js';

export const MOOD_BOARD_RENDER_TAG = 'moodBoardRender';
const RENDER_SIZE = Object.freeze({ width: 1024, height: 1024 });

// Overridable for tests (queue, settings and socket are process singletons).
const deps = {
  getSettings: async () => (await import('../settings.js')).getSettings(),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  getJob: async (jobId) => (await import('../mediaJobQueue/index.js')).getJob(jobId),
  imageParams: (settings, route, common) => queueableImageParams(settings, route, common, {
    what: 'board notes', code: 'MOOD_BOARD_RENDER_UNAVAILABLE',
  }),
  emit: (payload) => import('../socket.js')
    .then(({ getIo }) => getIo()?.emit('mood-board:item-render', payload))
    .catch((err) => console.error(`❌ mood-board item-render emit failed: ${err.message}`)),
};
export const __setDepsForTests = (overrides) => Object.assign(deps, overrides);

/**
 * The image prompt for a note: its words, then the board's composed look, sent
 * whole, with each block PortOS adds listed as a labeled addition (#11317).
 */
function buildItemRenderPrompt(board, item) {
  const text = String(item?.text || '').trim();
  const style = isNonBlankStr(board?.style?.prompt) ? board.style.prompt.trim() : '';
  const subject = `Mood board reference image: ${text}`;
  return {
    prompt: style ? `${subject}\n\nVisual style: ${style}` : subject,
    promptAdditions: [
      promptAddition('mood-board-note', 'Mood board reference', 'Mood board reference image: [note]'),
      promptAddition('board-style', 'Board style', style && `Visual style: ${style}`),
    ].filter(Boolean),
  };
}

// Also used before prompt writing, so a disabled renderer never spends an LLM run.
export async function prepareBoardRenderParams(route, common = {}) {
  return deps.imageParams(await deps.getSettings(), route, common);
}

function announce(boardId, itemId, status, error = null) {
  emitRecordUpdated('moodBoard', boardId);
  deps.emit({ boardId, itemId, status, ...(error ? { error } : {}) });
}

const isLiveStatus = (job) => job?.status === 'queued' || job?.status === 'running';

/**
 * Queue a render for one text note. Resolves to `{ item, jobId }` with the
 * note's queued render state. Throws NOT_FOUND / MOOD_BOARD_ITEM_NOT_TEXT /
 * MOOD_BOARD_RENDER_BUSY / MOOD_BOARD_RENDER_UNAVAILABLE.
 *
 * @param {string} boardId
 * @param {string} itemId
 * @param {{ mode?: string, model?: string, target?: string }} [route]
 */
export async function renderBoardItem(boardId, itemId, route = {}) {
  const board = await store.getBoard(boardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  const previous = board.items?.find((it) => it?.id === itemId)?.render;
  route = { ...previous?.options, ...route };
  const priorJobId = previous?.jobId;
  const priorLive = priorJobId ? isLiveStatus(await deps.getJob(priorJobId)) : false;
  // A job id this request never saw (a concurrent render settled it after the
  // read above) counts as live, so the lock can't let a duplicate through.
  const claimed = await store.claimBoardItemRender(boardId, itemId, {
    isLive: (jobId) => jobId !== priorJobId || priorLive,
    options: route,
  });

  const { prompt, promptAdditions } = buildItemRenderPrompt(board, claimed);
  const negativePrompt = isNonBlankStr(board.style?.negativePrompt) ? board.style.negativePrompt.trim() : undefined;
  let jobId;
  try {
    const params = await prepareBoardRenderParams(route, {
      prompt,
      promptAdditions: [...promptAdditions, promptAddition('board-negative', 'Board avoid (negative prompt)', negativePrompt)].filter(Boolean),
      ...(negativePrompt ? { negativePrompt } : {}),
      width: route.width ?? RENDER_SIZE.width,
      height: route.height ?? RENDER_SIZE.height,
      [MOOD_BOARD_RENDER_TAG]: { boardId, itemId },
    });
    ({ jobId } = await deps.enqueue({ kind: 'image', params, owner: `mood-board-render:${boardId}` }));
    if (!jobId) throw new Error('The image job was not queued');
  } catch (err) {
    // A refused render never strands the note in "rendering".
    await store.settleBoardItemRender(boardId, itemId, { jobId: null, status: 'failed', error: err.message.slice(0, 500) });
    announce(boardId, itemId, 'failed', err.message);
    throw err;
  }
  const item = await store.settleBoardItemRender(boardId, itemId, { jobId, status: 'queued' });
  announce(boardId, itemId, 'queued');
  console.log(`🖼️ Mood board ${boardId.slice(0, 11)} note ${itemId.slice(0, 12)} → image job ${String(jobId).slice(0, 8)}`);
  return { item: item || claimed, jobId };
}

/** Completion: turn the note into the rendered image. Null when the job was stale. */
export async function attachRenderedItem({ boardId, itemId, jobId, filename, prompt }) {
  const item = await store.applyBoardItemRender(boardId, itemId, { jobId, filename, prompt });
  if (item) announce(boardId, itemId, 'done');
  return item;
}

/** A failed or canceled job puts the note back to text with the reason. */
export async function failRenderedItem({ boardId, itemId, jobId }, status, error) {
  const reason = status === 'canceled' ? 'The render was canceled' : (error || 'The render failed');
  const item = await store.settleBoardItemRender(boardId, itemId, { jobId, status: 'failed', error: String(reason).slice(0, 500) });
  if (item) announce(boardId, itemId, 'failed', reason);
  return item;
}
