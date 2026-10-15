import { performance } from 'node:perf_hooks';
import { CARDINALITIES } from './collectionFixtureData.js';
import { SEED_BATCH_SIZE } from './collectionFixtureSeed.js';

const phases = ['source-copy', 'parent-database', 'imports', 'database', 'image-seed', 'video-seed', 'inbox-seed', 'routes', 'ready'];
const limits = { images: CARDINALITIES.images, videos: CARDINALITIES.videos,
  accounts: CARDINALITIES.accounts, messages: CARDINALITIES.messages };

/** Only fixed stages and bounded aggregates cross the worker/report boundary. */
export function createFixtureStartup({ overallTimeoutMs = 30000, noProgressTimeoutMs = 10000 } = {}) {
  if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 100 || overallTimeoutMs > 120000
      || !Number.isInteger(noProgressTimeoutMs) || noProgressTimeoutMs < 100
      || noProgressTimeoutMs > overallTimeoutMs) throw new Error('Invalid collection fixture startup limits');
  const started = performance.now();
  let workerStarted;
  const samples = [];
  let phaseIndex = -1;
  let counts = { images: 0, videos: 0, accounts: 0, messages: 0 };
  let workMs = { files: 0, index: 0 };
  const record = message => {
    const nextPhase = phases.indexOf(message?.phase);
    if (nextPhase < phaseIndex || nextPhase < 0) return false;
    const nextCounts = {};
    for (const [key, max] of Object.entries(limits)) {
      const value = message.counts?.[key] ?? counts[key];
      if (!Number.isInteger(value) || value < counts[key] || value > max) return false;
      nextCounts[key] = value;
    }
    // Repeated heartbeats cannot keep a stuck worker alive.
    if (nextPhase === phaseIndex && Object.keys(limits).every(key => nextCounts[key] === counts[key])) return false;
    const nextWork = {};
    for (const key of ['files', 'index']) {
      const value = message.workMs?.[key] ?? workMs[key];
      if (!Number.isFinite(value) || value < workMs[key] || value > 120000 * SEED_BATCH_SIZE) return false;
      nextWork[key] = Math.round(value);
    }
    phaseIndex = nextPhase;
    counts = nextCounts;
    workMs = nextWork;
    const elapsedMs = Math.round(performance.now() - started);
    const samePhase = samples.at(-1)?.phase === phases[phaseIndex];
    if (samples.length && !samePhase) {
      samples.at(-1).durationMs = elapsedMs - samples.at(-1).startedMs;
    }
    const startedMs = samePhase ? samples.at(-1).startedMs : elapsedMs;
    const sample = { phase: phases[phaseIndex], startedMs, elapsedMs,
      durationMs: elapsedMs - startedMs, counts, workMs };
    // One latest aggregate per phase bounds report size even for noisy IPC.
    if (samples.at(-1)?.phase === sample.phase) samples[samples.length - 1] = sample;
    else samples.push(sample);
    return true;
  };
  const snapshot = () => {
    const elapsedMs = Math.round(performance.now() - started);
    return { overallTimeoutMs, noProgressTimeoutMs, elapsedMs,
      workerElapsedMs: workerStarted === undefined ? null : Math.round(performance.now() - workerStarted),
      phases: samples.map((sample, index) => ({ ...sample,
        durationMs: index === samples.length - 1 ? elapsedMs - sample.startedMs : sample.durationMs,
        counts: { ...sample.counts }, workMs: { ...sample.workMs } })) };
  };
  const failure = reason => Object.assign(new Error('Collection fixture ' + reason), {
    fixtureFailure: reason, fixtureStartup: snapshot(),
  });
  const wait = child => new Promise((resolveReady, rejectReady) => {
    workerStarted = performance.now();
    let idleTimer;
    const finish = (error, value) => {
      clearTimeout(overallTimer);
      clearTimeout(idleTimer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('message', onMessage);
      error ? rejectReady(error) : resolveReady(value);
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(failure('startup-stalled')), noProgressTimeoutMs);
    };
    const onError = () => finish(failure('child-start-failed'));
    const onExit = () => finish(failure('child-exited'));
    const onMessage = message => {
      if (message?.type === 'progress' && record(message)) armIdle();
      if (message?.type === 'failed') finish(failure('initialization-failed'));
      if (message?.type === 'ready') {
        record({ phase: 'ready' });
        finish(null, message);
      }
    };
    const overallTimer = setTimeout(() => finish(failure('startup-timeout')), overallTimeoutMs);
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
    armIdle();
  });
  return { record, snapshot, wait };
}
