/**
 * Shared LLM runner wrapper.
 *
 * Unifies "create run → branch on provider.type → executeCliRun/executeApiRun → accumulate streamed
 * text → reject on error". Rejects on `success === false` OR truthy `error` for BOTH CLI and API, so a
 * silent API "soft failure" (no `error`, `success: false`) is not an empty success.
 *
 * Returns `{ text, runId, model }`: `runId` points at data/runs/<runId>/output.txt; `model` is the
 * effective model that actually executed after the per-provider override gate (null when neither the
 * caller's model nor provider.defaultModel applies). Log THIS `model`, not the value passed in.
 */

import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { isVisionCapableCodexTuiProvider } from '../lib/codex.js';
import { isCreativeRunSource, withCreativeLatitude } from '../lib/creativeLatitude.js';
import { ServerError } from '../lib/errorHandler.js';
import { isVisionCapableCliProvider } from '../lib/localModelHeuristics.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { isMoaProvider, isMoaProviderId } from '../lib/provider/providerTypes.js';
import { getActiveProvider, getProviderById } from './provider/providers.js';
import { recoverProviderFailure } from './promptRunner/fallbackPolicy.js';
import { DEFAULT_TIMEOUT_MS, executeProviderRunOnce, resolveEffectiveModel } from './promptRunner/providerExecution.js';
import { buildSchemaFailureError, correctResponseToSchema } from './promptRunner/schemaRepair.js';

export { isSchemaTypeCategory } from '../lib/provider/providerCooldown.js';
export { pickConfigCorrectedModel } from './promptRunner/configCorrection.js';
export { buildRequestCapabilities, isLocalEndpoint, resolveLocalPromptBudget, withObservedContextWindowsLazy } from './promptRunner/localBudget.js';
export { DEFAULT_TIMEOUT_MS, resolveEffectiveModel };
export { providerHonorsModelOverride } from './promptRunner/providerExecution.js';
export { coerceResponseToSchema, normalizeResponseSchema } from './promptRunner/schemaRepair.js';

/**
 * Resolve `{provider, selectedModel}` for an LLM caller. Prefers `providerId`; any
 * `getProviderById` failure falls through to `getActiveProvider` (whose errors still propagate).
 * Returns `{provider: null, selectedModel: null}` when neither resolves, so callers throw their own
 * typed error.
 * @param {object} args
 * @param {string} [rawArgs.providerId]
 * @param {string} [args.model]
 * @returns {Promise<{ provider: object|null, selectedModel: string|null }>}
 */
export async function resolveProviderAndModel({ providerId, model } = {}) {
  // An MoA preset id resolves to its virtual record (lib/moaConfig.js), which
  // runPromptThroughProvider dispatches to the MoA runner. Unlike an unknown
  // preset id, an INVALID stored preset throws: falling through to the active
  // provider would silently run a selection on a different model.
  if (isMoaProviderId(providerId)) {
    const { resolveMoaProvider } = await import('./moaPresets.js');
    const moa = await resolveMoaProvider(providerId);
    if (moa) return { provider: moa, selectedModel: moa.defaultModel };
  }
  let provider = providerId && !isMoaProviderId(providerId) ? await getProviderById(providerId).catch(() => null) : null;
  if (!provider) provider = await getActiveProvider();
  const selectedModel = provider ? resolveEffectiveModel(provider, model) : null;
  return { provider, selectedModel };
}

/**
 * Throw a typed "no AI provider available" error when `provider` is falsy. HTTP-facing sites pass
 * `code` (+ optional `status`, default 503) for the structured error response; internal sites omit
 * both and get a plain `Error`.
 *
 * @param {object|null} provider
 * @param {object} opts
 * @param {string} opts.message — human-readable error message
 * @param {string} [opts.code] — error code constant (e.g. `NO_PROVIDER`)
 * @param {number} [opts.status=503] — HTTP status; only used when `code` is set
 */
export function assertProvider(provider, { message, code, status = 503 } = {}) {
  if (provider) return;
  if (code) throw new ServerError(message, { status, code });
  throw new Error(message);
}

/**
 * Guard a vision run against a transport that did not receive images. API providers base64-inline
 * images; the shared CLI lifecycle stages attachments for Codex and Claude Code; Codex TUI forwards
 * native image args. Other TUI/CLI providers would answer from text alone, so throw
 * VISION_FALLBACK_DROPPED_IMAGES for them. The provider that ACTUALLY ran is `result.provider`
 * (proactive swap in createRun), else `result.fallbackProvider` (retry), else the requested one.
 *
 * @param {object} result — the runPromptThroughProvider result
 * @param {object} requestedProvider — the provider the caller asked to run
 * @returns {object} the effective provider that ran
 */
export function assertVisionRunUsedImages(result, requestedProvider) {
  const ran = result?.provider || result?.fallbackProvider || requestedProvider;
  const usedImages = ran?.type === 'api' || isVisionCapableCliProvider(ran) || isVisionCapableCodexTuiProvider(ran);
  if (ran?.type && !usedImages) {
    // Name both providers: the usual trigger is a proactive/retry swap because the requested API
    // provider is in cooldown, NOT a user-picked non-vision provider.
    const requestedName = requestedProvider?.name || requestedProvider?.id || 'the selected provider';
    const ranName = ran?.name || ran?.id || 'a non-vision provider';
    const swapped = ran?.id && requestedProvider?.id && ran.id !== requestedProvider.id;
    const cause = swapped
      ? `"${requestedName}" was unavailable (likely a temporary cooldown after an earlier failed request), so the run fell back to "${ranName}", which can't read images.`
      : `"${ranName}" can't read images.`;
    throw new ServerError(
      `${cause} Retry in a few minutes, or pick a different vision-capable API provider/model.`,
      { status: 502, code: 'VISION_FALLBACK_DROPPED_IMAGES' },
    );
  }
  return ran;
}

// The `runPromptThroughProvider` arguments a `completion` request implements.
// Every other argument is refused there, so an option added to the streamed
// path later cannot silently do nothing on a completion.
const COMPLETION_ARGS = new Set([
  'provider', 'prompt', 'source', 'model', 'timeout', 'signal', 'cwd', 'completion', 'onRunCreated', 'onRunSettled',
]);

/**
 * Run a prompt through a provider; resolves with the streamed text + run id, rejects (strictest
 * discriminator) on any runner-reported failure. Per-call `model` overrides are dropped for providers
 * that don't honor them (`providerHonorsModelOverride`) so run records stay honest.
 *
 * @param {object} args
 * @param {object} rawArgs.provider — { id, type: 'cli'|'api'|'tui', timeout?, ... }
 * @param {string} rawArgs.prompt   — full text to send to the LLM
 * @param {string} rawArgs.source   — run-record tag (`'universe-builder-expansion'`,
 *   `'media-prompt-refine'`, `'messages-triage'`, `'staged-llm'`, etc.)
 * @param {string} [args.model]  — model id hint; ignored when the
 *   provider doesn't honor it (claude-code, antigravity-cli today).
 * @param {string} [args.effort] — reasoning-effort override for effort-capable CLI/TUI providers.
 *   Clamped to the provider's ladder and dropped for providers without one, so it is safe to pass
 *   unconditionally, including through the fallback cascade.
 * @param {string} [args.runId]  — caller-supplied run id (skip createRun
 *   round-trip when the caller has already created the run)
 * @param {(chunk: string) => void} [args.onData] — incremental stream callback; does NOT change the
 *   resolved `text`. For TUI providers the stripped chunks are emitted.
 * @param {(runId:string,meta:object)=>void} [args.onRunCreated] — called immediately after
 *   each concrete primary/correction/fallback run id is known. Observational;
 *   callback errors are logged and ignored.
 * @param {(meta:object)=>void} [args.onRunReady] — called when an interactive
 *   TUI run has been registered as an attachable shell session.
 * @param {(runId:string)=>void} [args.onRunSettled] — called when that concrete
 *   attempt resolves or rejects. Observational; callback errors are ignored.
 * @param {(meta:object)=>Promise<void>} [args.beforeExecute] — enforced caller
 *   admission immediately before provider dispatch, after concurrency/readiness
 *   and attachment preparation. A rejection cancels this attempt without
 *   retrying, benching the provider, or investigating a provider failure.
 * @param {string[]} [args.screenshots] — image paths for a vision/multimodal
 *   call (relative to the runner's screenshots dir, or absolute). API providers
 *   base64-encode each into `image_url` blocks. Codex and Claude Code CLI
 *   providers receive staged file attachments through executeCliRun. Other CLI
 *   and all TUI providers are rejected before a run record is created.
 * @param {number|((provider: object) => number)} [args.timeout] — per-call
 *   timeout in ms; falls back to `provider.timeout`, then DEFAULT_TIMEOUT_MS.
 *   Callers like the loop runner expose a user-configurable timeout that isn't
 *   a provider attr. A function is resolved against the provider that actually
 *   runs (fallbacks included), for callers whose bound depends on its type:
 *   CLI/TUI treat it as a total cap, API runs as a no-progress (stall) bound.
 * @param {number} [args.maxTokens] — per-call API output cap or managed Splash
 *   Claude output allowance for a pinned tool-free run.
 * @param {number} [args.outputReserveTokens=8000] — expected completion budget
 *   included in fallback context admission. Callers with a tighter known
 *   output budget may lower it.
 * @param {string} [args.cwd] — working directory for the spawned process (default `process.cwd()`).
 *   Required for callers that run AI against external directories; no-op for API providers.
 * @param {string|string[]|object} [args.callerPolicy] — this caller's EXECUTION-MODE policy (a name
 *   from `lib/callerModePolicy.js`, a mode array, or an inline policy). Gates the EXPLICIT provider
 *   (422 `PROVIDER_MODE_NOT_PERMITTED`, before any run record) and rides on `requestCapabilities` so
 *   createRun's swap and the Tier-3 fallback skip ineligible candidates. Omit for no constraint.
 * @param {boolean} [args.allowFallback=true] — false when provider/model identity is part of the
 *   feature contract: disables proactive substitution and every retry tier. Provider-health
 *   bookkeeping still runs (a failure that benches the provider still benches it), except usage
 *   limits, whose observed-block ledger a pinned caller records itself.
 * @param {boolean} [args.allowModelCorrection=false] — with `allowFallback: false`, still run Tier 1:
 *   on model-not-found/model-not-supported, retry the SAME provider once with another model it
 *   lists. For callers that pin the provider (a tool-free admission) but not the model, so a stale
 *   saved model id doesn't fail every scheduled run. No effect when fallback is allowed.
 * @param {boolean} [args.toolFree=false] — the prompt carries text this caller does not control
 *   (#9008). A headless CLI run gets no approval-bypass flag and, where the vendor has one, its
 *   tool-disable switch (`toolFreeOneShotArgs`). Rides every fallback tier; does not reach TUI runs,
 *   so a caller that must stay tool-free gates on `isToolFreeOneShotProvider` and disables fallback.
 * @param {boolean} [args.captureClaudeOutputLimit=false] — capture first-turn counts on a pinned tool-free Splash Claude run.
 * @param {boolean} [args.isolateMtplxOpenCode=false] — select the isolated local MTPLX recipe for a pinned tool-free CLI request.
 * @param {*} [args.responseSchema] — the caller's declared response schema (#2350): a Zod-style
 *   schema or bare predicate. Enables Tier-2: validate a SUCCESSFUL response, coerce JSON in place,
 *   else re-request the SAME provider once with a schema-strengthened prompt before Tier 3/4. Unset =
 *   no validation or coercion.
 * @param {(ctx: { phase: 'response'|'request', text?: string, prompt?: string,
 *   category?: string, error?: Error }) => ({ text?: string, prompt?: string }|null|undefined)}
 *   [args.repair] — optional deterministic caller normalizer (#2350), may be async, no LLM calls;
 *   errors are logged as a decline. `phase:'response'` (response failed `responseSchema`): return
 *   `{ text }` to substitute, tried before built-in coercion. `phase:'request'` (schema/type
 *   failure): return `{ prompt }` to re-request the SAME provider, tried before the built-in prompt.
 * @param {AbortSignal} [args.signal] — the caller's cancellation, for a `completion` request only
 *   (any other request is refused rather than left running past an abort it never watched).
 *   Aborting stops the in-flight request and finalizes the run as a cancel, as Stop on the Runs page
 *   does; already aborted on entry means no run is created.
 * @param {{ temperature?: number, maxTokens?: number, recover?: (failure: object) => Promise<string|null> }}
 *   [args.completion] — ask for a BOUNDED completion instead of a streamed run: one non-streaming
 *   `/chat/completions` request whose body is exactly `{ model, messages, temperature, max_tokens }`
 *   (native Ollama `/api/chat` with `options.num_ctx` for an Ollama provider that sets `numCtx`)
 *   with the caller's own sampling, `timeout` as a wall-clock deadline, and the provider's reported
 *   token counts recorded as measured usage. API providers only. It is a pinned, routing-free run
 *   (`services/apiCompletionRun.js` lists what it leaves out and why): the provider is executed as
 *   passed, nothing falls back, and `model` goes on the wire verbatim. `recover` may repair a failed
 *   first attempt and name a model for one retry inside the same run. It takes `provider`, `prompt`,
 *   `source`, `model`, `timeout`, `signal`, `cwd`, `onRunCreated` and `onRunSettled`; any other
 *   argument is refused, never silently ignored. A prompt that provably exceeds the provider's known
 *   context window is refused before dispatch, as on the streamed path. Resolves with `usage`,
 *   `tokens` and `retried` beside the usual fields; rejects with the reply's own error text and
 *   `completionFailure`, the failed reply itself (`{ error, status?, body?, stallPhase?, model, retried }`,
 *   with `canceled: true` when the run was stopped).
 * @returns {Promise<{ text: string, runId: string, model: string|null, provider: object, usedFallback?: boolean, fixTier?: number, fixStrategy?: string, coercedResponse?: boolean, fallbackFrom?: { id: string, name: string }, fallbackProvider?: object }>}
 *   — `model` is the model that actually executed. `provider` is the provider that actually ran,
 *   reflecting createRun's proactive swap (`usedFallback`/`fallbackProvider` cover only the retry
 *   path). `runId` is the run that actually ran (the fallback's on recovery). With `usedFallback`,
 *   `fallbackFrom` names the failed primary. `fixTier`/`fixStrategy` (#2342/#2350) record which tier
 *   recovered: `1`/'config/env' same-provider model correction, `2`/'schema/type' in-place coercion
 *   (`coercedResponse:true`, `usedFallback` unset) or schema re-request, `3`/'constrained-agent-retry'
 *   fallback-provider retry.
 */
export async function runPromptThroughProvider(rawArgs) {
  return maintenance.run('provider', rawArgs?.source ?? 'prompt', () => runPromptThroughProviderAdmitted(rawArgs), { continuation: true });
}

async function runPromptThroughProviderAdmitted(rawArgs) {
  // Validate inputs up front so an accidentally-null `provider` (or one
  // missing `id`/`type`) surfaces a clear error here instead of throwing
  // a downstream TypeError on `provider.id` inside createRun or on the
  // provider.type dispatch below.
  if (!rawArgs?.provider || typeof rawArgs.provider !== 'object') {
    throw new Error('runPromptThroughProvider: provider is required');
  }
  if (typeof rawArgs.provider.id !== 'string' || !rawArgs.provider.id) {
    throw new Error('runPromptThroughProvider: provider.id must be a non-empty string');
  }
  if (rawArgs.provider.type !== PROVIDER_TYPES.CLI && rawArgs.provider.type !== PROVIDER_TYPES.API && rawArgs.provider.type !== PROVIDER_TYPES.TUI && !isMoaProvider(rawArgs.provider)) {
    throw new Error(`Unsupported provider type: ${rawArgs.provider.type}`);
  }
  if (typeof rawArgs.prompt !== 'string' || !rawArgs.prompt.length) {
    throw new Error('runPromptThroughProvider: prompt must be a non-empty string');
  }
  if (typeof rawArgs.source !== 'string' || !rawArgs.source.length) {
    throw new Error('runPromptThroughProvider: source must be a non-empty string');
  }

  // Creative requests carry the IP-latitude clause (lib/creativeLatitude.js) so a
  // model doesn't quietly genericize a reference the artist put there on purpose.
  // Keyed on `source` — the one stable per-call-site tag every caller already
  // has to pass — which covers every hand-rolled creative prompt from one place.
  // Stage-template prompts are stamped upstream in promptService.buildPrompt; the
  // stamp is idempotent, so a pre-stamped prompt passes through untouched.
  const args = isCreativeRunSource(rawArgs.source)
    ? { ...rawArgs, prompt: withCreativeLatitude(rawArgs.prompt) }
    : rawArgs;

  if (args.signal && !args.completion) {
    throw new Error('runPromptThroughProvider: signal is honoured only for completion requests');
  }
  if (isMoaProvider(args.provider)) {
    // Each member re-enters this function with its own API provider, so every
    // advisor and the aggregator is an ordinary tracked run (services/moaRunner.js).
    const { runMoaPreset } = await import('./moaRunner.js');
    return runMoaPreset(args, { runPrompt: runPromptThroughProvider });
  }
  if (args.completion) {
    if (args.provider.type !== PROVIDER_TYPES.API) {
      throw new Error('runPromptThroughProvider: a completion request needs an API provider');
    }
    // Refused rather than dropped: a `beforeExecute` spending gate or a
    // `callerPolicy` that silently did nothing would let through exactly the
    // request it exists to stop.
    const unsupported = Object.keys(args).filter((key) => !COMPLETION_ARGS.has(key) && args[key] !== undefined && args[key] !== null);
    if (unsupported.length > 0) {
      throw new Error(`runPromptThroughProvider: a completion request does not support ${unsupported.join(', ')}`);
    }
    // Refused before any run record exists, so an over-window prompt is
    // neither sent nor recorded as an attempt.
    const { completionContextRefusal } = await import('./chatCompletionExchange.js');
    const refusal = completionContextRefusal(args.provider, args.model ?? null, args.prompt);
    if (refusal) throw new Error(refusal);
    // Lazy: only bounded-completion callers pay for the exchange's closure.
    const { executeApiCompletionRun } = await import('./apiCompletionRun.js');
    // Same precedence the streamed path gives `timeout`, resolved here so the
    // executor takes one number.
    const callerTimeout = typeof args.timeout === 'function' ? args.timeout(args.provider) : args.timeout;
    return executeApiCompletionRun({ ...args, timeout: callerTimeout ?? args.provider.timeout ?? DEFAULT_TIMEOUT_MS });
  }

  // Execute once, then decide whether the deterministic fallback cascade runs.
  // A transport-layer failure is caught into `firstError`. A transport SUCCESS
  // whose response fails the caller's declared schema (Tier-2, issue #2350) is
  // validated/coerced in place and returned; only an UNCOERCIBLE off-schema
  // response synthesizes a schema/type `firstError` so it re-enters the SAME
  // cascade (with the identical noteFallback* reconciliation) below.
  let firstError;
  {
    let firstResult;
    try {
      // The local-endpoint concurrency gate lives INSIDE executeProviderRunOnce,
      // keyed on the EFFECTIVE provider after createRun's proactive swap — so a
      // remote/CLI primary that swaps to a local backend is still serialized.
      // Gating here on the requested provider would miss that swap (the gate
      // would no-op for a remote primary and the swapped-in local run would
      // dispatch ungated).
      firstResult = await executeProviderRunOnce(args);
    } catch (err) {
      firstError = err;
    }
    if (!firstError) {
      const validated = await correctResponseToSchema(firstResult, args);
      if (validated.ok) {
        // Either the response already matched the schema (return as-is) or a
        // deterministic in-place coercion recovered its shape (Tier-2, no retry).
        return validated.coerced
          ? { ...validated.result, fixTier: 2, fixStrategy: 'schema/type', coercedResponse: true }
          : validated.result;
      }
      firstError = buildSchemaFailureError(firstResult);
    }
  }

  return recoverProviderFailure(args, rawArgs, firstError);
}
