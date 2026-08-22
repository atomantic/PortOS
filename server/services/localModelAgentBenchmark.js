/**
 * User-triggered OpenCode agent-task checks for the local Qwen runtimes.
 *
 * The ordinary assessment measures one direct generation at several context
 * lengths. That is the right instrument for decoder throughput, but it cannot
 * answer whether a CoS task actually completes through the OpenCode tool loop.
 * This service runs one bounded, disposable task through the configured
 * OpenCode TUI provider preset, then reports task-level chars/s and any output
 * token counts OpenCode exposes in its JSON event stream.
 *
 * It deliberately uses `opencode run --format json` rather than a PTY. The
 * provider config, model namespace, local endpoint, permissions, and tool loop
 * are the same; terminal paste/render latency is not included. The UI labels
 * that distinction so a task result is never mistaken for raw decode speed.
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { bufferedSpawn, prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { buildCliChildEnv } from '../lib/cliChildEnv.js';
import { isOpencodeCommand, prefixOpencodeModel } from '../lib/providerModels.js';
import { getProviderById } from './providers.js';

export const OPENCODE_AGENT_BENCHMARK_TARGETS = Object.freeze({
  llama: Object.freeze({
    providerId: 'opencode-llama-tui',
    label: 'OpenCode llama TUI',
    modelId: 'qwen3.8-27b-dflash2',
    aliases: Object.freeze(['dflash']),
  }),
  mtplx: Object.freeze({
    providerId: 'opencode-mtplx-tui',
    label: 'OpenCode MTPLX TUI',
    modelId: 'mtplx-qwen38-27b-optimized-speed',
    aliases: Object.freeze([]),
  }),
  ollama: Object.freeze({
    providerId: 'opencode-ollama-tui',
    label: 'OpenCode Ollama TUI',
    modelId: 'qwen3.8:27b-mlx',
    aliases: Object.freeze([]),
  }),
});

export const OPENCODE_AGENT_BENCHMARK_PROMPT = [
  'This is a disposable PortOS runtime benchmark. You must exercise the terminal tool loop.',
  'In the current scratch workspace, create a file named PORTOS_AGENT_BENCHMARK.txt',
  'whose entire contents are exactly PORTOS_AGENT_BENCHMARK_OK (with no extra newline if your tool permits).',
  'Read that file back with a terminal tool, verify the exact sentinel, and then reply with exactly',
  'PORTOS_AGENT_BENCHMARK_OK. Do not create or modify any other file.',
].join(' ');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const targetFor = (backend, modelId) => {
  const target = OPENCODE_AGENT_BENCHMARK_TARGETS[backend];
  if (!target || (modelId !== target.modelId && !target.aliases.includes(modelId))) {
    throw new ServerError(
      `OpenCode agent benchmark supports only the configured ${backend || 'local'} Qwen target`,
      { status: 400, code: 'LOCAL_AGENT_BENCHMARK_TARGET_INVALID' },
    );
  }
  return target;
};

const jsonLines = (output) => String(output || '').split(/\r?\n/).map((line) => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch { return null; }
}).filter(Boolean);

/**
 * Extract task evidence from OpenCode's `--format json` event stream.
 * OpenCode has used both `type: 'text', part: { text }` and
 * `type: 'message.part.updated', properties: { part: { type: 'text', text } }`
 * shapes, so the parser accepts both without counting tool arguments as answer
 * text. It is pure and exported for fixture-driven tests.
 */
export function summarizeOpenCodeEvents(output) {
  let assistantText = '';
  let toolCalls = 0;
  let outputTokens = 0;
  let hasOutputTokens = false;

  for (const event of jsonLines(output)) {
    const part = event?.part || event?.properties?.part || event?.data?.part || null;
    const partType = part?.type || event?.type;
    if (partType === 'text') {
      const text = typeof part?.text === 'string' ? part.text : event?.text;
      if (typeof text === 'string') assistantText += text;
    }
    if (partType === 'tool' || partType === 'tool_use' || partType === 'tool-call' || event?.type === 'tool_use') toolCalls += 1;

    const candidate = part?.tokens?.output ?? event?.tokens?.output ?? event?.usage?.completion_tokens ?? event?.usage?.output_tokens;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      outputTokens += candidate;
      hasOutputTokens = true;
    }
  }

  return {
    assistantChars: assistantText.length,
    toolCalls,
    outputTokens: hasOutputTokens ? outputTokens : null,
  };
}

const validateProvider = (provider, target) => {
  if (!provider) {
    throw new ServerError(`Provider "${target.providerId}" is not configured`, { status: 503, code: 'LOCAL_AGENT_BENCHMARK_PROVIDER_MISSING' });
  }
  if (provider.type !== 'tui' || !isOpencodeCommand(provider.command)) {
    throw new ServerError(`Provider "${target.providerId}" is not an OpenCode TUI provider`, { status: 503, code: 'LOCAL_AGENT_BENCHMARK_PROVIDER_INVALID' });
  }
};

/**
 * Run one explicit OpenCode task benchmark.
 *
 * @param {{backend:'llama'|'mtplx'|'ollama', modelId:string, timeoutMs?:number}} options
 */
export async function runOpenCodeAgentBenchmark({ backend, modelId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const target = targetFor(backend, modelId);
  const provider = await getProviderById(target.providerId);
  validateProvider(provider, target);

  const scratchDir = await mkdtemp(join(tmpdir(), 'portos-opencode-agent-benchmark-'));
  const startedAt = Date.now();
  try {
    // Reuse the same model-prefix and dynamic OpenCode config path as the real
    // TUI spawner. The benchmark cannot accidentally route a bare model to a
    // cloud provider or fail because the per-run model was not declared.
    const qualifiedModel = prefixOpencodeModel(provider, modelId);
    const command = provider.command;
    const baseArgs = Array.isArray(provider.args) ? provider.args : [];
    const args = ['run', '--format', 'json', '--auto', '--dir', scratchDir, ...baseArgs, '--model', qualifiedModel, OPENCODE_AGENT_BENCHMARK_PROMPT];
    const env = buildCliChildEnv({ provider, model: modelId, cwd: scratchDir, guard: true });
    const spawnTarget = prepareCliSpawn(command, args, env);
    const result = await bufferedSpawn(spawnTarget.command, spawnTarget.args, {
      cwd: scratchDir,
      env,
      timeoutMs,
    });
    const evidence = summarizeOpenCodeEvents(result.stdout);
    const sentinel = await readFile(join(scratchDir, 'PORTOS_AGENT_BENCHMARK.txt'), 'utf8')
      .then((value) => value.trim())
      .catch(() => '');
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const completed = result.success && sentinel === 'PORTOS_AGENT_BENCHMARK_OK';
    const taskCharsPerSecond = elapsedMs > 0 && evidence.assistantChars > 0
      ? Number((evidence.assistantChars / (elapsedMs / 1000)).toFixed(2))
      : null;
    const taskTokensPerSecond = elapsedMs > 0 && Number.isFinite(evidence.outputTokens) && evidence.outputTokens > 0
      ? Number((evidence.outputTokens / (elapsedMs / 1000)).toFixed(2))
      : null;

    return {
      backend,
      modelId,
      providerId: target.providerId,
      providerLabel: target.label,
      completed,
      elapsedMs,
      assistantChars: evidence.assistantChars,
      outputTokens: evidence.outputTokens,
      toolCalls: evidence.toolCalls,
      taskCharsPerSecond,
      taskTokensPerSecond,
      exitCode: result.code,
      timedOut: result.timedOut,
      error: completed
        ? null
        : (result.timedOut
          ? `OpenCode task timed out after ${Math.round(timeoutMs / 1000)}s`
          : (result.success ? 'OpenCode finished without the benchmark sentinel' : `OpenCode exited with code ${result.code ?? 'unknown'}`)),
      // Deliberately no stdout/stderr or scratch path in the API response: a
      // local model may echo environment details, and the page needs rates, not
      // a transcript that could contain user data.
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch((err) => {
      console.error(`⚠️ Local LLM: could not remove the OpenCode benchmark scratch directory — ${err.message}`);
    });
  }
}
