/** Machine-local, durable shot-planning checkpoints. Never restart provider work at boot. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getLoom, findEpisode } from './records.js';
import { runEpisodeShotAutopilot } from './shots.js';
import { fableLoomRunEvents } from './runEvents.js';

const active = new Map();
const queue = createFileWriteQueue();
const keyFor = (loomId, episodeId) => createHash('sha256').update(JSON.stringify([loomId, episodeId])).digest('hex');
const directory = () => join(PATHS.data, 'fableloom-shot-runs');
const pathFor = (key) => join(directory(), `${key}.json`);
const now = () => new Date().toISOString();
const snapshot = (run) => {
  if (!run) return null;
  const { checkpoint, ...publicRun } = run;
  return structuredClone({ ...publicRun, progress: {
    current: checkpoint.current || null,
    completedScenes: Object.values(checkpoint.scenes || {}).filter(scene => scene.group).length,
    rounds: Object.entries(checkpoint.scenes || {}).map(([sceneId, scene]) => ({ sceneId, rounds: scene.rounds.length, completed: !!scene.group })),
  } });
};
const publish = async (run) => {
  run.updatedAt = now();
  run.revision += 1;
  await ensureDir(directory());
  await atomicWrite(pathFor(keyFor(run.loomId, run.episodeId)), run);
  fableLoomRunEvents.emit('shots', snapshot(run));
  return snapshot(run);
};
const read = async (key) => JSON.parse(await readFile(pathFor(key), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return 'null';
  throw error;
}));
const requireEpisode = async (loomId, episodeId) => {
  const loom = await getLoom(loomId);
  if (!loom) throw new ServerError('Story not found', { status: 404 });
  return findEpisode(loom, episodeId);
};
async function load(loomId, episodeId) {
  const key = keyFor(loomId, episodeId);
  const run = active.get(key) || await read(key);
  if (run && !active.has(key) && ['running', 'canceling'].includes(run.status)) {
    run.status = 'failed';
    run.message = 'Shot planning was interrupted by a restart. Completed steps are preserved; resume explicitly.';
    await publish(run);
  }
  return run;
}
export async function getEpisodeShotRun(loomId, episodeId) {
  await requireEpisode(loomId, episodeId);
  return queue(async () => snapshot(await load(loomId, episodeId)));
}
async function execute(run) {
  const key = keyFor(run.loomId, run.episodeId);
  await runEpisodeShotAutopilot(run.loomId, run.episodeId, {
    ...run.options,
    checkpoint: run.checkpoint,
    isCanceled: () => run.cancelRequested,
    saveCheckpoint: () => queue(async () => {
      run.message = `${run.checkpoint.current?.stage || 'Planning shots'} · round ${run.checkpoint.current?.round || 1}${run.checkpoint.current?.warning ? ` · ${run.checkpoint.current.warning}` : ''}`;
      await publish(run);
    }),
  }).then(result => queue(async () => {
    run.status = 'completed';
    run.result = result;
    run.message = 'Shot plan completed.';
    await publish(run);
  })).catch(error => queue(async () => {
    run.status = run.cancelRequested ? 'canceled' : 'failed';
    run.message = error.message;
    await publish(run);
  })).finally(() => active.delete(key));
}
export async function startEpisodeShotRun(loomId, episodeId, { resume = false, ...options } = {}) {
  const episode = await requireEpisode(loomId, episodeId);
  if (!episode.nodes.length) throw new ServerError('Write dramatic scenes before planning shots.', { status: 409 });
  return queue(async () => {
    const key = keyFor(loomId, episodeId);
    if (active.has(key)) return { ...snapshot(active.get(key)), alreadyRunning: true };
    const previous = resume ? await load(loomId, episodeId) : null;
    if (resume && !previous) throw new ServerError('No shot run to resume.', { status: 404 });
    if (previous?.status === 'completed') return snapshot(previous);
    const run = previous || { id: `shots-${randomUUID()}`, loomId, episodeId, createdAt: now(), revision: 0, attempt: 0, options, checkpoint: {} };
    // Resume retains the original provider, guidance and apply choice.
    run.attempt += 1;
    run.status = 'running';
    run.cancelRequested = false;
    run.message = resume ? 'Resuming shot planning…' : 'Starting shot planning…';
    await publish(run);
    active.set(key, run);
    void execute(run).catch(error => {
      console.error(`❌ Shot run persistence failed: ${error.message}`);
      run.status = 'failed';
      run.message = 'Could not persist the shot run. Previously saved steps remain available for recovery.';
      run.revision += 1;
      fableLoomRunEvents.emit('shots', snapshot(run));
    });
    return snapshot(run);
  });
}
export async function cancelEpisodeShotRun(loomId, episodeId) {
  await requireEpisode(loomId, episodeId);
  return queue(async () => {
    const run = await load(loomId, episodeId);
    if (!run) throw new ServerError('No shot run found.', { status: 404 });
    if (run.status === 'running') {
      run.cancelRequested = true;
      run.status = 'canceling';
      run.message = 'Stopping after the active provider call; completed steps will be preserved.';
      await publish(run);
    }
    return snapshot(run);
  });
}

/** Compatibility callers still await a plan, but do not own the worker's lifetime. */
export async function planEpisodeShotRun(loomId, episodeId, options = {}) {
  let runId;
  let resolveResult, rejectResult;
  const earlyTerminals = new Map();
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const accept = run => {
    if (run.loomId !== loomId || run.episodeId !== episodeId || !['completed', 'failed', 'canceled'].includes(run.status)) return;
    if (!runId) { earlyTerminals.set(run.id, run); return; }
    if (run.id !== runId) return;
    if (run.status === 'completed') resolveResult(run.result);
    else rejectResult(new ServerError(run.message, { status: 422, code: 'SHOT_RUN_FAILED' }));
  };
  // Subscribe before start, including an instant completion or an already-active run.
  fableLoomRunEvents.on('shots', accept);
  return startEpisodeShotRun(loomId, episodeId, options).then(run => {
    runId = run.id;
    accept(earlyTerminals.get(runId) || run);
    return result;
  }).finally(() => fableLoomRunEvents.off('shots', accept));
}
