/**
 * Loops Service
 *
 * Manages recurring AI CLI loops — the web equivalent of Claude Code's `/loop`.
 * Each loop spawns a headless AI run on a configurable interval via the in-tree aiToolkit,
 * so any configured provider (Claude, Gemini, Codex, etc.) can power loops.
 * Output streams in real-time via EventEmitter → Socket.IO.
 */

import { EventEmitter } from 'events';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { randomUUID } from 'crypto';
import { createRun } from './runner.js';
import { resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';
import { getAllProviders, getActiveProvider } from './providers.js';

export const loopEvents = new EventEmitter();

const LOOPS_FILE = join(PATHS.data, 'loops.json');
const LOOPS_OUTPUT_DIR = join(PATHS.data, 'loops');
const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_INTERVAL_MS = 10_000;

const activeLoops = new Map();

function parseInterval(str) {
  const match = String(str).match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|ms)?$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(val * (multipliers[unit] || 60_000));
}

function formatInterval(ms) {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

async function loadLoops() {
  const raw = await readFile(LOOPS_FILE, 'utf-8').catch(() => '[]');
  return JSON.parse(raw);
}

async function saveLoops(loops) {
  await writeFile(LOOPS_FILE, JSON.stringify(loops, null, 2));
}

async function executeIteration(loop) {
  const id = loop.id;
  const active = activeLoops.get(id);
  if (!active || active.running) return;

  active.running = true;
  active.iterationCount++;
  const iterationNum = active.iterationCount;

  loopEvents.emit('iteration:start', { id, iteration: iterationNum, timestamp: Date.now() });

  const { provider } = await resolveProviderAndModel({ providerId: loop.providerId })
    .catch(() => ({ provider: null }));
  if (!provider) {
    const msg = 'No AI provider available';
    loopEvents.emit('iteration:error', { id, iteration: iterationNum, error: msg, timestamp: Date.now() });
    active.running = false;
    console.error(`❌ Loop ${id}: ${msg}`);
    return;
  }

  const outputLines = [];

  const onData = (text) => {
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      outputLines.push(line);
      loopEvents.emit('output', { id, iteration: iterationNum, line, timestamp: Date.now() });
    }
  };

  const onComplete = async (metadata) => {
    const result = outputLines.join('\n');
    const iterResult = {
      iteration: iterationNum,
      exitCode: metadata.exitCode,
      success: metadata.success,
      output: result,
      lineCount: outputLines.length,
      duration: metadata.duration,
      provider: provider.name,
      // The model the central handler actually ran (set by the .then below
      // when the run resolved), with provider.defaultModel as the fallback
      // for the failure path where executedModel is still null.
      model: metadata.model || provider.defaultModel,
      timestamp: Date.now()
    };

    active.lastResult = iterResult;
    active.history.push({
      iteration: iterationNum,
      exitCode: metadata.exitCode,
      success: metadata.success,
      summary: result.slice(0, 500),
      duration: metadata.duration,
      provider: provider.name,
      timestamp: Date.now()
    });
    if (active.history.length > 50) active.history.shift();

    active.running = false;
    active.runId = null;

    loopEvents.emit('iteration:complete', { id, ...iterResult });

    const outputPath = join(LOOPS_OUTPUT_DIR, `${id}-${iterationNum}.txt`);
    await writeFile(outputPath, result).catch(() => {});

    await updatePersistedLoop(id, {
      lastRun: Date.now(),
      iterationCount: active.iterationCount,
      lastExitCode: metadata.exitCode
    });

    console.log(`🔄 Loop ${id} iteration ${iterationNum} complete (${provider.name}, exit ${metadata.exitCode}, ${outputLines.length} lines)`);
  };

  // Pre-create the run so `active.runId` can be set before generation
  // starts (cancellation needs the id). The central handler reuses our
  // runId when provided rather than creating a second one.
  const runResult = await createRun({
    providerId: provider.id,
    prompt: loop.prompt,
    workspacePath: loop.cwd || PATHS.root,
    source: 'loop',
    sourceId: id,
    label: `Loop: ${loop.name} #${iterationNum}`
  }).catch(err => {
    active.running = false;
    loopEvents.emit('iteration:error', { id, iteration: iterationNum, error: err.message, timestamp: Date.now() });
    console.error(`❌ Loop ${id} createRun failed: ${err.message}`);
    return null;
  });

  if (!runResult) return;

  active.runId = runResult.metadata.id;

  // The toolkit's createRun may switch to a fallback provider when the
  // requested one is marked unavailable (providerStatusService). Reassign
  // `provider` to the effective one so dispatch, onComplete's
  // history/persistence side, and the `iteration:complete` event all see
  // the provider that actually ran. Without this, fallback would only
  // update the run record while the spawn still hit the dead provider.
  if (runResult.provider && runResult.provider.id !== provider.id) {
    provider = runResult.provider;
  }

  // Adapt the central handler's resolve/reject to the legacy onComplete
  // metadata shape. We can't get the runner's full metadata back from
  // runPromptThroughProvider today — it only resolves `{ text, runId,
  // model }`. Reconstruct the bits onComplete inspects (exitCode + success
  // + duration) from the promise resolution; pass through `model` so
  // iterResult records what actually ran (not just the saved default).
  const startedAt = Date.now();
  runPromptThroughProvider({
    provider, prompt: loop.prompt, source: 'loop', runId: runResult.metadata.id,
    onData, timeout: loop.timeout || DEFAULT_TIMEOUT_MS,
    // loop.cwd is a user-facing setting on each loop record — without this
    // pass-through, every loop runs against PortOS's own cwd instead of
    // the directory the user picked.
    cwd: loop.cwd || PATHS.root,
  }).then(({ model: executedModel }) => {
    // Wrap `onComplete` so a throw inside the success branch doesn't fall
    // through to the chained `.catch` below and get misclassified as
    // `iteration:error`. History/persistence side is best-effort anyway.
    return Promise.resolve()
      .then(() => onComplete({ exitCode: 0, success: true, duration: Date.now() - startedAt, model: executedModel }))
      .catch((err) => {
        console.error(`❌ Loop ${id} onComplete (success branch) threw: ${err?.message || err}`);
      });
  }).catch(err => {
    // Pre-migration `executeCliRun` always invoked `onComplete` — even on
    // non-zero exit — so loop history / persistence / `iteration:complete`
    // observers saw failed runs too. The .then/.catch split here would
    // skip onComplete on failure and only emit `iteration:error`, breaking
    // anything that subscribed to completes (history.push, lastExitCode
    // persistence). Fire onComplete with a failure shape before the error
    // event so the history + persistence side stays consistent.
    const failureMetadata = {
      exitCode: 1,
      success: false,
      duration: Date.now() - startedAt,
      error: err.message,
      model: provider.defaultModel,
    };
    onComplete(failureMetadata).catch(() => { /* history write is best-effort */ });
    loopEvents.emit('iteration:error', { id, iteration: iterationNum, error: err.message, timestamp: Date.now() });
    console.error(`❌ Loop ${id} run failed: ${err.message}`);
  });
}

async function updatePersistedLoop(id, updates) {
  const loops = await loadLoops();
  const idx = loops.findIndex(l => l.id === id);
  if (idx >= 0) {
    Object.assign(loops[idx], updates);
    await saveLoops(loops);
  }
}

export async function createLoop({ prompt, interval, name, cwd, providerId, timeout, runImmediately = true }) {
  const intervalMs = typeof interval === 'number' ? interval : parseInterval(interval);
  if (!intervalMs || intervalMs < MIN_INTERVAL_MS) {
    throw new Error('Interval must be at least 10 seconds');
  }
  if (!prompt?.trim()) {
    throw new Error('Prompt is required');
  }

  await ensureDir(LOOPS_OUTPUT_DIR);

  const id = randomUUID().slice(0, 8);
  const loop = {
    id,
    name: name || prompt.slice(0, 60),
    prompt: prompt.trim(),
    intervalMs,
    cwd: cwd || null,
    providerId: providerId || null,
    timeout: timeout || null,
    status: 'running',
    createdAt: Date.now(),
    lastRun: null,
    iterationCount: 0,
    lastExitCode: null
  };

  const loops = await loadLoops();
  loops.push(loop);
  await saveLoops(loops);

  startLoopTimer(loop, runImmediately);

  loopEvents.emit('created', { loop });
  console.log(`🔄 Loop ${id} created: "${loop.name}" every ${formatInterval(intervalMs)}`);

  return loop;
}

function startLoopTimer(loop, runImmediately = false) {
  const runWithLogging = () => executeIteration(loop).catch(err => {
    console.error(`❌ [loops] iteration error for loop ${loop.id}: ${err?.stack || err?.message || String(err)}`);
  });
  const timer = setInterval(runWithLogging, loop.intervalMs);
  activeLoops.set(loop.id, {
    timer,
    runId: null,
    running: false,
    iterationCount: loop.iterationCount || 0,
    lastResult: null,
    history: []
  });

  if (runImmediately) {
    setTimeout(runWithLogging, 100);
  }
}

export async function stopLoop(id) {
  const active = activeLoops.get(id);
  if (!active) throw new Error(`Loop ${id} is not running`);

  clearInterval(active.timer);
  activeLoops.delete(id);

  const loops = await loadLoops();
  const idx = loops.findIndex(l => l.id === id);
  if (idx >= 0) {
    loops[idx].status = 'stopped';
    loops[idx].stoppedAt = Date.now();
    await saveLoops(loops);
  }

  loopEvents.emit('stopped', { id });
  console.log(`⏹️ Loop ${id} stopped`);
}

export async function resumeLoop(id) {
  if (activeLoops.has(id)) throw new Error(`Loop ${id} is already running`);

  const loops = await loadLoops();
  const loop = loops.find(l => l.id === id);
  if (!loop) throw new Error(`Loop ${id} not found`);

  loop.status = 'running';
  loop.stoppedAt = null;
  await saveLoops(loops);

  await ensureDir(LOOPS_OUTPUT_DIR);
  startLoopTimer(loop, true);

  loopEvents.emit('resumed', { id });
  console.log(`▶️ Loop ${id} resumed`);
  return loop;
}

export async function deleteLoop(id) {
  if (activeLoops.has(id)) {
    const active = activeLoops.get(id);
    clearInterval(active.timer);
    activeLoops.delete(id);
  }

  const loops = await loadLoops();
  const filtered = loops.filter(l => l.id !== id);
  await saveLoops(filtered);

  loopEvents.emit('deleted', { id });
  console.log(`🗑️ Loop ${id} deleted`);
}

export async function getLoops() {
  const loops = await loadLoops();
  return loops.map(loop => {
    const active = activeLoops.get(loop.id);
    return {
      ...loop,
      isRunning: !!active,
      isExecuting: active?.running || false,
      currentIteration: active?.iterationCount || loop.iterationCount || 0,
      lastResult: active?.lastResult || null,
      history: active?.history || []
    };
  });
}

export async function getLoop(id) {
  const loops = await getLoops();
  return loops.find(l => l.id === id) || null;
}

export async function triggerLoop(id) {
  const loops = await loadLoops();
  const loop = loops.find(l => l.id === id);
  if (!loop) throw new Error(`Loop ${id} not found`);
  if (!activeLoops.has(id)) throw new Error(`Loop ${id} is not running`);

  executeIteration(loop).catch(err => {
    console.error(`❌ [loops] iteration error for loop ${loop.id}: ${err?.stack || err?.message || String(err)}`);
  });
  return { triggered: true };
}

export async function updateLoop(id, updates) {
  const loops = await loadLoops();
  const idx = loops.findIndex(l => l.id === id);
  if (idx < 0) throw new Error(`Loop ${id} not found`);

  const allowed = ['name', 'prompt', 'interval', 'cwd', 'providerId', 'timeout'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      if (key === 'interval') {
        const ms = typeof updates[key] === 'number' ? updates[key] : parseInterval(updates[key]);
        if (!ms || ms < MIN_INTERVAL_MS) throw new Error('Interval must be at least 10 seconds');
        loops[idx].intervalMs = ms;
      } else {
        loops[idx][key] = updates[key];
      }
    }
  }

  await saveLoops(loops);

  if (activeLoops.has(id) && updates.interval) {
    const active = activeLoops.get(id);
    clearInterval(active.timer);
    const updatedLoop = loops[idx];
    active.timer = setInterval(() => executeIteration(updatedLoop).catch(err => {
      console.error(`❌ [loops] iteration error for loop ${updatedLoop.id}: ${err?.stack || err?.message || String(err)}`);
    }), updatedLoop.intervalMs);
  }

  loopEvents.emit('updated', { loop: loops[idx] });
  return loops[idx];
}

export async function getAvailableProviders() {
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  const active = await getActiveProvider().catch(() => null);
  return {
    providers: providers.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type,
      command: p.command,
      defaultModel: p.defaultModel,
      isActive: active?.id === p.id
    })),
    activeProviderId: active?.id || null
  };
}

export async function restoreLoops() {
  await ensureDir(LOOPS_OUTPUT_DIR);
  const loops = await loadLoops();
  let restored = 0;
  for (const loop of loops) {
    if (loop.status === 'running') {
      startLoopTimer(loop, false);
      restored++;
    }
  }
  if (restored > 0) {
    console.log(`🔄 Restored ${restored} active loop(s)`);
  }
}
