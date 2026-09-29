/**
 * Board-level "analyze pins" job.
 *
 * Runs prompt-from-media over every pin that has no prompt yet, then composes
 * the board style — on the SERVER, so navigating away from the board page (or
 * closing the tab) doesn't abandon a long vision run. The page reads the live
 * state from `getAnalyzeJob` on mount and follows `mood-board:analyze` events.
 *
 * One job per board, kept in memory only: a run is a user-triggered, minutes
 * long operation, and the finished per-item analyses are persisted on the board
 * itself. The last terminal state is retained until the next run so a page that
 * reopens right after completion can still report the outcome.
 */

import { isNonBlankStr as hasText } from '../../lib/textUtils.js';
import { promptFromMedia } from '../mediaPromptFromMedia.js';
import { composeBoardPrompt } from '../moodBoardCompositeStyle.js';
import { boardItemLocalImage } from './logic.js';
import { getBoard, updateBoard, updateBoardItem, backfillGalleryPrompts } from './index.js';

const jobs = new Map();

function itemHasPrompt(item) {
  if (hasText(item?.analysis?.prompt) || hasText(item?.prompt)) return true;
  const galleryKey = typeof item?.mediaKey === 'string' && /^(image|video):/.test(item.mediaKey);
  return galleryKey && hasText(item?.caption);
}

// `{ kind, filename }` for an item prompt-from-media can read, else null.
function analysisSource(item) {
  if (item?.type === 'video') {
    const key = item.mediaKey;
    const filename = typeof key === 'string' && key.startsWith('video:') ? key.slice('video:'.length) : '';
    return filename ? { kind: 'video', filename } : null;
  }
  const local = boardItemLocalImage(item);
  return local ? { kind: 'image', filename: local.filename } : null;
}

function analysisFromResult(item, result) {
  if (!result) return null;
  const preferVideo = item?.type === 'video';
  const primary = preferVideo ? result.videoPrompt : result.imagePrompt;
  const fallback = preferVideo ? result.imagePrompt : result.videoPrompt;
  const usedPrimary = hasText(primary);
  const prompt = usedPrimary ? primary : fallback;
  if (!hasText(prompt)) return null;
  const negative = usedPrimary
    ? (preferVideo ? result.videoNegativePrompt : result.imageNegativePrompt)
    : (preferVideo ? result.imageNegativePrompt : result.videoNegativePrompt);
  return {
    prompt,
    negativePrompt: negative || null,
    rationale: result.rationale || null,
    providerId: result.providerId || null,
    model: result.model || null,
  };
}

function pendingItems(board) {
  return (Array.isArray(board?.items) ? board.items : [])
    .filter((it) => (it?.type === 'image' || it?.type === 'video') && !itemHasPrompt(it) && analysisSource(it));
}

function publish(job) {
  import('../socket.js')
    .then(({ getIo }) => getIo()?.emit('mood-board:analyze', { ...job }))
    .catch((err) => console.error(`❌ mood-board analyze emit failed: ${err.message}`));
}

function update(job, patch) {
  Object.assign(job, patch);
  publish(job);
}

async function run(job, { providerId, model, effort }) {
  const { boardId } = job;
  const filled = await backfillGalleryPrompts(boardId);
  if (!filled) throw new Error('Mood board not found');
  const pending = pendingItems(filled);
  update(job, { phase: 'analyzing', total: pending.length, done: 0 });

  let failures = 0;
  for (const item of pending) {
    const source = analysisSource(item);
    const data = await promptFromMedia({
      sourceKind: source.kind,
      filename: source.filename,
      targets: source.kind === 'video' ? ['image', 'video'] : ['image'],
      providerId,
      model,
      effort,
    }).catch((err) => {
      console.warn(`⚠️ mood-board ${boardId} item ${item.id} analysis failed: ${err.message}`);
      return null;
    });
    const analysis = analysisFromResult(item, data);
    const saved = analysis
      ? await updateBoardItem(boardId, item.id, { analysis }).catch(() => null)
      : null;
    if (!saved) failures += 1;
    update(job, { done: job.done + 1, failures });
  }

  const board = await getBoard(boardId);
  const analyzedCount = (board?.items || []).filter(itemHasPrompt).length;
  if (analyzedCount < 1) {
    update(job, { status: 'failed', phase: null, error: 'No item could be analyzed, so the board style was not composed', finishedAt: new Date().toISOString() });
    return;
  }
  update(job, { phase: 'composing' });
  const style = await composeBoardPrompt({ board, providerId, model, effort });
  await updateBoard(boardId, { style });
  update(job, { status: 'done', phase: null, finishedAt: new Date().toISOString() });
}

export function getAnalyzeJob(boardId) {
  const job = jobs.get(boardId);
  return job ? { ...job } : null;
}

/** Start (or join, when one is already running) the analyze job for a board. */
export function startAnalyzeJob(boardId, { providerId, model, effort } = {}) {
  const existing = jobs.get(boardId);
  if (existing?.status === 'running') return { ...existing };
  const job = {
    boardId,
    status: 'running',
    phase: 'preparing',
    total: 0,
    done: 0,
    failures: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(boardId, job);
  publish(job);
  run(job, { providerId, model, effort }).catch((err) => {
    console.error(`❌ mood-board ${boardId} analyze failed: ${err.message}`);
    update(job, { status: 'failed', phase: null, error: err.message, finishedAt: new Date().toISOString() });
  });
  return { ...job };
}
