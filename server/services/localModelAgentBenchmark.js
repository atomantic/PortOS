/**
 * User-triggered local-TUI agent-task checks for supported local runtimes.
 *
 * The ordinary assessment measures one direct generation at several context
 * lengths. That is the right instrument for decoder throughput, but it cannot
 * answer whether a CoS task actually completes through the OpenCode tool loop.
 * This service runs one bounded, disposable task through the configured
 * local TUI provider preset, then reports task completion and terminal-
 * inclusive elapsed time. Direct decoder speed remains the responsibility of
 * the measured assessment beside this check.
 *
 * The target is deliberately the real PTY-backed TUI path used by PortOS CoS
 * tasks. A separate headless OpenCode JSON stream is useful for parser tests and
 * lower-level diagnostics, but it is not a substitute for the primary harness
 * users asked to select.
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { isClaudeCommand, isOpencodeCommand, localRuntimeNamespace, parseOpencodeConfigContent } from '../lib/provider/providerModels.js';
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { LOCAL_TUI_AGENT_BENCHMARK_TARGETS } from '../lib/localAgentBenchmarkTargets.js';
import { buildOpencodeConfig } from '../lib/opencodeConfig.js';
// The stream parser is shared with the capability test suite: two independent
// parsers of the same OpenCode envelope is how the two end up reporting
// different tool-call counts for the same run.
import { summarizeOpenCodeEvents } from '../lib/opencodeStream.js';
import { claimHeavyLocalJob } from '../lib/heavyJobClaim.js';
import { getProviderById } from './provider/providers.js';
import { ensureProviderReadyForExecution } from './provider/providerExecutionReadiness.js';
import { executeTuiRun } from './tuiPromptRunner.js';
import { getRunsPath, stopRun } from './runner.js';
import { runOnMtplxCheckpoint } from './mtplxServerManager.js';

export const buildOpenCodeAgentBenchmarkPrompt = (benchmarkFilePath = 'PORTOS_AGENT_BENCHMARK.txt') => [
  'This is a disposable PortOS runtime benchmark. You must exercise the terminal tool loop.',
  `In the current scratch workspace, create a file named PORTOS_AGENT_BENCHMARK.txt at exactly this path: ${benchmarkFilePath}`,
  'whose entire contents are exactly PORTOS_AGENT_BENCHMARK_OK (with no extra newline if your tool permits).',
  'Read that file back with a terminal tool, verify the exact sentinel, and then reply with exactly',
  'PORTOS_AGENT_BENCHMARK_OK. Do not create or modify any other file.',
].join(' ');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
let activeBenchmark = null;

export function cancelOpenCodeAgentBenchmark() {
  if (!activeBenchmark) return { cancelled: false };
  activeBenchmark.abort();
  return { cancelled: true };
}

const targetFor = (backend, modelId) => {
  const target = Object.hasOwn(LOCAL_TUI_AGENT_BENCHMARK_TARGETS, backend) && LOCAL_TUI_AGENT_BENCHMARK_TARGETS[backend];
  if (!target || typeof modelId !== 'string' || !modelId.trim()
    || (backend !== 'mtplx' && modelId !== target.modelId && !target.aliases.includes(modelId))) {
    throw new ServerError(
      `Local TUI agent benchmark supports only the configured ${backend || 'local'} target`,
      { status: 400, code: 'LOCAL_AGENT_BENCHMARK_TARGET_INVALID' },
    );
  }
  return target;
};

// Re-exported so this module's own callers and suite keep one import site while
// the envelope itself lives in `lib/opencodeStream.js`.
export { summarizeOpenCodeEvents };

const validateProvider = (provider, target, backend) => {
  if (!provider) {
    throw new ServerError(`Provider "${target.providerId}" is not configured`, { status: 503, code: 'LOCAL_AGENT_BENCHMARK_PROVIDER_MISSING' });
  }
  const commandMatches = target.command === 'claude'
    ? isClaudeCommand(provider.command)
    : isOpencodeCommand(provider.command);
  const runtime = backend === 'claude-ollama' || backend === 'ollama-coder' ? 'ollama' : backend;
  if (provider.type !== 'tui' || !commandMatches || localRuntimeNamespace(provider) !== runtime
    || localRuntimeForProvider(provider)?.kind !== runtime) {
    throw new ServerError(`Provider "${target.providerId}" must be a local ${target.label} provider`, { status: 503, code: 'LOCAL_AGENT_BENCHMARK_PROVIDER_INVALID' });
  }
};

/**
 * Run one explicit local-TUI PTY task benchmark.
 *
 * Takes the heavy-local-job claim an assessment, sweep or capability test
 * takes: a 10-minute run on the same runtime would otherwise contend with them
 * and corrupt both sets of timings. Refuses with 409 instead of waiting.
 *
 * @param {{backend:'llama'|'mtplx'|'ollama'|'ollama-coder'|'claude-ollama'|'splash'|'mkserve', modelId:string, timeoutMs?:number}} options
 */
export async function runOpenCodeAgentBenchmark({ backend, modelId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = targetFor(backend, modelId);
  if (activeBenchmark) {
    throw new ServerError('A local TUI agent benchmark is already running', { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY' });
  }
  const controller = new AbortController();
  activeBenchmark = controller;
  const { signal } = controller;
  try {
    const result = await runBenchmark({ backend, modelId, timeoutMs, target, signal });
    return signal.aborted ? { completed: false, cancelled: true } : result;
  } catch (error) {
    if (!signal.aborted) throw error;
    return { completed: false, cancelled: true };
  } finally {
    activeBenchmark = null;
  }
}

async function runBenchmark({ backend, modelId, timeoutMs, target, signal }) {
  const provider = await getProviderById(target.providerId);
  signal.throwIfAborted();
  validateProvider(provider, target, backend);

  const claim = await claimHeavyLocalJob({ kind: 'local-model agent benchmark', id: `${backend}/${modelId}`, signal });
  if (!claim.ok) {
    signal.throwIfAborted();
    throw new ServerError(claim.message, { status: 409, code: 'HEAVY_LOCAL_JOB_BUSY', context: { holder: claim.holder } });
  }
  try {
    signal.throwIfAborted();
    const startedAt = Date.now();
    // Keep the shipped served-id target callable for existing installs. Other
    // MTPLX targets are cache repo IDs and can require changing the checkpoint.
    if (backend === 'mtplx' && modelId !== target.modelId) {
      return await runOnMtplxCheckpoint(modelId, (servedModelId, endpoint) => {
        if (!servedModelId) {
          throw new ServerError('MTPLX did not report a served model ID', { status: 503, code: 'LOCAL_AGENT_BENCHMARK_MODEL_UNAVAILABLE' });
        }
        const config = buildOpencodeConfig(servedModelId, parseOpencodeConfigContent(provider.envVars?.OPENCODE_CONFIG_CONTENT), 'mtplx');
        config.provider.mtplx.options = { ...config.provider.mtplx.options, baseURL: endpoint };
        // Project the daemon endpoint onto the provider record. The TUI
        // runner still builds the child environment through its normal path.
        const envVars = { ...provider.envVars };
        envVars.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
        return executeBenchmark({
          backend, modelId, timeoutMs, target, servedModelId, startedAt, signal,
          provider: { ...provider, endpoint, envVars },
        });
      }, { requireCached: true, signal });
    }
    return await executeBenchmark({ backend, modelId, timeoutMs, target, provider, startedAt, signal });
  } finally {
    await claim.release();
  }
}

async function executeBenchmark({ backend, modelId, timeoutMs, target, provider, startedAt, signal, servedModelId = modelId }) {
  const scratchDir = await mkdtemp(join(tmpdir(), 'portos-opencode-agent-benchmark-'));
  const runId = `portos-opencode-agent-benchmark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const benchmarkFilePath = join(scratchDir, 'PORTOS_AGENT_BENCHMARK.txt');
  const stopTui = () => {
    stopRun(runId).catch((error) => {
      console.error(`❌ Local LLM: could not stop the OpenCode benchmark — ${error.message}`);
    });
  };
  try {
    signal.throwIfAborted();
    // This benchmark uses the direct PTY runner instead of
    // runPromptThroughProvider, so wake a stopped local daemon before spawning
    // OpenCode. MTPLX releases its checkpoint after the idle window.
    const ready = await ensureProviderReadyForExecution(provider);
    signal.throwIfAborted();
    if (!ready.success) {
      return {
        backend,
        modelId,
        providerId: target.providerId,
        providerLabel: target.label,
        measurementMode: 'pty-tui',
        completed: false,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        assistantChars: null,
        outputTokens: null,
        toolCalls: null,
        taskCharsPerSecond: null,
        taskTokensPerSecond: null,
        exitCode: null,
        timedOut: false,
        error: ready.error || `${target.label} is not ready`,
      };
    }

    // The one-shot TUI runner owns PTY startup, prompt paste, trust dialogs,
    // response-file completion, cancellation and run-record cleanup semantics.
    // Clone only the model pin: the provider's endpoint, env and permissions
    // stay exactly as the user configured them.
    let completion;
    await executeTuiRun({
      runId,
      provider: { ...provider, defaultModel: servedModelId },
      prompt: buildOpenCodeAgentBenchmarkPrompt(benchmarkFilePath),
      workspacePath: scratchDir,
      timeout: timeoutMs,
      label: `local-model-benchmark:${backend}`,
      guard: true,
      // This run is a PROBE — measuring whether a local model can drive an
      // agentic task is the whole point, so "it couldn't" is the result, and
      // it is already reported in `error` below. Left reporting, every failed
      // benchmark also queued a CoS "Investigate AI provider failure" task
      // against a provider nobody claimed was healthy — and pointed it at a
      // run record this function's `finally` had already deleted.
      reportFailure: false,
      beforeExecute: () => signal.throwIfAborted(),
      onReady: () => {
        signal.addEventListener('abort', stopTui, { once: true });
        if (signal.aborted) stopTui();
      },
      onComplete: (result) => { completion = result; },
    }).catch((err) => { completion = { success: false, exitCode: 1, error: err?.message || 'OpenCode TUI failed' }; });
    signal.throwIfAborted();
    completion ??= { success: false, error: 'OpenCode TUI did not report a result' };
    const sentinel = await readFile(benchmarkFilePath, 'utf8')
      .then((value) => value.trim())
      .catch(() => '');
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const completed = completion.success === true && sentinel === 'PORTOS_AGENT_BENCHMARK_OK';

    return {
      backend,
      modelId,
      providerId: target.providerId,
      providerLabel: target.label,
      measurementMode: 'pty-tui',
      completed,
      elapsedMs,
      // The response file contains the fixed sentinel for this check, not the
      // model's full terminal transcript. Reporting its 25 characters as a
      // throughput rate would rank terminal overhead, not inference.
      assistantChars: null,
      outputTokens: null,
      toolCalls: null,
      taskCharsPerSecond: null,
      taskTokensPerSecond: null,
      exitCode: completion.exitCode ?? null,
      timedOut: completion.exitCode === 124,
      error: completed
        ? null
        : (completion.exitCode === 124
          ? `OpenCode task timed out after ${Math.round(timeoutMs / 1000)}s`
        : (completion.success ? `${target.label} finished without the benchmark sentinel` : (completion.error || `${target.label} exited with code ${completion.exitCode ?? 'unknown'}`))),
      // Deliberately no stdout/stderr or scratch path in the API response: a
      // local model may echo environment details, and the page needs rates, not
      // a transcript that could contain user data.
    };
  } finally {
    signal.removeEventListener('abort', stopTui);
    await rm(scratchDir, { recursive: true, force: true }).catch((err) => {
      console.error(`⚠️ Local LLM: could not remove the OpenCode benchmark scratch directory — ${err.message}`);
    });
    await rm(join(getRunsPath(), runId), { recursive: true, force: true }).catch((err) => {
      console.error(`⚠️ Local LLM: could not remove the OpenCode TUI benchmark run record — ${err.message}`);
    });
  }
}
