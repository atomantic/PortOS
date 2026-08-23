/**
 * User-triggered local-TUI agent-task checks for the local Qwen runtimes.
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
import { isClaudeCommand, isOpencodeCommand } from '../lib/providerModels.js';
// The stream parser is shared with the capability test suite: two independent
// parsers of the same OpenCode envelope is how the two end up reporting
// different tool-call counts for the same run.
import { summarizeOpenCodeEvents } from '../lib/opencodeStream.js';
import { getProviderById } from './providers.js';
import { executeTuiRun } from '../lib/tuiPromptRunner.js';
import { getRunsPath } from './runner.js';

export const LOCAL_TUI_AGENT_BENCHMARK_TARGETS = Object.freeze({
  llama: Object.freeze({
    providerId: 'opencode-llama-tui',
    label: 'OpenCode llama TUI (Qwen3.8-27B served as dflash)',
    command: 'opencode',
    modelId: 'dflash',
    aliases: Object.freeze(['qwen3.8-27b-dflash2']),
  }),
  mtplx: Object.freeze({
    providerId: 'opencode-mtplx-tui',
    label: 'OpenCode MTPLX TUI',
    command: 'opencode',
    modelId: 'mtplx-qwen38-27b-optimized-speed',
    aliases: Object.freeze([]),
  }),
  ollama: Object.freeze({
    providerId: 'opencode-ollama-tui',
    label: 'OpenCode Ollama TUI',
    command: 'opencode',
    modelId: 'qwen3.8:27b-mlx',
    aliases: Object.freeze([]),
  }),
  'ollama-coder': Object.freeze({
    providerId: 'opencode-ollama-tui',
    label: 'OpenCode Ollama TUI (Qwen3-Coder 30B)',
    command: 'opencode',
    modelId: 'qwen3-coder:30b',
    aliases: Object.freeze([]),
  }),
  'claude-ollama': Object.freeze({
    providerId: 'claude-ollama-tui',
    label: 'Claude Ollama TUI',
    command: 'claude',
    modelId: 'qwen3.8:27b-mlx',
    aliases: Object.freeze([]),
  }),
});

export const OPENCODE_AGENT_BENCHMARK_TARGETS = LOCAL_TUI_AGENT_BENCHMARK_TARGETS;

export const buildOpenCodeAgentBenchmarkPrompt = (benchmarkFilePath = 'PORTOS_AGENT_BENCHMARK.txt') => [
  'This is a disposable PortOS runtime benchmark. You must exercise the terminal tool loop.',
  `In the current scratch workspace, create a file named PORTOS_AGENT_BENCHMARK.txt at exactly this path: ${benchmarkFilePath}`,
  'whose entire contents are exactly PORTOS_AGENT_BENCHMARK_OK (with no extra newline if your tool permits).',
  'Read that file back with a terminal tool, verify the exact sentinel, and then reply with exactly',
  'PORTOS_AGENT_BENCHMARK_OK. Do not create or modify any other file.',
].join(' ');

// Kept as a stable export for callers/tests that only need the prompt shape;
// live runs use the builder with their disposable scratch path below.
export const OPENCODE_AGENT_BENCHMARK_PROMPT = buildOpenCodeAgentBenchmarkPrompt();

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const targetFor = (backend, modelId) => {
  const target = LOCAL_TUI_AGENT_BENCHMARK_TARGETS[backend];
  if (!target || (modelId !== target.modelId && !target.aliases.includes(modelId))) {
    throw new ServerError(
      `Local TUI agent benchmark supports only the configured ${backend || 'local'} Qwen target`,
      { status: 400, code: 'LOCAL_AGENT_BENCHMARK_TARGET_INVALID' },
    );
  }
  return target;
};

// Re-exported so this module's own callers and suite keep one import site while
// the envelope itself lives in `lib/opencodeStream.js`.
export { summarizeOpenCodeEvents };

const validateProvider = (provider, target) => {
  if (!provider) {
    throw new ServerError(`Provider "${target.providerId}" is not configured`, { status: 503, code: 'LOCAL_AGENT_BENCHMARK_PROVIDER_MISSING' });
  }
  const commandMatches = target.command === 'claude'
    ? isClaudeCommand(provider.command)
    : isOpencodeCommand(provider.command);
  if (provider.type !== 'tui' || !commandMatches) {
    throw new ServerError(`Provider "${target.providerId}" is not an OpenCode TUI provider`, { status: 503, code: 'LOCAL_AGENT_BENCHMARK_PROVIDER_INVALID' });
  }
};

/**
 * Run one explicit local-TUI PTY task benchmark.
 *
 * @param {{backend:'llama'|'mtplx'|'ollama'|'ollama-coder'|'claude-ollama', modelId:string, timeoutMs?:number}} options
 */
export async function runOpenCodeAgentBenchmark({ backend, modelId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = targetFor(backend, modelId);
  const provider = await getProviderById(target.providerId);
  validateProvider(provider, target);

  const scratchDir = await mkdtemp(join(tmpdir(), 'portos-opencode-agent-benchmark-'));
  const runId = `portos-opencode-agent-benchmark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const benchmarkFilePath = join(scratchDir, 'PORTOS_AGENT_BENCHMARK.txt');
  try {
    // The one-shot TUI runner owns PTY startup, prompt paste, trust dialogs,
    // response-file completion, cancellation and run-record cleanup semantics.
    // Clone only the model pin: the provider's endpoint, env and permissions
    // stay exactly as the user configured them.
    const completion = await new Promise((resolve) => {
      executeTuiRun({
        runId,
        provider: { ...provider, defaultModel: modelId },
        prompt: buildOpenCodeAgentBenchmarkPrompt(benchmarkFilePath),
        workspacePath: scratchDir,
        timeout: timeoutMs,
        label: `local-model-benchmark:${backend}`,
        guard: true,
        onComplete: resolve,
      }).catch((err) => resolve({ success: false, exitCode: 1, error: err?.message || 'OpenCode TUI failed' }));
    });
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
    await rm(scratchDir, { recursive: true, force: true }).catch((err) => {
      console.error(`⚠️ Local LLM: could not remove the OpenCode benchmark scratch directory — ${err.message}`);
    });
    await rm(join(getRunsPath(), runId), { recursive: true, force: true }).catch((err) => {
      console.error(`⚠️ Local LLM: could not remove the OpenCode TUI benchmark run record — ${err.message}`);
    });
  }
}
