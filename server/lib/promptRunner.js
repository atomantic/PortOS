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

import { createRun, executeApiRun, executeCliRun, extractBakedModel, hasModelFlag, stopRun, patchRunMetadata } from '../services/runner.js';
import { getActiveProvider, getProviderById, getAllProviders } from '../services/providers.js';
import { executeTuiRun } from './tuiPromptRunner.js';
import { ServerError } from './errorHandler.js';
import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { analyzeError, ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';
import { isGenerationModel } from './localModelHeuristics.js';
import { getAIToolkitInstance } from './aiToolkitState.js';
import { createSingleFlight } from './singleFlight.js';

// The fallback-lifecycle notifiers live in services/autoFixer.js, which
// transitively pulls in services/cos.js (PM2 + fs + sockets). Importing it
// lazily on the failure path keeps anything that imports promptRunner.js from
// dragging the CoS stack along on the happy path. Node caches the module after
// the first dynamic import, so the cost is one-time.
function loadAutoFixer() {
  return import('../services/autoFixer.js');
}

export const DEFAULT_TIMEOUT_MS = 300000;
const APPEND_CHUNK = (acc, chunk) => acc + (typeof chunk === 'string' ? chunk : (chunk?.text || ''));

// ── Local-backend concurrency gate ─────────────────────────────────────────
// A local LLM server (Ollama / LM Studio on localhost) runs inference on one
// GPU. Firing N stage calls at it concurrently (e.g. the 3 parallel
// canon-extraction kinds) gains nothing — the backend serializes on the GPU
// regardless — and, if the backend is configured for parallelism
// (OLLAMA_NUM_PARALLEL > 1), it loads N model contexts at once and can spike
// VRAM into an OOM/thrash. Cloud HTTP and CLI/TUI providers have no such
// constraint. So we cap concurrent IN-FLIGHT calls per LOCAL endpoint and queue
// the rest (FIFO). Default 1 (serialize); a beefy box can lift it with
// LOCAL_LLM_MAX_CONCURRENCY. Keyed by endpoint so two distinct local servers
// still run in parallel with each other.
//
// The gate lives HERE (the actual execution layer) rather than at the
// stageRunner call site so it covers EVERY local execution: the initially
// selected provider, a proactive createRun swap, AND a runtime fallback that
// lands on a local backend after a remote/CLI primary fails. Gating only the
// outer stageRunner call missed the fallback path — a failure storm could still
// fire N concurrent calls at one local endpoint.
const LOCAL_ENDPOINT_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i;
export const isLocalEndpoint = (endpoint) =>
  typeof endpoint === 'string' && LOCAL_ENDPOINT_RE.test(endpoint.trim());

export const LOCAL_LLM_MAX_CONCURRENCY = Math.max(1, Number(process.env.LOCAL_LLM_MAX_CONCURRENCY) || 1);
const localEndpointGates = new Map(); // endpoint -> { active: number, queue: (()=>void)[] }

function acquireLocalSlot(endpoint) {
  let gate = localEndpointGates.get(endpoint);
  if (!gate) { gate = { active: 0, queue: [] }; localEndpointGates.set(endpoint, gate); }
  if (gate.active < LOCAL_LLM_MAX_CONCURRENCY) {
    gate.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => { gate.queue.push(resolve); });
}

function releaseLocalSlot(endpoint) {
  const gate = localEndpointGates.get(endpoint);
  if (!gate) return;
  const next = gate.queue.shift();
  if (next) next(); // hand the slot straight to the next waiter (active unchanged)
  else gate.active = Math.max(0, gate.active - 1);
}

// Run `fn` under the local-endpoint gate when `provider` is a local API backend;
// otherwise run it immediately (cloud / CLI / TUI are unconstrained).
export async function withLocalConcurrencyGate(provider, fn) {
  const endpoint = provider?.endpoint;
  if (!(provider?.type === PROVIDER_TYPES.API && isLocalEndpoint(endpoint))) return fn();
  await acquireLocalSlot(endpoint);
  try {
    return await fn();
  } finally {
    releaseLocalSlot(endpoint);
  }
}

// Cooldown per error category — how long the failed provider is marked
// unavailable so subsequent calls skip it and proactively use the fallback.
// USAGE_LIMIT is absent because `markUsageLimit` parses the wait time
// from the error body (e.g. "resets 5pm"). Values target the timescale
// the user can plausibly recover the underlying cause:
//   RATE_LIMIT      — 5m: provider-side counter typically clears in minutes
//   AUTH_ERROR      — 15m: usually a config issue that needs human action
//   MODEL_NOT_FOUND — 30m: also config; longer because retry is unlikely
//   QUOTA_EXCEEDED  — 60m: billing/credits; retry sooner is futile
//   NETWORK_ERROR   — 2m: usually a transient hiccup
//   TIMEOUT/UNKNOWN — 1m: short enough to retry, long enough to skip
//                     while the immediate workload retries via fallback
const COOLDOWN_MS_BY_CATEGORY = {
  [ERROR_CATEGORIES.RATE_LIMIT]: 5 * 60 * 1000,
  [ERROR_CATEGORIES.AUTH_ERROR]: 15 * 60 * 1000,
  [ERROR_CATEGORIES.MODEL_NOT_FOUND]: 30 * 60 * 1000,
  [ERROR_CATEGORIES.QUOTA_EXCEEDED]: 60 * 60 * 1000,
  [ERROR_CATEGORIES.NETWORK_ERROR]: 2 * 60 * 1000,
  [ERROR_CATEGORIES.TIMEOUT]: 60 * 1000,
  [ERROR_CATEGORIES.UNKNOWN]: 60 * 1000,
};
const DEFAULT_COOLDOWN_MS = 60 * 1000;

/**
 * Returns true when the runner+provider pair will actually honor a
 * per-call `model` override. For API providers the model is a
 * first-class arg to `executeApiRun`. For CLI/TUI providers,
 * `runner.js#buildCliArgs` / `tuiHandshake.js#buildTuiInvocation`
 * translate the resolved `defaultModel` into a `--model`/`-m` flag — BUT
 * only when the user hasn't already baked a model flag into `provider.args`.
 * If a flag is baked in, the runner-injected one is suppressed and the
 * args-baked model wins; so claim "doesn't honor" for that case to keep
 * the run-record honest.
 */
export const providerHonorsModelOverride = (provider) => (
  provider?.type === PROVIDER_TYPES.API
  || ((provider?.type === PROVIDER_TYPES.CLI || provider?.type === PROVIDER_TYPES.TUI) && !hasModelFlag(provider?.args))
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
    // A stale config can leave an embedding-only id in callerModel/defaultModel
    // (the UI only hides+clears embedding models when the provider is edited);
    // skip those so an unchanged older provider can't route a generation/fallback
    // run to e.g. nomic-embed-text. Falls through to the first generation model.
    return firstNonEmbedding(callerModel, provider?.defaultModel)
      || firstGenerationModel(provider) || null;
  }
  // Non-honoring CLI/TUI path: args-baked model id wins over defaultModel.
  const baked = (provider?.type === PROVIDER_TYPES.CLI || provider?.type === PROVIDER_TYPES.TUI) && hasModelFlag(provider?.args)
    ? extractBakedModel(provider.args)
    : null;
  return firstNonEmbedding(baked, provider?.defaultModel)
    || firstGenerationModel(provider) || null;
}

/**
 * First of the given candidate model ids that is a usable generation model
 * (skips null/empty and embedding-only ids). Returns null when none qualify, so
 * callers can fall through to `firstGenerationModel(provider)`.
 */
function firstNonEmbedding(...candidates) {
  return candidates.find((m) => m && isGenerationModel(m)) || null;
}

/**
 * First model in `provider.models` usable for generation (skips embedding-only
 * models). Without this, a local provider whose `models[0]` is an embedding
 * model (e.g. Ollama with `nomic-embed-text:latest` listed first and a null
 * defaultModel) would resolve the embedding model for a chat/fallback run and
 * fail — the exact nomic-embed-text fallback bug. Falls back to `models[0]`
 * only when every listed model looks like an embedding model (better to try
 * something than resolve null).
 */
function firstGenerationModel(provider) {
  const models = provider?.models || [];
  return models.find((m) => m && isGenerationModel(m)) || models[0] || null;
}

/**
 * Tier-1 (config/env) deterministic fix for a `model-not-found` /
 * `model-not-supported` failure (issue #2342): the request named a model id the
 * (reachable) provider doesn't serve, so pick a DIFFERENT valid generation
 * model that the provider DOES list and retry the SAME provider with it —
 * cheaper than benching the provider and switching to a fallback (Tier 3).
 *
 * Pure — no I/O. Returns null (⇒ Tier 1 declines, cascade falls through) when:
 *   - the provider carries no enumerable `models` list (nothing to correct to), OR
 *   - the only listed models are the failed one and/or embedding-only ids.
 *
 * The failed id is excluded so we never re-issue the same broken request, and
 * embedding-only ids are skipped (mirrors `firstGenerationModel`) so a
 * generation call can't get corrected onto e.g. `nomic-embed-text`.
 *
 * @param {object} provider
 * @param {string} [failedModel] — the model id that just failed model-not-found
 * @returns {string|null}
 */
export function pickConfigCorrectedModel(provider, failedModel) {
  const models = provider?.models;
  if (!Array.isArray(models)) return null;
  return models.find((m) => m && m !== failedModel && isGenerationModel(m)) || null;
}

/**
 * Resolve `{provider, selectedModel}` for an LLM caller. Prefers
 * `providerId` — any `getProviderById` failure (stale id, lookup
 * error, network blip) falls through to `getActiveProvider`. Returns
 * `{provider: null, selectedModel: null}` when neither resolves a
 * provider (e.g. no providers configured), so callers throw their own
 * typed error.
 *
 * Note: errors from `getActiveProvider` (e.g. toolkit not initialized)
 * still propagate — only `getProviderById` failures are swallowed.
 * This mirrors the inline pattern this helper replaced. If a caller
 * wants total "always-null on failure" semantics, wrap the call in
 * their own try/catch.
 *
 * @param {object} args
 * @param {string} [args.providerId]
 * @param {string} [args.model]
 * @returns {Promise<{ provider: object|null, selectedModel: string|null }>}
 */
export async function resolveProviderAndModel({ providerId, model } = {}) {
  let provider = providerId ? await getProviderById(providerId).catch(() => null) : null;
  if (!provider) provider = await getActiveProvider();
  const selectedModel = provider ? resolveEffectiveModel(provider, model) : null;
  return { provider, selectedModel };
}

/**
 * Throw a typed "no AI provider available" error when `provider` is falsy.
 *
 * Sites that surface to HTTP route handlers should pass `code` (+ optional
 * `status`, defaults to 503) so the centralized error middleware emits a
 * structured response. Sites that are internal-only (service-to-service)
 * can omit both and get a plain `Error` — matching the legacy shape.
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
 * Guard a vision run against a silent fallback to a non-API provider.
 *
 * Vision only works on the API path (executeApiRun base64-inlines images);
 * CLI/TUI providers drop the images and return a completion hallucinated from
 * the text prompt alone. `runPromptThroughProvider` can swap the provider two
 * ways — a proactive swap inside createRun (`result.provider`) or a retry
 * fallback after failure (`result.fallbackProvider`) — so the provider that
 * ACTUALLY ran is the first of those, else the requested one. Throw
 * VISION_FALLBACK_DROPPED_IMAGES when it isn't an API provider so callers don't
 * report image-grounded output that was really text-only.
 *
 * Returns the provider that ran so callers can read its id/type.
 *
 * @param {object} result — the runPromptThroughProvider result
 * @param {object} requestedProvider — the provider the caller asked to run
 * @returns {object} the effective provider that ran
 */
export function assertVisionRunUsedImages(result, requestedProvider) {
  const ran = result?.provider || result?.fallbackProvider || requestedProvider;
  if (ran?.type && ran.type !== 'api') {
    // Name both providers so the cause is actionable. The usual trigger is a
    // proactive/retry swap because the requested API provider is in a temporary
    // cooldown (e.g. a prior model-not-found benched it for several minutes) —
    // NOT that the user picked a non-vision provider. Point them at the real fix.
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
 *   provider doesn't honor it (claude-code, antigravity-cli today).
 * @param {string} [args.runId]  — caller-supplied run id (skip createRun
 *   round-trip when the caller has already created the run)
 * @param {(chunk: string) => void} [args.onData] — incremental stream
 *   callback; receives each output chunk as it arrives. Useful for live
 *   progress UI (loops, live transcripts). Does NOT change the resolved
 *   `text` value — callers receive the full buffered text either way.
 *   For TUI providers the stripped chunks are emitted; the final `text`
 *   is the cleaned response with the prompt-echo elided.
 * @param {string[]} [args.screenshots] — image paths for a vision/multimodal
 *   call (relative to the runner's screenshots dir, or absolute). API providers
 *   only: the toolkit's executeApiRun base64-encodes each and sends them as
 *   `image_url` content blocks ahead of the prompt text. CLI/TUI providers
 *   ignore them (no vision path), so callers needing vision must resolve an
 *   API provider up front. On a fallback to a non-API provider the images are
 *   silently dropped — the fallback only fires after the primary API call has
 *   already failed.
 * @param {number} [args.timeout] — per-call timeout in ms; falls back to
 *   `provider.timeout`, then DEFAULT_TIMEOUT_MS. Callers like the loop
 *   runner expose a user-configurable timeout that isn't a provider attr.
 * @param {string} [args.cwd] — working directory for the spawned process.
 *   Defaults to `process.cwd()`. Callers that run AI against external
 *   directories (loops with `loop.cwd`, pm2Standardizer with a repo path)
 *   must pass this — without it, the CLI/TUI spawn lands in PortOS's own
 *   cwd and the analysis runs against the wrong files. No-op for API
 *   providers (no spawn).
 * @returns {Promise<{ text: string, runId: string, model: string|null, provider: object, usedFallback?: boolean, fixTier?: number, fixStrategy?: string, fallbackFrom?: { id: string, name: string }, fallbackProvider?: object }>}
 *   — `model` is the resolved model that actually executed (null when
 *   neither override nor provider.defaultModel applies). `provider` is the
 *   provider object that actually ran, reflecting createRun's proactive swap
 *   (read this to detect a proactive fallback; `usedFallback`/`fallbackProvider`
 *   only cover the retry-fallback path). `runId` always
 *   points to the run record that *actually* ran — on fallback recovery
 *   this is the fresh fallback runId, NOT the failed primary's. When
 *   `usedFallback` is true, `fallbackFrom` identifies the failed primary
 *   and `fallbackProvider` is the full provider object that actually ran
 *   (so callers persisting run attribution can write the correct
 *   providerId without re-picking the fallback themselves). `fixTier` /
 *   `fixStrategy` (issue #2342) record WHICH fallback tier recovered the
 *   failure — `1`/`'config/env'` when a same-provider model correction
 *   recovered it, `3`/`'constrained-agent-retry'` for a fallback-provider
 *   retry — so callers can log/attribute the deterministic recovery path.
 */
export async function runPromptThroughProvider(args) {
  // Validate inputs up front so an accidentally-null `provider` (or one
  // missing `id`/`type`) surfaces a clear error here instead of throwing
  // a downstream TypeError on `provider.id` inside createRun or on the
  // provider.type dispatch below.
  if (!args?.provider || typeof args.provider !== 'object') {
    throw new Error('runPromptThroughProvider: provider is required');
  }
  if (typeof args.provider.id !== 'string' || !args.provider.id) {
    throw new Error('runPromptThroughProvider: provider.id must be a non-empty string');
  }
  if (args.provider.type !== PROVIDER_TYPES.CLI && args.provider.type !== PROVIDER_TYPES.API && args.provider.type !== PROVIDER_TYPES.TUI) {
    throw new Error(`Unsupported provider type: ${args.provider.type}`);
  }
  if (typeof args.prompt !== 'string' || !args.prompt.length) {
    throw new Error('runPromptThroughProvider: prompt must be a non-empty string');
  }
  if (typeof args.source !== 'string' || !args.source.length) {
    throw new Error('runPromptThroughProvider: source must be a non-empty string');
  }

  try {
    // The local-endpoint concurrency gate lives INSIDE executeProviderRunOnce,
    // keyed on the EFFECTIVE provider after createRun's proactive swap — so a
    // remote/CLI primary that swaps to a local backend is still serialized.
    // Gating here on the requested provider would miss that swap (the gate
    // would no-op for a remote primary and the swapped-in local run would
    // dispatch ungated).
    return await executeProviderRunOnce(args);
  } catch (firstError) {
    // Only retry when the failure came from the execution layer (annotated
    // by safeReject with effectiveProvider). Pre-execution throws —
    // createRun rejecting on a disk error / disabled provider / unsupported
    // type — never fire the AI_PROVIDER_EXECUTION_FAILED hook, so there's
    // no deferred investigation task to suppress and marking the provider
    // unavailable would punish it for a disk/config problem. Rethrow
    // those as-is so the caller sees the original error.
    if (!firstError?.effectiveProvider) {
      throw stripFallbackContext(firstError);
    }

    // The runner already wrote a failed metadata.json and the onRunFailed
    // hook in server/index.js queued a deferred investigation task keyed on
    // (providerName, model). We now walk the deterministic fallback cascade
    // (issue #2342), attempting the CHEAPEST tier that can plausibly recover
    // the failure and escalating to the queued investigation task (Tier 4)
    // only when every deterministic tier declines or fails:
    //   Tier 1 config/env  — retry the SAME provider with a valid model
    //                         (deterministic; no persisted config change)
    //   Tier 2 schema/type  — no safe same-provider transform at this layer
    //                         (a malformed request/response can't be rewritten
    //                         without the caller's schema) → falls through
    //   Tier 3 constrained-agent-retry — bounded retry via a fallback provider
    //   Tier 4 escalate     — the deferred investigation task the hook queued
    //
    // `failed` is the provider that ACTUALLY ran — usually equals
    // args.provider, but createRun may have proactively swapped to a
    // different fallback if the requested primary was already marked
    // unavailable. Always dedupe against what actually ran so the
    // task-suppression notifiers cancel the right queued task.
    const failed = firstError.effectiveProvider;
    const failedModel = firstError.effectiveModel || resolveEffectiveModel(failed, args.model);
    const category = firstError.errorAnalysis?.category;
    // The primary's queued investigation task is keyed on (providerName, model).
    // Every tier that retries suppresses this key up front so a slow retry
    // (a CLI fallback can take 20–30s) can't outrun the backstop timer
    // (autoFixer.TASK_DEFER_MS) and leave a task behind for a recovered failure.
    const primaryKey = { provider: failed.name || failed.id, model: failedModel };

    // Load the fallback-lifecycle notifiers lazily and once for the whole
    // cascade. Lazy (see loadAutoFixer) so the happy path never drags in the
    // CoS stack — and so a failure with NO recovery path (no tier applies)
    // never loads it either, since none of the note* helpers below fire.
    let autoFixerModule;
    let autoFixerLoaded = false;
    const getAutoFixer = async () => {
      if (!autoFixerLoaded) {
        autoFixerLoaded = true;
        autoFixerModule = await loadAutoFixer().catch((err) => {
          console.error(`❌ autoFixer load failed (investigation task not suppressed): ${err.message}`);
          return null;
        });
      }
      return autoFixerModule;
    };
    // Keys must match what server/index.js's onRunFailed hook published
    // (metadata.providerName + metadata.model). Best-effort throughout: a
    // notifier failure must never turn a working retry into a user-visible error.
    const noteStarted = async (key) => { const a = await getAutoFixer(); try { a?.noteFallbackStarted(key); } catch { /* best-effort */ } };
    const noteFailed = async (key) => { const a = await getAutoFixer(); try { a?.noteFallbackFailed(key); } catch { /* best-effort */ } };
    const noteHandled = async (key) => {
      const a = await getAutoFixer();
      try { a?.noteFallbackHandled(key); } catch (suppressErr) {
        console.error(`❌ noteFallbackHandled failed (investigation task not suppressed): ${suppressErr.message}`);
      }
    };

    // ── Tier 1 — config/env correction (issue #2342) ─────────────────────────
    // A model-not-found/model-not-supported failure is request-specific: the
    // provider is reachable but doesn't serve the requested model id. Before
    // escalating to a whole-provider fallback (Tier 3), attempt the cheapest
    // deterministic fix — retry the SAME provider with a valid model it lists.
    // No config is persisted; on success the user's own provider keeps serving.
    let tier1CorrectedKey = null;
    // Only a wrong-model failure is config-correctable here. Compare against
    // string literals, not `ERROR_CATEGORIES.MODEL_NOT_SUPPORTED` — that member
    // does NOT exist (it would be `undefined`, matching a category-less failure
    // and wrongly engaging Tier 1). 'model-not-supported' is autoFixer's own
    // Tier-1 category (from CoS agent analysis), matched here for parity.
    if (category === ERROR_CATEGORIES.MODEL_NOT_FOUND || category === 'model-not-supported') {
      const correctedModel = pickConfigCorrectedModel(failed, failedModel);
      if (correctedModel) {
        console.log(`🔧 Tier 1 (config/env) retry: ${args.source} on ${failed.name} with model ${correctedModel} (requested ${failedModel} → ${category})`);
        // Suppress the primary's investigation task while the corrected retry
        // runs; released in the give-up branch below if the cascade fails out.
        await noteStarted(primaryKey);
        tier1CorrectedKey = { provider: failed.name || failed.id, model: correctedModel };
        let tier1Result;
        try {
          tier1Result = await executeProviderRunOnce({
            ...args,
            provider: failed,
            model: correctedModel,
            runId: undefined, // fresh run so the failed primary's record stays intact
          });
        } catch (tier1Error) {
          // The corrected retry ALSO failed — its own onRunFailed queued a task
          // keyed on tier1CorrectedKey. Fall through to Tier 3: that task
          // survives as the escalation if nothing recovers, and is cancelled
          // below if a later tier does.
          console.log(`↪️ Tier 1 correction failed on ${failed.name} (${correctedModel}): ${tier1Error.message} — escalating to constrained-agent-retry`);
        }
        if (tier1Result) {
          await noteHandled(primaryKey);
          return {
            ...tier1Result,
            usedFallback: true,
            fixTier: 1, // FIX_TIERS.CONFIG_ENV (mirrored; kept decoupled from the lazy autoFixer import)
            fixStrategy: 'config/env',
            fallbackFrom: { id: failed.id, name: failed.name },
            fallbackProvider: failed,
          };
        }
      }
    }

    // ── Tier 3 — constrained-agent-retry via a fallback provider ─────────────
    // Coalesce the per-provider mark-and-pick during an N-way failure storm:
    // the 2nd…Nth simultaneous failure for the same provider awaits the first's
    // result instead of independently re-reading providers.json
    // (pickFallbackProvider) and re-writing provider-status.json
    // (markUnavailable). The fallback *run* below is NOT coalesced — each failed
    // call still executes its own fallback to get its own result.
    const picked = await coalesceFallbackMarkAndPick(failed, firstError);
    if (!picked) {
      // ── Tier 4 — escalate ──: no recovery path left. Release any Tier-1
      // suppression so the primary key doesn't leak in the in-flight set (the
      // corrected retry's own task, if any, still surfaces as the escalation).
      if (tier1CorrectedKey) await noteFailed(primaryKey);
      throw stripFallbackContext(firstError);
    }
    const fallback = picked.provider;

    console.log(`⚡ Tier 3 (constrained-agent-retry): ${args.source} with fallback ${fallback.name} (primary ${failed.name} failed: ${firstError.message})`);

    // Re-suppress the primary key (idempotent) for the fallback run.
    await noteStarted(primaryKey);

    // Run the fallback as a fresh attempt. Pass the configured `fallbackModel`
    // when one is set (so the user's chosen fallback provider+model pair is
    // honored); otherwise `undefined` lets the fallback pick its own default.
    // Either way we never inherit the primary's model id, which usually
    // doesn't exist on the fallback.
    let fallbackResult;
    try {
      // The fallback is gated inside executeProviderRunOnce on its effective
      // provider, so a fail-over that lands on a local backend still serializes
      // against that endpoint (the failure-storm case) — with no double-gate
      // (wrapping here too would deadlock at MAX_CONCURRENCY=1).
      fallbackResult = await executeProviderRunOnce({
        ...args,
        provider: fallback,
        model: picked.model ?? undefined,
        runId: undefined, // fresh runId so the failed primary's record stays intact
      });
    } catch (fallbackError) {
      // ── Tier 4 — escalate ──: every deterministic tier failed. Release the
      // primary's suppression (the fallback provider's own failure already
      // queued its investigation task) and rethrow. Any Tier-1 corrected-retry
      // task is intentionally left in place — one investigation task per
      // genuinely-failed attempt is the intended escalation.
      await noteFailed(primaryKey);
      throw stripFallbackContext(fallbackError);
    }

    // Fallback succeeded — clear the primary's suppression so the user doesn't
    // see a noisy "investigate" entry in their plan for a failure that was
    // auto-recovered.
    await noteHandled(primaryKey);
    // A Tier-1 corrected retry that failed before this recovery left its own
    // deferred task; cancel it too so a fully-recovered action creates ZERO
    // investigation tasks (issue #2342 acceptance: only UNRECOVERED failures
    // escalate to Tier 4).
    if (tier1CorrectedKey) await noteHandled(tier1CorrectedKey);

    return {
      ...fallbackResult,
      usedFallback: true,
      fixTier: 3, // FIX_TIERS.CONSTRAINED_RETRY
      fixStrategy: 'constrained-agent-retry',
      fallbackFrom: { id: failed.id, name: failed.name },
      fallbackProvider: fallback,
    };
  }
}

// In-flight mark-and-pick work, keyed by the failed provider id. During an
// N-way failure storm (one stuck provider, many simultaneous in-flight
// calls) every failure would otherwise independently re-read providers.json
// (pickFallbackProvider) and re-write provider-status.json (markUnavailable).
// Sharing the first failure's promise collapses that to a single read +
// single write. The slot clears as soon as it settles, so a genuinely new
// failure after the storm re-picks against fresh provider status.
const _fallbackMarkAndPick = createSingleFlight();

/**
 * Mark the failed provider unavailable and pick its fallback, coalescing
 * concurrent calls for the same provider id onto one shared promise.
 * Resolves to the same `{ provider, model }` shape as `pickFallbackProvider`
 * (or null when no usable fallback exists). The mark is skipped when no
 * fallback is available — matching the prior ordering where the original
 * error is rethrown without benching a provider that has no recovery path.
 *
 * @param {object} failed — the provider that actually ran and failed
 * @param {Error} firstError — the execution error (carries message + errorAnalysis)
 * @returns {Promise<{ provider: object, model: string|null }|null>}
 */
function coalesceFallbackMarkAndPick(failed, firstError) {
  return _fallbackMarkAndPick.run(failed.id, async () => {
    const picked = await pickFallbackProvider(failed);
    if (!picked) return null;
    await markProviderUnavailableFromError(failed, firstError.message, firstError.errorAnalysis).catch(err => {
      console.error(`❌ markUnavailable failed for ${failed.id}: ${err.message}`);
    });
    return picked;
  });
}

/**
 * Pick a fallback provider for `failed`. Honors the failed provider's
 * `fallbackProvider` field first, then the toolkit's system priority
 * list. Returns `{ provider, model }` (or null when no usable fallback
 * exists). `model` is the configured `fallbackModel` hint for the chosen
 * fallback (null for system-priority picks, meaning "use the fallback's
 * own default") — never the failed provider's model.
 *
 * The toolkit's `getFallbackProvider` reads `providers[failed.id]` to
 * look up the `fallbackProvider` field, so the primary MUST stay in the
 * map. Self-loop protection (`fallbackProvider === self`) lives in
 * `getFallbackProvider`; the system priority loop already excludes
 * `failed.id` by construction.
 */
async function pickFallbackProvider(failed) {
  const toolkit = getAIToolkitInstance();
  const providerStatus = toolkit?.services?.providerStatus;
  if (!providerStatus) return null;

  const all = await getAllProviders().catch(() => null);
  if (!all?.providers) return null;
  const providersMap = {};
  for (const p of all.providers) providersMap[p.id] = p;

  const picked = providerStatus.getFallbackProvider(failed.id, providersMap);
  if (!picked?.provider) return null;
  return { provider: picked.provider, model: picked.model ?? null };
}

/**
 * Translate the runner's failure into an availability marker on the
 * failed provider. Reuses the runner's precomputed error analysis when
 * present, otherwise falls back to analyzeError to categorize and pick a
 * cooldown; usage-limit failures route through `markUsageLimit` so the
 * parsed wait time (e.g. "reset 5pm") is honored.
 *
 * Skips the mark when the toolkit's `executeApiRun` has already marked
 * the provider unavailable inline (it does this for RATE_LIMIT and
 * USAGE_LIMIT before firing onComplete) — re-marking would double-
 * increment `failureCount` and re-write the status file for no gain.
 */
async function markProviderUnavailableFromError(failed, errorMessage, runnerAnalysis) {
  const toolkit = getAIToolkitInstance();
  const providerStatus = toolkit?.services?.providerStatus;
  if (!providerStatus) return;
  if (!providerStatus.isAvailable(failed.id)) return;

  const analysis = runnerAnalysis && typeof runnerAnalysis === 'object'
    ? runnerAnalysis
    : analyzeError(errorMessage || '');
  const category = analysis?.category || ERROR_CATEGORIES.UNKNOWN;

  // A content/safety refusal is prompt-specific, not a provider outage — the
  // provider is healthy and other prompts still work. Don't bench it (which
  // would route every subsequent task to the fallback for a full cooldown);
  // this single call still falls back via the caller's retry path.
  //
  // A model-not-found is REQUEST-specific the same way: the request named a
  // model id the (reachable) endpoint doesn't have — a bad caller/config model,
  // not the provider being down. Benching the whole provider would take its
  // OTHER valid models offline for the full cooldown (e.g. one bad
  // `codex-configured-default` vision call benching Ollama so a correct
  // `qwen2.5vl` call then proactively swaps to a non-vision fallback). The
  // single failing call still falls back via the retry path; the provider stays
  // available for its working models. A genuine endpoint outage surfaces as
  // NETWORK_ERROR, not MODEL_NOT_FOUND, so it is still benched.
  if (category === ERROR_CATEGORIES.CONTENT_REFUSAL || category === ERROR_CATEGORIES.MODEL_NOT_FOUND) return;

  if (category === ERROR_CATEGORIES.USAGE_LIMIT) {
    await providerStatus.markUsageLimit(failed.id, {
      message: analysis.message || errorMessage,
      waitTime: analysis.waitTime,
    });
    return;
  }

  const waitTimeMs = COOLDOWN_MS_BY_CATEGORY[category] ?? DEFAULT_COOLDOWN_MS;
  await providerStatus.markUnavailable(failed.id, {
    reason: category,
    message: analysis?.message || errorMessage || `Provider ${failed.name || failed.id} failed`,
    waitTimeMs,
  });
}

// Strip the fallback-context fields off an error before rethrowing so
// callers don't see internal metadata they didn't ask for. The
// `.effectiveProvider`/`.effectiveModel` annotations exist solely for
// runPromptThroughProvider's retry path.
function stripFallbackContext(err) {
  if (err && typeof err === 'object') {
    delete err.effectiveProvider;
    delete err.effectiveModel;
  }
  return err;
}

/**
 * Inner helper: execute one attempt against `args.provider`. Returns
 * { text, runId, model } on success. On failure, throws an Error with
 * `effectiveProvider` and `effectiveModel` attached so the retry path
 * knows which provider actually ran (createRun may have proactively
 * swapped to a fallback when the requested provider was already marked
 * unavailable).
 */
async function executeProviderRunOnce({ provider, prompt, source, model, runId: callerRunId, onData: onDataCallback, timeout: timeoutOverride, cwd: cwdOverride, screenshots = [] }) {
  // Resolve the model that'll actually run BEFORE creating the run record
  // so the record reflects reality. resolveEffectiveModel handles both
  // the override-honored fallback chain AND the args-baked-CLI case
  // (extract the args-pinned model id rather than logging defaultModel).
  let effectiveProvider = provider;
  let effectiveModel = resolveEffectiveModel(effectiveProvider, model);
  // `??` only catches null/undefined; an empty-string override would leak
  // through to spawn() and resolve to `/`. Match tuiPromptRunner.js's
  // string-truthy gate so an empty override falls back to process.cwd().
  const effectiveCwd = (typeof cwdOverride === 'string' && cwdOverride) ? cwdOverride : process.cwd();

  // Some call sites (stageRunner, loops) create the run themselves so
  // they can log the runId before the LLM call starts. When provided,
  // reuse it. Otherwise create one here so callers always get a runId
  // back. Pass `workspacePath` so /runs metadata reflects the directory
  // the spawn ran in.
  //
  // When we create the run ourselves, capture the FULL result — the
  // toolkit's createRun may switch to a fallback provider when the
  // requested one is unavailable (providerStatusService), and
  // `runResult.provider` is the effective provider after that switch.
  // Dispatch must use the fallback (otherwise we'd execute against the
  // unavailable provider while the run record claims the fallback ran)
  // and `effectiveModel` must be re-resolved against the fallback's
  // defaults so the response value reflects what actually ran.
  let runId = callerRunId;
  if (!runId) {
    const runResult = await createRun({
      providerId: provider.id,
      model: effectiveModel,
      prompt,
      source,
      workspacePath: effectiveCwd,
    });
    runId = runResult.runId;
    if (runResult.provider && runResult.provider.id !== provider.id) {
      effectiveProvider = runResult.provider;
      // Re-resolve against the FALLBACK provider using the configured
      // `fallbackModel` createRun surfaced — NOT the caller's `model`, which
      // was resolved against the (now-benched) primary and almost never
      // exists on the fallback. Forwarding it is the leak that sent
      // `codex-configured-default` to LM Studio (mirrors stageRunner.js).
      effectiveModel = resolveEffectiveModel(effectiveProvider, runResult.fallbackModel ?? null);
      // createRun persisted `metadata.model = effectiveModel || provider.defaultModel`
      // using the ORIGINAL provider's resolved value — so /runs would
      // attribute a model that doesn't belong to the fallback (e.g. an
      // API model id recorded on a CLI fallback). Await the patch so a
      // fast-failing run can't fire onRunFailed with stale model/provider
      // info — `noteFallbackHandled` keys on metadata.providerName +
      // metadata.model and would miss if the patch hadn't landed yet.
      await patchRunMetadata(runId, {
        model: effectiveModel,
        providerId: effectiveProvider.id,
        providerName: effectiveProvider.name,
      }).catch(() => { /* best-effort; metadata patch is not load-bearing */ });
    }
  }

  // Compute timeout AFTER the possible fallback switch so it reflects
  // the provider that actually runs — providers can have wildly different
  // `timeout` settings (a 5-min CLI vs a 30-s API), and using the
  // original provider's timeout against a fallback would either time out
  // a still-working run early or let a stuck one hang past its
  // intended cap.
  const effectiveTimeout = timeoutOverride ?? effectiveProvider?.timeout ?? DEFAULT_TIMEOUT_MS;

  // Gate concurrent in-flight calls to a LOCAL endpoint on the EFFECTIVE
  // provider — the one that ACTUALLY runs after createRun's proactive swap
  // (above) and any retry-fallback. This is the single chokepoint the
  // module comment promises: gating the *requested* provider at the call
  // site missed a remote/CLI primary that swaps/fails over to a local
  // backend, defeating the VRAM/OOM serialization. No-op for cloud/CLI/TUI.
  return withLocalConcurrencyGate(effectiveProvider, () => new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    let apiTimeoutHandle = null;

    const safeResolve = (value) => { if (!settled) { settled = true; if (apiTimeoutHandle) clearTimeout(apiTimeoutHandle); resolve(value); } };
    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      if (apiTimeoutHandle) clearTimeout(apiTimeoutHandle);
      // Annotate so runPromptThroughProvider's retry path knows which
      // provider actually ran (createRun may have swapped to a fallback
      // before this attempt) and which model is the dedupe key for
      // suppressing the queued investigation task on a successful retry.
      if (err && typeof err === 'object') {
        err.effectiveProvider = effectiveProvider;
        err.effectiveModel = effectiveModel;
      }
      reject(err);
    };

    // TUI runs discard `text` and use `result.text` from executeTuiRun (see
    // onComplete below), so the per-chunk APPEND_CHUNK concat is pure waste —
    // TUI streams can emit hundreds of KB of screen redraws per run.
    const isTui = effectiveProvider.type === PROVIDER_TYPES.TUI;
    const onData = (chunk) => {
      if (!isTui) text = APPEND_CHUNK(text, chunk);
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
        const err = new Error(result?.error || `${labelByType[effectiveProvider.type] || effectiveProvider.type} execution failed`);
        if (result?.errorAnalysis && typeof result.errorAnalysis === 'object') {
          err.errorAnalysis = result.errorAnalysis;
        }
        safeReject(err);
      } else {
        // TUI runs do their own cleanup inside executeTuiRun (preferring
        // the response file the model was directed to write, falling back
        // to cleanTuiResponse on the screen scrape). Trust `result.text`
        // — the accumulated `text` here is the raw chrome-laden stream.
        const finalText = effectiveProvider.type === PROVIDER_TYPES.TUI
          ? (typeof result?.text === 'string' ? result.text : '')
          : text;
        // Report the provider that ACTUALLY ran. `effectiveProvider` reflects
        // createRun's proactive swap (when the requested provider was already
        // benched) — distinct from the retry-fallback path, which the outer
        // runPromptThroughProvider annotates separately. Callers that care
        // about the effective provider's type (e.g. vision, which only works
        // on API providers) must read this, since a proactive swap leaves
        // `usedFallback`/`fallbackProvider` unset.
        safeResolve({ text: finalText, runId, model: effectiveModel, provider: effectiveProvider });
      }
    };

    // executeCliRun / executeTuiRun both read `provider.defaultModel` for
    // arg construction AND the run-started metadata hook. Hand them a
    // clone with effectiveModel pinned so a per-call model override
    // actually picks up (and the hook reports the right model). The
    // guard skips the clone when effectiveModel already equals
    // provider.defaultModel — typical for non-codex CLI providers where
    // resolveEffectiveModel falls through to defaultModel anyway.
    const providerForRun = effectiveModel && effectiveModel !== effectiveProvider.defaultModel
      ? { ...effectiveProvider, defaultModel: effectiveModel }
      : effectiveProvider;

    if (effectiveProvider.type === PROVIDER_TYPES.CLI) {
      executeCliRun({ runId, provider: providerForRun, prompt, workspacePath: effectiveCwd, onData, onComplete, timeout: effectiveTimeout }).catch(safeReject);
    } else if (effectiveProvider.type === PROVIDER_TYPES.API) {
      // API runs take model as a first-class arg — no clone needed. The
      // toolkit's executeApiRun uses AbortController without a timer, so
      // we enforce the per-call timeout here: if it fires before
      // onComplete, reject with the same timeout shape CLI/TUI use and
      // attempt to stop the run. Without this guard, API callers that
      // used to enforce timeouts via fetchWithTimeout / AbortSignal.timeout
      // (meatspacePostLlm, pm2Standardizer, brain) regress to hanging
      // indefinitely on a stuck endpoint.
      apiTimeoutHandle = setTimeout(() => {
        stopRun(runId).catch(() => { /* best-effort cancel */ });
        safeReject(new Error(`API execution timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      executeApiRun({ runId, provider: effectiveProvider, model: effectiveModel, prompt, workspacePath: effectiveCwd, screenshots: Array.isArray(screenshots) ? screenshots : [], onData, onComplete }).catch(safeReject);
    } else if (effectiveProvider.type === PROVIDER_TYPES.TUI) {
      // `source` (e.g. 'pipeline-manuscript-completeness') labels the live,
      // interactive view this TUI run surfaces in the Shell page.
      executeTuiRun({ runId, provider: providerForRun, prompt, workspacePath: effectiveCwd, onData, onComplete, timeout: effectiveTimeout, label: source }).catch(safeReject);
    } else {
      safeReject(new Error(`Unsupported provider type: ${effectiveProvider.type}`));
    }
  }));
}
