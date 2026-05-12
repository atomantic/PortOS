/**
 * Shared LLM runner wrapper.
 *
 * Four near-identical implementations of "create run → branch on
 * provider.type → executeCliRun/executeApiRun → accumulate streamed text
 * → reject on error" had drifted in failure-handling:
 *
 *   - worldBuilderExpand#callLLM        — CLI: `error || success === false`, API: `error` only
 *   - stageRunner#awaitRunnerCall       — CLI: `error || success === false`, API: `error` only
 *   - mediaPromptRefiner#runRefinePrompt — both: `error || success === false`
 *   - messageEvaluator#runPrompt        — CLI: `error || success === false`, API: `error` only
 *
 * This unified runner picks the strictest discriminator: reject on
 * `success === false` OR truthy `error` for BOTH CLI and API. The
 * per-site drift was the bug — silent API "soft failures" (e.g. an
 * empty completion that doesn't set `error` but does set
 * `success: false`) used to flow through as a successful empty string.
 *
 * Returns `{ text, runId }`. `text` is the full streamed body; `runId`
 * is the persisted run id so callers can log it and surface
 * data/runs/<runId>/output.txt for offline debugging.
 */

import { createRun, executeApiRun, executeCliRun } from '../services/runner.js';

const DEFAULT_TIMEOUT_MS = 300000;
const APPEND_CHUNK = (acc, chunk) => acc + (typeof chunk === 'string' ? chunk : (chunk?.text || ''));

/**
 * Run a prompt through a provider and resolve with the streamed text +
 * run id. Rejects (via the strictest discriminator) on any runner-
 * reported failure.
 *
 * @param {object} args
 * @param {object} args.provider — { id, type: 'cli'|'api', timeout?, ... }
 * @param {string} args.prompt   — full text to send to the LLM
 * @param {string} args.source   — run-record tag (`'world-builder-expansion'`,
 *   `'media-prompt-refine'`, `'messages-triage'`, `'staged-llm'`, etc.)
 * @param {string} [args.model]  — explicit model id (CLI providers honor
 *   this only when buildCliArgs supports per-call model override —
 *   today that's just codex; the caller is responsible for the upstream
 *   "should I even pass model?" decision)
 * @param {string} [args.runId]  — caller-supplied run id (skip createRun
 *   round-trip when the caller has already created the run)
 * @returns {Promise<{ text: string, runId: string }>}
 */
export async function runPromptThroughProvider({ provider, prompt, source, model, runId: callerRunId }) {
  // Some call sites (stageRunner) create the run themselves so they can
  // log the runId before the LLM call starts. When provided, reuse it.
  // Otherwise create one here so callers always get a runId back.
  const runId = callerRunId || (await createRun({
    providerId: provider.id,
    model,
    prompt,
    source,
  })).runId;

  return new Promise((resolve, reject) => {
    let text = '';
    const onData = (chunk) => { text = APPEND_CHUNK(text, chunk); };
    // Strictest discriminator: reject on either truthy `error` OR
    // explicit `success === false`. Per-site drift was the bug.
    const onComplete = (result) => {
      if (result?.error || result?.success === false) {
        reject(new Error(result?.error || `${provider.type === 'cli' ? 'CLI' : 'API'} execution failed`));
      } else {
        resolve({ text, runId });
      }
    };

    if (provider.type === 'cli') {
      // executeCliRun reads `provider.defaultModel` for both the CLI
      // args (`buildCliArgs(provider)`) and the run-started metadata
      // hook (which persists the model name on the run record). The
      // toolkit's CLI entry doesn't accept a separate `model` param,
      // so we'd have to clone the provider with the new defaultModel
      // to honor a per-call override. But `runner.js#buildCliArgs`
      // currently only translates `defaultModel` into a `--model`
      // flag for the `codex` provider — claude-code and gemini-cli
      // ignore it and run with whatever model is baked into
      // provider.args. Cloning anyway would lie to the run-started
      // hook about which model actually ran. Gate the clone to codex
      // so the run record stays truthful. (PLAN.md tracks extending
      // buildCliArgs to honor per-call model for all CLI providers.)
      const honorsModelOverride = provider.id === 'codex';
      const providerForCli = honorsModelOverride && model && model !== provider.defaultModel
        ? { ...provider, defaultModel: model }
        : provider;
      executeCliRun(
        runId,
        providerForCli,
        prompt,
        process.cwd(),
        onData,
        onComplete,
        providerForCli.timeout ?? DEFAULT_TIMEOUT_MS,
      ).catch(reject);
    } else if (provider.type === 'api') {
      executeApiRun(
        runId,
        provider,
        model,
        prompt,
        process.cwd(),
        [],
        onData,
        onComplete,
      ).catch(reject);
    } else {
      reject(new Error(`Unsupported provider type: ${provider.type}`));
    }
  });
}
