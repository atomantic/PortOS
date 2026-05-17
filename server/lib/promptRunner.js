/**
 * Shared LLM runner wrapper.
 *
 * Four near-identical implementations of "create run → branch on
 * provider.type → executeCliRun/executeApiRun → accumulate streamed text
 * → reject on error" had drifted in failure-handling:
 *
 *   - universeBuilderExpand#callLLM        — CLI: `error || success === false`, API: `error` only
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
 * Returns `{ text, runId, model }`. `text` is the full streamed body;
 * `runId` is the persisted run id so callers can log it and surface
 * data/runs/<runId>/output.txt for offline debugging; `model` is the
 * effective model that actually executed after the per-provider
 * override gate (null when neither the caller's model nor
 * provider.defaultModel applies). Callers should log/return THIS
 * `model`, not the value they passed in, so logs and run records
 * stay honest about what the runner actually executed.
 */

import { createRun, executeApiRun, executeCliRun, extractBakedModel, hasModelFlag } from '../services/runner.js';
import { executeTuiRun, cleanTuiResponse } from './tuiPromptRunner.js';

const DEFAULT_TIMEOUT_MS = 300000;
const APPEND_CHUNK = (acc, chunk) => acc + (typeof chunk === 'string' ? chunk : (chunk?.text || ''));

/**
 * Returns true when the runner+provider pair will actually honor a
 * per-call `model` override. For API providers the model is a
 * first-class arg to `executeApiRun`. For CLI/TUI providers,
 * `runner.js#buildCliArgs` / `tuiPromptRunner.js#buildOneShotInvocation`
 * translate the resolved `defaultModel` into a `--model`/`-m` flag — BUT
 * only when the user hasn't already baked a model flag into `provider.args`.
 * If a flag is baked in, the runner-injected one is suppressed and the
 * args-baked model wins; so claim "doesn't honor" for that case to keep
 * the run-record honest.
 */
export const providerHonorsModelOverride = (provider) => (
  provider?.type === 'api'
  || ((provider?.type === 'cli' || provider?.type === 'tui') && !hasModelFlag(provider?.args))
);

/**
 * Resolve the model id that will ACTUALLY execute against the provider,
 * for accurate logging + run-record persistence.
 *
 * Decision table:
 *   - Provider honors per-call override (API or CLI w/o baked args flag)
 *     → callerModel || provider.defaultModel || provider.models[0]
 *   - CLI with a baked --model/-m in provider.args (runner.js will
 *     suppress its own injection and let the args-pinned model win)
 *     → extractBakedModel(args) || provider.defaultModel || models[0]
 *
 * Returns null when no fallback resolves (so logs read "(default)" instead
 * of an inaccurate value).
 *
 * @param {object} provider
 * @param {string} [callerModel] — the per-call model the caller asked for
 * @returns {string|null}
 */
export function resolveEffectiveModel(provider, callerModel) {
  if (providerHonorsModelOverride(provider)) {
    return callerModel || provider?.defaultModel || provider?.models?.[0] || null;
  }
  // Non-honoring CLI/TUI path: args-baked model id wins over defaultModel.
  const baked = (provider?.type === 'cli' || provider?.type === 'tui') && hasModelFlag(provider?.args)
    ? extractBakedModel(provider.args)
    : null;
  return baked || provider?.defaultModel || provider?.models?.[0] || null;
}

/**
 * Run a prompt through a provider and resolve with the streamed text +
 * run id. Rejects (via the strictest discriminator) on any runner-
 * reported failure.
 *
 * Per-call `model` overrides are silently dropped for providers that
 * don't honor them (see `providerHonorsModelOverride`). This keeps the
 * persisted run record honest about which model actually ran — passing
 * the user's selection downstream when the runner can't apply it would
 * make `/runs` and SSE status events lie about model usage.
 *
 * @param {object} args
 * @param {object} args.provider — { id, type: 'cli'|'api'|'tui', timeout?, ... }
 * @param {string} args.prompt   — full text to send to the LLM
 * @param {string} args.source   — run-record tag (`'universe-builder-expansion'`,
 *   `'media-prompt-refine'`, `'messages-triage'`, `'staged-llm'`, etc.)
 * @param {string} [args.model]  — model id hint; ignored when the
 *   provider doesn't honor it (claude-code, gemini-cli today).
 * @param {string} [args.runId]  — caller-supplied run id (skip createRun
 *   round-trip when the caller has already created the run)
 * @param {(chunk: string) => void} [args.onData] — incremental stream
 *   callback; receives each output chunk as it arrives. Useful for live
 *   progress UI (loops, live transcripts). Does NOT change the resolved
 *   `text` value — callers receive the full buffered text either way.
 *   For TUI providers the stripped chunks are emitted; the final `text`
 *   is the cleaned response with the prompt-echo elided.
 * @param {number} [args.timeout] — per-call timeout in ms; falls back to
 *   `provider.timeout`, then DEFAULT_TIMEOUT_MS. Callers like the loop
 *   runner expose a user-configurable timeout that isn't a provider attr.
 * @param {string} [args.cwd] — working directory for the spawned process.
 *   Defaults to `process.cwd()`. Callers that run AI against external
 *   directories (loops with `loop.cwd`, pm2Standardizer with a repo path)
 *   must pass this — without it, the CLI/TUI spawn lands in PortOS's own
 *   cwd and the analysis runs against the wrong files. No-op for API
 *   providers (no spawn).
 * @returns {Promise<{ text: string, runId: string, model: string|null }>}
 *   — `model` is the resolved model that actually executed (null when
 *   neither override nor provider.defaultModel applies).
 */
export async function runPromptThroughProvider({ provider, prompt, source, model, runId: callerRunId, onData: onDataCallback, timeout: timeoutOverride, cwd: cwdOverride }) {
  // Validate inputs up front so an accidentally-null `provider` (or one
  // missing `id`/`type`) surfaces a clear error here instead of throwing
  // a downstream TypeError on `provider.id` inside createRun or on the
  // provider.type dispatch below.
  if (!provider || typeof provider !== 'object') {
    throw new Error('runPromptThroughProvider: provider is required');
  }
  if (typeof provider.id !== 'string' || !provider.id) {
    throw new Error('runPromptThroughProvider: provider.id must be a non-empty string');
  }
  if (provider.type !== 'cli' && provider.type !== 'api' && provider.type !== 'tui') {
    throw new Error(`Unsupported provider type: ${provider.type}`);
  }
  if (typeof prompt !== 'string' || !prompt.length) {
    throw new Error('runPromptThroughProvider: prompt must be a non-empty string');
  }
  if (typeof source !== 'string' || !source.length) {
    throw new Error('runPromptThroughProvider: source must be a non-empty string');
  }

  // Resolve the model that'll actually run BEFORE creating the run record
  // so the record reflects reality. resolveEffectiveModel handles both
  // the override-honored fallback chain AND the args-baked-CLI case
  // (extract the args-pinned model id rather than logging defaultModel).
  const effectiveModel = resolveEffectiveModel(provider, model);

  // Some call sites (stageRunner) create the run themselves so they can
  // log the runId before the LLM call starts. When provided, reuse it.
  // Otherwise create one here so callers always get a runId back.
  const runId = callerRunId || (await createRun({
    providerId: provider.id,
    model: effectiveModel,
    prompt,
    source,
  })).runId;

  return new Promise((resolve, reject) => {
    let text = '';
    const onData = (chunk) => {
      text = APPEND_CHUNK(text, chunk);
      if (onDataCallback) {
        const chunkText = typeof chunk === 'string' ? chunk : (chunk?.text || '');
        if (chunkText) onDataCallback(chunkText);
      }
    };
    // Strictest discriminator: reject on either truthy `error` OR
    // explicit `success === false`. Per-site drift was the bug.
    const labelByType = { cli: 'CLI', api: 'API', tui: 'TUI' };
    const onComplete = (result) => {
      if (result?.error || result?.success === false) {
        reject(new Error(result?.error || `${labelByType[provider.type] || provider.type} execution failed`));
      } else {
        // TUI buffers contain the pasted prompt echo + UI chrome — clean
        // before resolving so callers see roughly the same shape they
        // get from a CLI run (model response text, possibly with noise).
        const cleaned = provider.type === 'tui' ? cleanTuiResponse(text, prompt) : text;
        resolve({ text: cleaned, runId, model: effectiveModel });
      }
    };

    // executeCliRun / executeTuiRun both read `provider.defaultModel` for
    // arg construction AND the run-started metadata hook. Hand them a
    // clone with effectiveModel pinned so a per-call model override
    // actually picks up (and the hook reports the right model). The
    // guard skips the clone when effectiveModel already equals
    // provider.defaultModel — typical for non-codex CLI providers where
    // resolveEffectiveModel falls through to defaultModel anyway.
    const providerForRun = effectiveModel && effectiveModel !== provider.defaultModel
      ? { ...provider, defaultModel: effectiveModel }
      : provider;
    const effectiveTimeout = timeoutOverride ?? providerForRun.timeout ?? DEFAULT_TIMEOUT_MS;
    const effectiveCwd = cwdOverride ?? process.cwd();

    if (provider.type === 'cli') {
      executeCliRun(runId, providerForRun, prompt, effectiveCwd, onData, onComplete, effectiveTimeout).catch(reject);
    } else if (provider.type === 'api') {
      // API runs take model as a first-class arg — no clone needed. cwd
      // is irrelevant for API providers but the toolkit signature still
      // takes it for parity with the CLI/TUI paths.
      executeApiRun(runId, provider, effectiveModel, prompt, effectiveCwd, [], onData, onComplete).catch(reject);
    } else if (provider.type === 'tui') {
      executeTuiRun(runId, providerForRun, prompt, effectiveCwd, onData, onComplete, effectiveTimeout).catch(reject);
    } else {
      reject(new Error(`Unsupported provider type: ${provider.type}`));
    }
  });
}
