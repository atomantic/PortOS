/**
 * Loops Service
 *
 * Manages recurring AI CLI loops — the web equivalent of Claude Code's `/loop`.
 * Each loop spawns a headless AI run on a configurable interval via portos-ai-toolkit,
 * so any configured provider (Claude, Gemini, Codex, etc.) can power loops.
 * Output streams in real-time via EventEmitter → Socket.IO.
 */

import { EventEmitter } from 'events';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { randomUUID } from 'crypto';
import { createRun, executeCliRun } from './runner.js';
import { getProviderById, getAllProviders, getActiveProvider } from './providers.js';

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

  let provider;
  if (loop.providerId) {
    provider = await getProviderById(loop.providerId).catch(() => null);
  }
  if (!provider) {
    provider = await getActiveProvider().catch(() => null);
  }
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
      model: provider.defaultModel,
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

  executeCliRun(
    runResult.metadata.id,
    runResult.provider,
    loop.prompt,
    loop.cwd || PATHS.root,
    onData,
    onComplete,
    loop.timeout || DEFAULT_TIMEOUT_MS
  ).catch(err => {
    active.running = false;
    active.runId = null;
    loopEvents.emit('iteration:error', { id, iteration: iterationNum, error: err.message, timestamp: Date.now() });
    console.error(`❌ Loop ${id} executeCliRun failed: ${err.message}`);
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
  const timer = setInterval(() => executeIteration(loop), loop.intervalMs);
  activeLoops.set(loop.id, {
    timer,
    runId: null,
    running: false,
    iterationCount: loop.iterationCount || 0,
    lastResult: null,
    history: []
  });

  if (runImmediately) {
    setTimeout(() => executeIteration(loop), 100);
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

  executeIteration(loop);
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
    active.timer = setInterval(() => executeIteration(loops[idx]), loops[idx].intervalMs);
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
