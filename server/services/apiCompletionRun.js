/**
 * The shared runner's bounded-completion executor: one non-streaming chat
 * completion as a tracked run.
 *
 * Reached only through `promptRunner.runPromptThroughProvider({ completion })`.
 * It sits beside the CLI and TUI host runners in `runner.js` /
 * `tuiPromptRunner.js` and uses the same record primitives, so a bounded
 * completion gets a run record, one usage session (`onRunCreated`), measured
 * usage on completion (`onRunCompleted`) and a working Stop, like every other
 * run.
 *
 * What it deliberately does NOT take from the streaming path, because the
 * callers it serves never had it and a silent change would alter which request
 * goes out or what they are told:
 *   - no provider-health routing: the run is recorded against the exact record
 *     the caller passed (`createRun({ provider })`), a benched provider is still
 *     tried, and a failure benches nothing;
 *   - no `onRunFailed` report: these calls surface their own failure through
 *     `ai:status`, and the hook would add a second error toast and queue an
 *     auto-fix investigation, which is a provider call nobody asked for;
 *   - no context-window admission, local concurrency gate or fallback cascade.
 */

import { createRun, finalizeRunRecord, patchRunMetadata, registerActiveRun, unregisterActiveRun, emitRunStarted } from './runner.js';
import { runOwnership } from '../lib/aiToolkit/internal/runOwnership.js';
import { anyAbortSignal } from '../lib/requestAbort.js';
import { runChatCompletion } from './chatCompletionExchange.js';

const notify = (hook, label, ...args) => {
  if (typeof hook !== 'function') return;
  try { hook(...args); } catch (err) { console.error(`❌ run lifecycle ${label} hook failed: ${err.message}`); }
};

const canceledError = (message, runId = null) => Object.assign(new Error(message), {
  code: 'RUN_CANCELED', canceled: true, ...(runId ? { runId } : {}),
});

/**
 * @param {object} args the validated `runPromptThroughProvider` arguments
 * @param {object} args.provider an API provider record, executed exactly as given
 * @param {string} args.prompt the text to send, already stamped by the runner
 * @param {number} args.timeout wall-clock deadline per request, in ms
 * @param {{ temperature?: number, maxTokens?: number, recover?: (failure: object) => Promise<string|null> }} args.completion
 * @returns {Promise<{ text: string, runId: string, model: string|null, provider: object,
 *   finishReason?: string, usage?: object, tokens?: number, retried: boolean }>}
 * @throws {Error} the reply's own error text, with `runId`, `completionFailure`
 *   (the failed reply: `{ error, status?, body?, stallPhase?, model, retried }`)
 *   and, for a Stop or an aborted `signal`, `code: 'RUN_CANCELED'`.
 */
export async function executeApiCompletionRun({
  provider, prompt, source, model, timeout, signal = null, cwd, completion, onRunCreated, onRunSettled,
}) {
  if (signal?.aborted) throw canceledError('Run canceled before dispatch');
  const startTime = Date.now();

  const { runId } = await createRun({
    providerId: provider.id,
    provider,
    model,
    prompt,
    source,
    ...(typeof cwd === 'string' && cwd ? { workspacePath: cwd } : {}),
    allowFallback: false,
  });

  // The run's Stop: `stopRun` aborts this controller through the external
  // registry, and the caller's own signal is combined with it.
  const controller = new AbortController();
  const stopped = anyAbortSignal([controller.signal, signal]);
  // Not awaited before the request: ownership only matters to boot recovery,
  // and the write would sit in front of every call. It is settled before the
  // record is finalized, so it can never overwrite the finished record.
  const ownershipSaved = patchRunMetadata(runId, runOwnership('api')).catch(() => {});

  let reply;
  let thrown = null;
  try {
    registerActiveRun(runId, controller);
    notify(onRunCreated, 'start', runId, {
      runId, providerId: provider.id, providerName: provider.name || provider.id, model, providerType: provider.type,
    });
    emitRunStarted({ runId, provider, model });
    reply = await runChatCompletion({
      provider, model, prompt, timeout,
      temperature: completion.temperature,
      maxTokens: completion.maxTokens,
      recover: completion.recover,
      signal: stopped,
    });
  } catch (err) {
    // The exchange reports its failures as a reply; a throw is the caller's
    // `recover` step or the run registry. Record it, then let it propagate.
    thrown = err;
    reply = { error: err.message, model, retried: false };
  } finally {
    unregisterActiveRun(runId);
  }

  const failed = Boolean(reply.error);
  // An abort that lands after the answer arrived changes nothing: the request
  // already completed and was paid for.
  const canceled = failed && stopped.aborted;
  await ownershipSaved;
  // The record is tracking, not the answer: a failed write must not turn a
  // completed call into a failed one.
  await finalizeRunRecord({
    runId,
    output: failed ? '' : reply.text,
    exitCode: failed ? 1 : 0,
    success: !failed,
    ...(failed ? { error: reply.error } : {}),
    startTime,
    reportFailure: false,
    extras: {
      ...(reply.model && reply.model !== model ? { model: reply.model } : {}),
      ...(reply.finishReason ? { finishReason: reply.finishReason } : {}),
      ...(reply.reportedUsage ? { reportedUsage: reply.reportedUsage } : {}),
      ...(Number.isInteger(reply.status) ? { httpStatus: reply.status } : {}),
      ...(reply.stallPhase ? { stallPhase: reply.stallPhase } : {}),
      ...(canceled ? { canceled: true, completionReason: 'canceled' } : {}),
    },
  }).catch((err) => console.error(`❌ Run ${runId} could not be finalized: ${err.message}`));
  notify(onRunSettled, 'settle', runId);

  if (thrown) throw Object.assign(thrown, { runId });
  if (failed) {
    const err = canceled ? canceledError(reply.error, runId) : Object.assign(new Error(reply.error), { runId });
    err.completionFailure = reply;
    throw err;
  }
  return {
    text: reply.text,
    runId,
    model: reply.model,
    provider,
    retried: reply.retried,
    ...(reply.finishReason ? { finishReason: reply.finishReason } : {}),
    ...(reply.usage ? { usage: reply.usage } : {}),
    ...(Number.isFinite(reply.tokens) ? { tokens: reply.tokens } : {}),
  };
}
