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
import { QUEUEABLE_IMAGE_MODES } from '../../lib/generationModes.js';
import { isNonBlankStr } from '../../lib/textUtils.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import * as store from './db.js';

export const MOOD_BOARD_RENDER_TAG = 'moodBoardRender';
const RENDER_SIZE = Object.freeze({ width: 1024, height: 1024 });
const PROMPT_MAX = 8000;

// Overridable for tests (queue, settings and socket are process singletons).
const deps = {
  getSettings: async () => (await import('../settings.js')).getSettings(),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  getJob: async (jobId) => (await import('../mediaJobQueue/index.js')).getJob(jobId),
  imageParams: (settings, route, common) => itemRenderParams(settings, route, common),
  emit: (payload) => import('../socket.js')
    .then(({ getIo }) => getIo()?.emit('mood-board:item-render', payload))
    .catch((err) => console.error(`❌ mood-board item-render emit failed: ${err.message}`)),
};
export const __setDepsForTests = (overrides) => Object.assign(deps, overrides);

/** The image prompt for a note: its words, then the board's composed look. */
function buildItemRenderPrompt(board, item) {
  const text = String(item?.text || '').trim();
  const style = isNonBlankStr(board?.style?.prompt) ? board.style.prompt.trim() : '';
  const subject = `Mood board reference image: ${text}`;
  return (style ? `${subject}\n\nVisual style: ${style}` : subject).slice(0, PROMPT_MAX);
}

/** Job params for the chosen backend: a cloud provider bag, or the local model. */
async function itemRenderParams(settings, { mode = null, model = null, target = null }, common) {
  const [{ resolveRenderTargetConfig }, { resolveImageCleaners }, { resolveLocalImageModel }] = await Promise.all([
    import('../imageGen/cloudProviderConfig.js'),
    import('../imageGen/index.js'),
    import('../imageGen/prepareParams.js'),
  ]);
  const resolved = resolveRenderTargetConfig(settings, target, { mode, model, usableInstallFallback: true });
  if ((mode && resolved.mode !== mode) || !QUEUEABLE_IMAGE_MODES.includes(resolved.mode)) {
    throw new ServerError(`The ${mode || resolved.mode} image backend cannot render board notes`, {
      status: 409, code: 'MOOD_BOARD_RENDER_UNAVAILABLE',
    });
  }
  if (resolved.cloud && !resolved.cloud.enabled) throw resolved.cloud.disabledError;
  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, resolved.mode);
  if (resolved.cloud) return { ...resolved.cloud.jobParams, ...common, cleanC2PA, denoise };
  const { pythonPath, selectedModel } = resolveLocalImageModel(settings, { modelId: model || undefined });
  return { ...common, cleanC2PA, denoise, pythonPath, ...(selectedModel?.id ? { modelId: selectedModel.id } : {}) };
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
  const priorJobId = board.items?.find((it) => it?.id === itemId)?.render?.jobId;
  const priorLive = priorJobId ? isLiveStatus(await deps.getJob(priorJobId)) : false;
  // A job id this request never saw (a concurrent render settled it after the
  // read above) counts as live, so the lock can't let a duplicate through.
  const claimed = await store.claimBoardItemRender(boardId, itemId, {
    isLive: (jobId) => jobId !== priorJobId || priorLive,
  });

  const prompt = buildItemRenderPrompt(board, claimed);
  const negativePrompt = isNonBlankStr(board.style?.negativePrompt) ? board.style.negativePrompt.trim() : undefined;
  let jobId;
  try {
    const settings = await deps.getSettings();
    const params = await deps.imageParams(settings, route, {
      prompt,
      ...(negativePrompt ? { negativePrompt } : {}),
      ...RENDER_SIZE,
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
