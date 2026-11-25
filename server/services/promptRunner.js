import { EXECUTION_OPTIONS_ERROR, resolveExecutionOptions } from '../lib/executionOptions.js';
import { isLoopbackEndpoint } from '../lib/localEndpoint.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
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

import { withLocalConcurrencyGate } from '../lib/localLlmConcurrency.js';
import { isVisionCapableCodexTuiProvider } from '../lib/codex.js';
import { createRun, executeApiRun, executeCliRun, extractBakedModel, hasModelFlag, stopRun, patchRunMetadata, finalizeRunRecord } from './runner.js';
import { getActiveProvider, getProviderById, getAllProviders } from './provider/providers.js';
import { isCompositeProviderId } from '../lib/provider/providerRef.js';
import { peekFallbackChain } from '../lib/provider/providerFallbackChainCache.js';
// `./tuiPromptRunner.js` (drags node-pty in via `./shell.js`) and `./provider/providerExecutionReadiness.js`
// are imported lazily on the branches that execute a run: ~160 suites only build or classify runs.
import { ServerError } from '../lib/errorHandler.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { analyzeError, ERROR_CATEGORIES, isRunCanceledError, isRuntimeBudgetError, isContentRefusalError } from '../lib/aiToolkit/errorDetection.js';
import { isSchemaTypeCategory, resolveProviderBench } from '../lib/provider/providerCooldown.js';
import { isGenerationModel, isVisionCapableCliProvider } from '../lib/localModelHeuristics.js';
import { contextWindowRejection, knownContextWindow } from '../lib/aiToolkit/providerStatus.js';
import { isOllamaBackedProvider } from '../lib/aiToolkit/internal/ollamaBacked.js';
import { hasLocalRuntimeMarker } from '../lib/aiToolkit/internal/localRuntimeMarkers.js';
import { apiRunAbsoluteTimeoutMs } from '../lib/aiToolkit/internal/runTimeouts.js';
import { withOllamaRuntimeContextWindow } from '../lib/ollamaContext.js';
import { getAIToolkitInstance } from '../lib/aiToolkitState.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { extractJson } from '../lib/jsonExtract.js';
import { isCreativeRunSource, withCreativeLatitude } from '../lib/creativeLatitude.js';
import { DEFAULT_OUTPUT_RESERVE_TOKENS, estimateTokens, localOutputReserveTokens } from '../lib/contextBudget.js';
import { allowedModesFor, callerModeRejection } from '../lib/callerModePolicy.js';
import { attachGatewaySiblingKey } from '../lib/provider/providerGateways.js';
import { isMoaProvider, isMoaProviderId } from '../lib/provider/providerTypes.js';

// Fallback-lifecycle notifiers live in services/autoFixer.js (which pulls in cos.js); initAutoFixer()
// registers them through this leaf. Never import autoFixer.js here: `vitest related` follows it (#12285).
import { getProviderRecoveryHandlers } from './provider/providerRecoveryHooks.js';

// Deferred: `observedContextWindows.js` reaches `lib/localProviderRuntime.js` and the endpoint probe,
// which ~160 suites never need (see "Import scoping" in server/AGENTS.md).
let observedContextWindowsLoadPromise;
function loadObservedContextWindows() {
  if (!observedContextWindowsLoadPromise) {
    observedContextWindowsLoadPromise = import('./observedContextWindows.js').catch((err) => {
      observedContextWindowsLoadPromise = null;
      throw err;
    });
  }
  return observedContextWindowsLoadPromise;
}

/**
 * `withObservedContextWindows(provider)` behind the deferred load, shared by the dispatch gate and
 * `stageRunner.resolveStageContext`. Rejects on load/probe failure; error policy is the caller's:
 * the gate lets it surface, the budgeter degrades to the provider as stored.
 */
export async function withObservedContextWindowsLazy(provider) {
  const { withObservedContextWindows } = await loadObservedContextWindows();
  return withObservedContextWindows(provider);
}

// The category an oversized prompt already carries elsewhere (`agentErrorAnalysis.js`, `codexTurn.js`).
// A plain string, not an `ERROR_CATEGORIES` member: that enum is provider-health, this is
// REQUEST-specific (`providerCooldown.isSchemaTypeCategory` covers it, so it never benches).
const CONTEXT_LENGTH_CATEGORY = 'context-length';

export const DEFAULT_TIMEOUT_MS = 300000;
// Grace past the runner's own API deadline: lets executeApiRun's timers win and classify TIMEOUT;
// the backstop fires only if the runner never reports completion.
const API_TIMEOUT_BACKSTOP_GRACE_MS = 2000;
const APPEND_CHUNK = (acc, chunk) => acc + (typeof chunk === 'string' ? chunk : (chunk?.text || ''));

export function buildRequestCapabilities({ prompt, screenshots, outputReserveTokens, callerPolicy = null } = {}) {
  const reserve = Number.isFinite(Number(outputReserveTokens))
    ? Math.max(0, Number(outputReserveTokens))
    : DEFAULT_OUTPUT_RESERVE_TOKENS;
  return {
    requiredContextTokens: estimateTokens(prompt) + reserve,
    hasImages: Array.isArray(screenshots) && screenshots.length > 0,
    // Only present when the caller declared a mode policy, so an undeclared
    // caller keeps routing across every mode exactly as it always has.
    ...(callerPolicy ? { allowedModes: allowedModesFor(callerPolicy) } : {}),
  };
}

export const isLocalEndpoint = isLoopbackEndpoint;

/**
 * True when the runner+provider pair will honor a per-call `model` override. API providers take
 * the model as an arg; CLI/TUI providers get `--model`/`-m` from the resolved `defaultModel` UNLESS
 * a model flag is baked into `provider.args` (then it wins and we claim "doesn't honor").
 */
export const providerHonorsModelOverride = (provider) => (
  provider?.type === PROVIDER_TYPES.API
  || ((provider?.type === PROVIDER_TYPES.CLI || provider?.type === PROVIDER_TYPES.TUI) && !hasModelFlag(provider?.args))
);

/**
 * Resolve the model id that will ACTUALLY execute, for logging + run-record persistence.
 *   - Provider honors the override: callerModel || provider.defaultModel || provider.models[0]
 *   - CLI with a baked --model/-m in args: extractBakedModel(args) || defaultModel || models[0]
 * Returns null when nothing resolves, so logs read "(default)".
 *
 * @param {object} provider
 * @param {string} [callerModel] — the per-call model the caller asked for
 * @returns {string|null}
 */
export function resolveEffectiveModel(provider, callerModel) {
  if (providerHonorsModelOverride(provider)) {
    // Stale config can leave an embedding-only id in callerModel/defaultModel; skip those so it
    // can't route a generation run to e.g. nomic-embed-text.
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
 * First model in `provider.models` usable for generation (skips embedding-only ids; a local
 * provider listing `nomic-embed-text` first would otherwise fail chat runs). Falls back to
 * `models[0]` only when every listed model looks like an embedding model.
 */
function firstGenerationModel(provider) {
  const models = provider?.models || [];
  return models.find((m) => m && isGenerationModel(m)) || models[0] || null;
}

/**
 * Tier-1 (config/env) deterministic fix for `model-not-found` / `model-not-supported` (#2342): pick a
 * DIFFERENT valid generation model the (reachable) provider lists and retry the SAME provider,
 * cheaper than benching it for Tier 3. Pure. Returns null (Tier 1 declines) when the provider has no
 * enumerable `models`, or only the failed id and/or embedding-only ids. The failed id is excluded so
 * the same broken request is never re-issued.
 * @param {object} provider
 * @param {string} [failedModel] — the model id that just failed model-not-found
 * @returns {string|null}
 */
export function pickConfigCorrectedModel(provider, failedModel) {
  const models = provider?.models;
  if (!Array.isArray(models)) return null;
  return models.find((m) => m && m !== failedModel && isGenerationModel(m)) || null;
}

// ── Tier-2 (schema/type) request/response correction (#2350) ──
// A schema/type failure never arrives as a provider ERROR (errorDetection.js only categorizes
// transport/auth/model failures): the run SUCCEEDS but its text misses the caller's `responseSchema`
// (or `repair` normalizer). Tier-2 tries bounded in-place JSON coercion, then re-requests the SAME
// provider with a schema-strengthened prompt, before escalating to Tier-3/4.

// Re-exported from providerCooldown.js, which owns it alongside the cooldown
// table that consults it (the tier classification and the "don't bench a healthy
// provider over one off-shape response" rule are the same judgement).
export { isSchemaTypeCategory };

// Appended on a schema/type re-request when the caller gave no `repair`; names the failure modes
// coercion couldn't fix (fenced/prose-wrapped output).
const SCHEMA_RETRY_INSTRUCTION = '\n\n---\nIMPORTANT: Your previous response could not be parsed into the required structured format. Respond with ONLY the raw JSON value that satisfies the required schema — no markdown code fences, and no explanatory text before or after the JSON.';

/**
 * Normalize a caller `responseSchema` into a predicate over a PARSED JSON value (#2350). Accepts a
 * Zod-style schema (duck-typed; no zod dependency), a bare predicate, or null/undefined (⇒ null,
 * feature off). An unrecognized truthy value degrades to "any JSON parses". Pure.
 * @returns {((value:unknown)=>boolean)|null}
 */
export function normalizeResponseSchema(schema) {
  if (!schema) return null;
  if (typeof schema === 'function') return (value) => { try { return !!schema(value); } catch { return false; } };
  if (typeof schema.safeParse === 'function') return (value) => schema.safeParse(value).success;
  if (typeof schema.parse === 'function') return (value) => { try { schema.parse(value); return true; } catch { return false; } };
  return () => true;
}

// Discriminated JSON parse: `{ ok:true, value }` (value may legitimately be
// `null`) vs `{ ok:false }`, so a top-level `null` response isn't conflated with
// a parse failure.
const safeJsonParse = (text) => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };

/**
 * True when `text` already parses as JSON that satisfies the schema predicate —
 * i.e. no correction is needed. A non-JSON or off-shape response returns false.
 */
function responseSatisfiesSchema(text, predicate) {
  if (typeof text !== 'string' || !text) return false;
  const parsed = safeJsonParse(text);
  return parsed.ok && (!predicate || predicate(parsed.value));
}

// Pick which top-level JSON shape to try first from the first structural char so an array isn't
// mis-picked as its first inner object. Both types are still tried.
function detectBlockOrder(text) {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) return ['array', 'object'];
  return ['object', 'array'];
}

/**
 * Deterministic Tier-2 JSON coercion keyed on the caller's schema (#2350): jsonExtract.extractJson
 * strips fences/prose and pulls the first balanced block satisfying the schema predicate. Returns the
 * coerced value plus its canonical `JSON.stringify` text. Pure.
 * @param {string} text — raw response text
 * @param {*} schema — a responseSchema (see normalizeResponseSchema)
 * @returns {{ ok:true, value:unknown, text:string } | { ok:false }}
 */
export function coerceResponseToSchema(text, schema) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false };
  const predicate = normalizeResponseSchema(schema);
  for (const blockType of detectBlockOrder(text)) {
    // extractJson's fallback returns the first PARSEABLE block even if off-shape, so re-check the predicate.
    const { value } = extractJson(text, { shapePredicate: predicate || undefined, blockType });
    if (value !== undefined && (!predicate || predicate(value))) {
      return { ok: true, value, text: JSON.stringify(value) };
    }
  }
  return { ok: false };
}

// Best-effort call to a caller `repair` normalizer for a given phase. Never
// throws (a repair-callback error is logged + treated as a decline); returns the
// corrected string for the requested field, or null.
async function callRepair(repair, payload, field) {
  if (typeof repair !== 'function') return null;
  let out = null;
  try { out = await repair(payload); } catch (e) {
    console.error(`❌ Tier 2 ${payload.phase} repair callback threw: ${e.message}`);
    return null;
  }
  const v = out?.[field];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Validate a run RESULT against `responseSchema` (#2350); on mismatch try, IN PLACE, the caller's
 * `repair({ phase:'response' })` then the schema-keyed JSON coercion. Never throws. Returns:
 *   { ok:true, result }                — no schema declared, or already valid
 *   { ok:true, result, coerced:true }  — recovered in place (⇒ mark Tier-2)
 *   { ok:false }                        — response is off-shape and uncoercible
 */
async function correctResponseToSchema(result, { responseSchema, repair, prompt }) {
  const predicate = normalizeResponseSchema(responseSchema);
  // Needs a declared schema: a `repair`-only caller gives no way to know a response is malformed.
  if (!predicate) return { ok: true, result };
  const text = typeof result?.text === 'string' ? result.text : '';
  if (responseSatisfiesSchema(text, predicate)) return { ok: true, result };

  const repaired = await callRepair(repair, { phase: 'response', text, prompt }, 'text');
  if (repaired && responseSatisfiesSchema(repaired, predicate)) {
    return { ok: true, result: { ...result, text: repaired }, coerced: true };
  }
  const coerced = coerceResponseToSchema(text, responseSchema);
  if (coerced.ok) return { ok: true, result: { ...result, text: coerced.text }, coerced: true };
  return { ok: false };
}

/**
 * Build the Tier-2 corrected REQUEST: the caller's `repair({ phase:'request' })`, else (with a
 * `responseSchema`) the prompt plus a schema-conformance instruction. Returns null (Tier-2 declines)
 * when no correction exists or it wouldn't change the prompt.
 */
async function buildSchemaCorrectedPrompt({ prompt, responseSchema, repair, category, error }) {
  const repaired = await callRepair(repair, { phase: 'request', prompt, category, error }, 'prompt');
  if (repaired && repaired !== prompt) return repaired;
  if (responseSchema) {
    const corrected = `${prompt}${SCHEMA_RETRY_INSTRUCTION}`;
    if (corrected !== prompt) return corrected;
  }
  return null;
}

/**
 * Synthesize a schema/type failure Error so an uncoercible response re-enters the same fallback
 * cascade as a transport failure. Carries `effectiveProvider`/`effectiveModel`, a 'parse-error'
 * category (schema-type, so a healthy provider isn't benched for one off-shape response), and a
 * `schemaFailure` marker.
 */
function buildSchemaFailureError(result) {
  const err = new Error('AI response did not match the declared schema and could not be coerced');
  err.errorAnalysis = { category: 'parse-error' };
  err.effectiveProvider = result?.provider;
  err.effectiveModel = result?.model ?? null;
  err.schemaFailure = true;
  return err;
}

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

/** Own deferred investigations for one retry cascade, independently of retry policy. */
function createRecoveryInvestigationScope({ failed, failedModel, firstError }) {
  // Handlers registered by initAutoFixer(); null when the auto-fixer is not
  // running in this process, in which case it has no deferred tasks to settle.
  const getAutoFixer = async () => getProviderRecoveryHandlers();
  // Keys must match what bootstrap.js's onRunFailed hook published
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

  // Every provider+model key whose deferred investigation we suppress across the cascade, so a
  // recovery at ANY tier cancels ALL of them, a give-up releases them, and the `finally` releases
  // any left over after an unexpected throw (which would suppress identical failures process-wide).
  // Keyed by a NUL-joined string; the value carries the key object + resolution state.
  const suppressed = new Map();
  const keyStr = (k) => `${k.provider}\x00${k.model}`;
  const suppress = async (key) => {
    const id = keyStr(key);
    if (suppressed.has(id)) return; // idempotent across tiers
    suppressed.set(id, { key, resolved: false });
    await noteStarted(key);
  };
  const recoverAll = async () => {
    for (const entry of suppressed.values()) {
      if (!entry.resolved) { entry.resolved = true; await noteHandled(entry.key); }
    }
  };
  const releaseForExistingInvestigation = async () => {
    for (const entry of suppressed.values()) {
      if (!entry.resolved) { entry.resolved = true; await noteFailed(entry.key); }
    }
  };

  // Explicitly escalate the primary failure to a Tier-4 investigation task —
  // used only on a give-up where every attempted key's incidental task was
  // suppressed, so nothing else would surface the unrecovered failure. Honors
  // the circuit breaker. Best-effort: a failure here must not mask the rethrow.
  const escalatePrimaryFailure = async () => {
    const a = await getAutoFixer();
    try {
      await a?.escalateProviderFailure?.({
        code: 'AI_PROVIDER_EXECUTION_FAILED',
        message: firstError.message,
        timestamp: Date.now(),
        context: {
          provider: failed.name || failed.id,
          providerId: failed.id,
          model: failedModel,
          errorDetails: firstError.message,
          errorAnalysis: firstError.errorAnalysis,
        },
      });
    } catch (escalateErr) {
      console.error(`❌ escalateProviderFailure failed (unrecovered failure not escalated): ${escalateErr.message}`);
    }
  };

  const escalateAndRelease = async () => {
    // With no suppression, the execution layer still owns the original event.
    // Preserve that path without loading autoFixer or creating a replacement.
    if (suppressed.size === 0) return;
    await escalatePrimaryFailure();
    await releaseForExistingInvestigation();
  };
  const closeUnexpectedFailure = async () => {
    // Explicit terminal operations settle every key; only an unexpected throw
    // can leave canceled backstops without a surviving investigation here.
    if ([...suppressed.values()].some((entry) => !entry.resolved)) {
      await escalateAndRelease();
    }
  };

  return { suppress, recoverAll, releaseForExistingInvestigation, escalateAndRelease, closeUnexpectedFailure };
}

/**
 * Tier 1 — config/env correction (#2342). A model-not-found/model-not-supported failure is
 * request-specific: retry the SAME provider with a valid model it lists, cheaper than a Tier-3
 * provider fallback. No config is persisted. Resolves with the recovered result, or null when Tier 1
 * declines or its retry fails (that retry's key is then suppressed in `investigation`, so the caller
 * still owns escalation). Re-throws only a terminal request error via `stopOnTerminalRequest`.
 *
 * Gated on `providerHonorsModelOverride`: a model flag baked into CLI/TUI args ignores the per-call
 * `model`, so the "corrected" retry would be the same failed model.
 * Compare against string literals: `ERROR_CATEGORIES.MODEL_NOT_SUPPORTED` does NOT exist
 * (`undefined` would match a category-less failure and wrongly engage Tier 1).
 * 'model-not-supported' is autoFixer's own Tier-1 category, matched for parity.
 */
async function attemptConfigCorrection({ args, source, failed, failedModel, category, investigation, primaryKey, stopOnTerminalRequest }) {
  if (category !== ERROR_CATEGORIES.MODEL_NOT_FOUND && category !== 'model-not-supported') return null;
  if (!providerHonorsModelOverride(failed)) return null;
  const correctedModel = pickConfigCorrectedModel(failed, failedModel);
  if (!correctedModel) return null;

  console.log(`🔧 Tier 1 (config/env) retry: ${source} on ${failed.name} with model ${correctedModel} (requested ${failedModel} → ${category})`);
  // Suppress the primary's investigation task while the corrected retry runs so a slow
  // (>TASK_DEFER_MS) but SUCCESSFUL retry can't leave a task behind for a recovered failure.
  await investigation.suppress(primaryKey);
  let tier1Result;
  try {
    tier1Result = await executeProviderRunOnce({
      ...args,
      provider: failed,
      model: correctedModel,
      runId: undefined, // fresh run so the failed primary's record stays intact
    });
  } catch (tier1Error) {
    await stopOnTerminalRequest(tier1Error);
    // The corrected retry failed. If it reached the execution layer, its onRunFailed queued a task
    // keyed on the EFFECTIVE provider/model (createRun may have proactively swapped) — record and
    // suppress that key too, so a slow later recovery can't let its backstop fire. A pre-execution
    // throw (no effectiveProvider) queued NO task, so leave ownership with the primary for explicit
    // escalation.
    if (tier1Error?.effectiveProvider) {
      await investigation.suppress({
        provider: tier1Error.effectiveProvider.name || tier1Error.effectiveProvider.id,
        model: tier1Error.effectiveModel || correctedModel,
      });
    }
    console.log(`↪️ Tier 1 correction failed on ${failed.name} (${correctedModel}): ${tier1Error.message}`);
    return null;
  }
  await investigation.recoverAll();
  return {
    ...tier1Result,
    usedFallback: true,
    fixTier: 1, // FIX_TIERS.CONFIG_ENV (mirrored; kept decoupled from the lazy autoFixer import)
    fixStrategy: 'config/env',
    fallbackFrom: { id: failed.id, name: failed.name },
    fallbackProvider: failed,
  };
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

  // Stops and caller spending ceilings carry no provider-health verdict.
  // Neither enters correction/fallback, benching, or fault investigation.
  if (firstError?.code === EXECUTION_OPTIONS_ERROR) throw stripFallbackContext(firstError);

  if (isRunCanceledError(firstError) || isRuntimeBudgetError(firstError) || isContentRefusalError(firstError)
    || firstError?.errorAnalysis?.category === ERROR_CATEGORIES.OUTPUT_LIMIT) {
    throw stripFallbackContext(firstError);
  }

  {
    // Only retry when the failure came from the execution layer (annotated
    // by safeReject with effectiveProvider) or is a synthetic schema/type
    // failure (also annotated). Pre-execution throws — createRun rejecting on a
    // disk error / disabled provider / unsupported type — never fire the
    // AI_PROVIDER_EXECUTION_FAILED hook, so there's no deferred investigation
    // task to suppress and marking the provider unavailable would punish it for
    // a disk/config problem. Rethrow those as-is so the caller sees the original.
    if (!firstError?.effectiveProvider) {
      throw stripFallbackContext(firstError);
    }

    // The runner already wrote a failed metadata.json and the onRunFailed hook queued a deferred
    // investigation task keyed on (providerName, model). Walk the deterministic cascade (#2342),
    // cheapest tier first, escalating to that task (Tier 4) only when every tier declines or fails:
    //   Tier 1 config/env  — retry the SAME provider with a valid model (no persisted config change)
    //   Tier 2 schema/type  — re-request the SAME provider with a schema-corrected prompt (#2350)
    //                         when a `responseSchema`/`repair` was declared (in-place coercion already
    //                         ran on the success path)
    //   Tier 3 constrained-agent-retry — bounded retry via a fallback provider
    //   Tier 4 escalate     — the deferred investigation task the hook queued
    //
    // `failed` is the provider that ACTUALLY ran (createRun may have proactively swapped), so the
    // task-suppression notifiers cancel the right queued task.
    const failed = firstError.effectiveProvider;
    const failedModel = firstError.effectiveModel || resolveEffectiveModel(failed, args.model);
    const category = firstError.errorAnalysis?.category;
    // The primary's queued investigation task is keyed on (providerName, model).
    // Every tier that retries suppresses this key up front so a slow retry
    // (a CLI fallback can take 20–30s) can't outrun the backstop timer
    // (autoFixer.TASK_DEFER_MS) and leave a task behind for a recovered failure.
    const primaryKey = { provider: failed.name || failed.id, model: failedModel };

    const investigation = createRecoveryInvestigationScope({ failed, failedModel, firstError });
    const stopOnTerminalRequest = async (error) => {
      if (error?.code !== EXECUTION_OPTIONS_ERROR && !isRuntimeBudgetError(error) && !isContentRefusalError(error)) return;
      // Caller ceilings settle ownership without declaring a provider fault.
      await investigation.recoverAll();
      throw stripFallbackContext(error);
    };

    if (rawArgs.allowFallback === false) {
      // A pinned provider still corrects a stale model on that SAME provider when the caller opts in
      // (`allowModelCorrection`): the pin protects provider identity (e.g. a tool-free admission),
      // and a model the provider no longer lists cannot succeed on any retry. No other tier runs.
      if (rawArgs.allowModelCorrection === true) {
        try {
          const tier1Result = await attemptConfigCorrection({
            args, source: rawArgs.source, failed, failedModel, category, investigation, primaryKey, stopOnTerminalRequest,
          });
          if (tier1Result) return tier1Result;
          // A declined or failed correction leaves exactly one investigation (no-op when nothing
          // was suppressed, so the hook's own queued task still owns the failure).
          await investigation.escalateAndRelease();
        } finally {
          await investigation.closeUnexpectedFailure();
        }
      }
      // Otherwise a pinned caller takes no retry tier, but provider HEALTH is not routing: without
      // the mark a provider failing every call stays green on the Providers page, unpinned callers
      // keep routing to it, and the pinned caller burns the full timeout per wake. With it, createRun
      // refuses the next pinned call in milliseconds until the cooldown expires.
      //
      // `resolveProviderBench` still declines request-specific categories, so a prompt-specific
      // failure never benches a healthy provider. Only `unavailable` markers: a usage limit is left
      // alone because `markProviderUsageLimit` writes the observed-block ledger and the pinned caller
      // records it itself.
      await markProviderUnavailableFromError(
        failed,
        firstError.message,
        firstError.errorAnalysis,
        firstError.effectiveModel ?? null,
        { skipUsageLimit: true },
      ).catch((err) => {
        console.error(`❌ markUnavailable failed for ${failed.id}: ${err.message}`);
      });
      throw stripFallbackContext(firstError);
    }

    try {
      const tier1Result = await attemptConfigCorrection({
        args, source: rawArgs.source, failed, failedModel, category, investigation, primaryKey, stopOnTerminalRequest,
      });
      if (tier1Result) return tier1Result;

      // ── Tier 2 — schema/type request correction (issue #2350) ──────────────
      // Reached for a schema/type-category failure — the synthetic
      // response-schema failure raised on the success path above, or an
      // agent-analysis parse/bad-request/output-length category. When the caller
      // declared a `responseSchema` (or supplied a `repair`), re-request the SAME
      // provider once with a schema-corrected prompt before benching it for a
      // Tier-3 fallback. Mirrors Tier 1: suppress the primary's task up front,
      // retry once, cancel the task on a recovered + schema-valid response.
      if (isSchemaTypeCategory(category)) {
        const correctedPrompt = await buildSchemaCorrectedPrompt({
          prompt: rawArgs.prompt,
          responseSchema: args.responseSchema,
          repair: args.repair,
          category,
          error: firstError,
        });
        if (correctedPrompt) {
          console.log(`🧩 Tier 2 (schema/type) retry: ${rawArgs.source} on ${failed.name} (category ${category})`);
          await investigation.suppress(primaryKey);
          let tier2Result;
          try {
            tier2Result = await executeProviderRunOnce({
              ...args,
              provider: failed,
              prompt: correctedPrompt,
              runId: undefined, // fresh run so the failed primary's record stays intact
            });
          } catch (tier2Error) {
            await stopOnTerminalRequest(tier2Error);
            // Same bookkeeping as Tier 1's failed corrected retry: a retry that
            // reached the execution layer queued its own task keyed on the
            // EFFECTIVE provider/model — record + suppress it so a slow Tier-3
            // recovery can't let its backstop fire. A pre-execution throw queued
            // no task, so leave ownership with the primary for explicit escalation.
            if (tier2Error?.effectiveProvider) {
              await investigation.suppress({
                provider: tier2Error.effectiveProvider.name || tier2Error.effectiveProvider.id,
                model: tier2Error.effectiveModel || failedModel,
              });
            }
            console.log(`↪️ Tier 2 correction failed on ${failed.name}: ${tier2Error.message} — escalating to constrained-agent-retry`);
          }
          if (tier2Result) {
            // The re-requested response must ALSO satisfy the schema (or coerce)
            // — a retry that returns fresh-but-still-malformed output is not a
            // recovery. On success cancel the primary task; otherwise fall
            // through to the Tier-3 fallback provider.
            const revalidated = await correctResponseToSchema(tier2Result, args);
            if (revalidated.ok) {
              await investigation.recoverAll();
              return {
                ...revalidated.result,
                usedFallback: true,
                fixTier: 2, // FIX_TIERS.SCHEMA_TYPE (mirrored; kept decoupled from the lazy autoFixer import)
                fixStrategy: 'schema/type',
                fallbackFrom: { id: failed.id, name: failed.name },
                fallbackProvider: failed,
              };
            }
            console.log(`↪️ Tier 2 re-request still off-schema on ${failed.name} — escalating to constrained-agent-retry`);
          }
        }
      }

      // ── Tier 3 — constrained-agent-retry via a fallback provider ───────────
      // Coalesce the per-provider mark-and-pick during an N-way failure storm:
      // the 2nd…Nth simultaneous failure for the same provider awaits the first's
      // result instead of independently re-reading providers.json
      // (pickFallbackProvider) and re-writing provider-status.json
      // (markUnavailable). The fallback *run* below is NOT coalesced — each failed
      // call still executes its own fallback to get its own result.
      const picked = await coalesceFallbackMarkAndPick(failed, firstError, buildRequestCapabilities(args));
      if (!picked) {
        // ── Tier 4 — escalate ──: no recovery path left. Every attempted key's
        // incidental task was suppressed, so escalate exactly one investigation
        // task explicitly (honors the circuit breaker), then release the keys.
        await investigation.escalateAndRelease();
        throw stripFallbackContext(firstError);
      }
      const fallback = picked.provider;

      console.log(`⚡ Tier 3 (constrained-agent-retry): ${rawArgs.source} with fallback ${fallback.name} (primary ${failed.name} failed: ${firstError.message})`);

      // Suppress the primary key (idempotent across tiers) for the fallback run.
      await investigation.suppress(primaryKey);

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
          executionOptions: resolveExecutionOptions({ source: 'provider', options: args.provider?.executionOptions }, { source: 'run', options: args.executionOptions }).requested,
          model: picked.model ?? undefined,
          // A step in the global fallback list may pin its own effort; the
          // primary's effort belongs to the primary's model, so it is not inherited.
          ...(picked.effort ? { effort: picked.effort } : {}),
          runId: undefined, // fresh runId so the failed primary's record stays intact
        });
      } catch (fallbackError) {
        await stopOnTerminalRequest(fallbackError);
        // ── Tier 4 — escalate ──: every deterministic tier failed. If the
        // fallback reached the execution layer, its OWN onRunFailed already
        // queued an investigation task (its key was never suppressed), so just
        // release the suppressed keys — one surviving task. But if the fallback
        // threw BEFORE execution (e.g. createRun error), no task was queued and
        // the suppressed primary/corrected keys would leave ZERO tasks — so
        // escalate one explicitly first (deduped inside escalateProviderFailure).
        if (fallbackError?.effectiveProvider) {
          await investigation.releaseForExistingInvestigation();
        } else {
          await investigation.escalateAndRelease();
        }
        throw stripFallbackContext(fallbackError);
      }

      // A fallback provider can ALSO return an off-schema response (issue #2350)
      // — validate/coerce it before declaring recovery. If it can't be coerced,
      // no deterministic tier is left: escalate one investigation task and give
      // up (a fresh-but-unusable fallback response is not a recovery).
      const fallbackValidated = await correctResponseToSchema(fallbackResult, args);
      if (!fallbackValidated.ok) {
        await investigation.escalateAndRelease();
        throw stripFallbackContext(buildSchemaFailureError(fallbackResult));
      }

      // Fallback succeeded — cancel EVERY suppressed key (the primary and any
      // Tier-1/Tier-2 corrected-retry key) so a fully-recovered action creates
      // ZERO investigation tasks (issue #2342 acceptance: only UNRECOVERED
      // failures escalate to Tier 4).
      await investigation.recoverAll();

      return {
        ...fallbackValidated.result,
        usedFallback: true,
        fixTier: 3, // FIX_TIERS.CONSTRAINED_RETRY
        fixStrategy: 'constrained-agent-retry',
        fallbackFrom: { id: failed.id, name: failed.name },
        fallbackProvider: fallback,
      };
    } finally {
      await investigation.closeUnexpectedFailure();
    }
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
 * Mark the failed provider unavailable and pick its fallback, coalescing concurrent calls for the
 * same provider id onto one shared promise. Resolves like `pickFallbackProvider` (null when none);
 * the mark is skipped when no fallback exists, so a provider with no recovery path isn't benched.
 *
 * @param {object} failed — the provider that actually ran and failed
 * @param {Error} firstError — the execution error (carries message + errorAnalysis)
 * @returns {Promise<{ provider: object, model: string|null }|null>}
 */
function coalesceFallbackMarkAndPick(failed, firstError, requestCapabilities) {
  const capabilityKey = `${requestCapabilities?.hasImages === true ? 'images' : 'text'}:${requestCapabilities?.requiredContextTokens || 0}`;
  return _fallbackMarkAndPick.run(`${failed.id}:${capabilityKey}`, async () => {
    const picked = await pickFallbackProvider(failed, requestCapabilities);
    if (!picked) return null;
    await markProviderUnavailableFromError(failed, firstError.message, firstError.errorAnalysis, firstError?.effectiveModel ?? null).catch(err => {
      console.error(`❌ markUnavailable failed for ${failed.id}: ${err.message}`);
    });
    return picked;
  });
}

/**
 * Pick a fallback for `failed`: its `fallbackProvider` field first, then the toolkit's system
 * priority list. Returns `{ provider, model }` or null. `model` is the configured `fallbackModel`
 * hint (null for system-priority picks) — never the failed provider's model.
 *
 * The toolkit's `getFallbackProvider` reads `providers[failed.id]`, so the primary MUST stay in the
 * map. Self-loop protection lives there; the system priority loop excludes `failed.id`.
 */
async function pickFallbackProvider(failed, requestCapabilities) {
  const toolkit = getAIToolkitInstance();
  const providerStatus = toolkit?.services?.providerStatus;
  if (!providerStatus) return null;

  const all = await getAllProviders().catch(() => null);
  if (!all?.providers) return null;
  const providersMap = {};
  for (const p of all.providers) providersMap[p.id] = p;
  // A composite (`harness.method@service`, #7564) never sits in the stored map;
  // the failed provider's own id may be one, and it must be in the map for the
  // toolkit's self-loop guard and `fallbackProvider` read to see it. The
  // toolkit's boot-registered resolver already materializes composite ids;
  // reusing it keeps the host resolver graph out of request-path CI selection.
  if (isCompositeProviderId(failed.id) && !providersMap[failed.id]) {
    const record = await getProviderById(failed.id);
    if (record) providersMap[failed.id] = record;
  }
  const chainComposites = peekFallbackChain().map((e) => e.providerId).filter(isCompositeProviderId);
  for (const id of chainComposites) {
    if (providersMap[id]) continue;
    const record = await getProviderById(id);
    if (record) providersMap[id] = record;
  }

  const picked = providerStatus.getFallbackProvider(failed.id, providersMap, null, null, requestCapabilities);
  if (!picked?.provider) return null;
  // The pick comes from the RAW provider map (`getAllProviders`), which carries
  // no gateway-inherited key — a gateway-backed wrapper picked here would execute
  // without its sibling's apiKey and fail auth (NVIDIA NIM 401s "Header of type
  // `authorization` was missing") despite a stored key. Attach it from the same
  // map (synchronous — no re-read to go stale).
  return { provider: attachGatewaySiblingKey(picked.provider, providersMap), model: picked.model ?? null, effort: picked.effort ?? null };
}

/**
 * Translate the runner's failure into an availability marker on the failed provider, reusing the
 * precomputed error analysis when present (else `analyzeError`). Usage-limit failures route through
 * `markUsageLimit` so the parsed wait time is honored. Skips the mark when `executeApiRun` already
 * marked inline (RATE_LIMIT/USAGE_LIMIT), which would double-increment `failureCount`.
 *
 * `skipUsageLimit` declines the usage-limit marker entirely (bench AND ledger) for a caller that
 * records it itself. Everything else still benches.
 */
async function markProviderUnavailableFromError(failed, errorMessage, runnerAnalysis, runModel = null, { skipUsageLimit = false } = {}) {
  const toolkit = getAIToolkitInstance();
  const providerStatus = toolkit?.services?.providerStatus;
  if (!providerStatus) return;

  const analysis = runnerAnalysis && typeof runnerAnalysis === 'object'
    ? runnerAnalysis
    : analyzeError(errorMessage || '');

  // Request/response-specific categories (a content refusal, a bad model id, an
  // off-shape response) resolve to null — the provider is healthy and the single
  // failing call still falls back via the caller's retry path.
  const bench = resolveProviderBench(analysis);
  if (!bench) return;

  if (bench.marker === 'usage-limit') {
    // `skipUsageLimit` callers own this marker themselves — see the pinned
    // branch in runPromptThroughProvider. Returning before the ledger write is
    // the point: recordLimitBlock is deliberately NOT deduped (a repeated
    // refusal refreshes "since last block"), so a second call for the same
    // failure would show up as a second observed block.
    if (skipUsageLimit) return;
    // Observed-block ledger for the Usage page's free-tier estimated-quota
    // signal — recorded even when the provider is already benched (a repeated
    // refusal refreshes "since last block"). Transient 429 retries never reach
    // this branch: they classify as `rate-limit`, not `usage-limit`.
    await import('./usage.js')
      .then(({ recordLimitBlock }) => recordLimitBlock({
        providerId: failed.id,
        model: runModel,
        category: 'usage-limit',
        message: bench.message || errorMessage,
        resetHint: bench.waitTime
      }))
      .catch((err) => {
        console.error(`❌ Failed to record limit block for ${failed.id}: ${err.message}`);
      });
    if (!providerStatus.isAvailable(failed.id)) return;
    await providerStatus.markUsageLimit(failed.id, {
      message: bench.message || errorMessage,
      waitTime: bench.waitTime,
    });
    return;
  }

  if (!providerStatus.isAvailable(failed.id)) return;
  await providerStatus.markUnavailable(failed.id, {
    reason: bench.category,
    message: bench.message || errorMessage || `Provider ${failed.name || failed.id} failed`,
    waitTimeMs: bench.waitTimeMs,
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
 * Whether `provider` generates on a local inference server — an API provider
 * served by an Ollama daemon, flagged as llama.cpp / LM Studio / MTPLX / vLLM /
 * SGLang, or pointed at a loopback endpoint. These are the windows a cloud-sized
 * output reserve can swallow whole.
 */
function isLocalInferenceProvider(provider) {
  if (provider?.type !== PROVIDER_TYPES.API) return false;
  return isOllamaBackedProvider(provider)
    || hasLocalRuntimeMarker(provider)
    || isLocalEndpoint(provider.endpoint);
}

/**
 * The output reserve (and generation cap) for a run on a LOCAL model. A caller's declared
 * `outputReserveTokens` is cloud-sized (the persistent mind declares 8,192), which alone is half a
 * 16K local window and refused prompts that fit (#9437). For a local provider with a KNOWN window the
 * reserve shrinks to `localOutputReserveTokens` (floor 2,048, ⅛ of the window, never above what was
 * declared) and `max_tokens`/`num_predict` is capped at the same number.
 *
 * Unchanged when the caller named its own `maxTokens`, declared no reserve, the window is unknown, or
 * the provider is not local.
 *
 * @returns {Promise<{ outputReserveTokens: number|undefined, maxTokens: number|undefined }>}
 */
async function resolveLocalOutputBudget(provider, model, { outputReserveTokens, maxTokens }) {
  const unchanged = { outputReserveTokens, maxTokens };
  if (Number.isInteger(maxTokens) && maxTokens > 0) return unchanged;
  if (!Number.isFinite(Number(outputReserveTokens)) || !isLocalInferenceProvider(provider)) return unchanged;
  const observed = withOllamaRuntimeContextWindow(await withObservedContextWindowsLazy(provider));
  const reserve = localOutputReserveTokens(outputReserveTokens, knownContextWindow(observed, model));
  return reserve ? { outputReserveTokens: reserve, maxTokens: reserve } : unchanged;
}

/**
 * The prompt room a LOCAL provider leaves once its output reserve is planned, for callers that build
 * their own prompt and want to fit it (the persistent mind's tool rounds). Same window lookup and
 * `localOutputReserveTokens` sizing as the dispatch gate, so a prompt under `maxPromptTokens`
 * (chars/4) is one the gate admits. Returns `null` for a cloud/CLI provider, an undeclared reserve,
 * or an unknown window.
 *
 * @param {{ provider: object, model?: string|null, outputReserveTokens: number }} args
 * @returns {Promise<{ contextWindow: number, outputReserveTokens: number, maxPromptTokens: number }|null>}
 */
export async function resolveLocalPromptBudget({ provider, model = null, outputReserveTokens }) {
  if (!isLocalInferenceProvider(provider)) return null;
  const resolvedModel = model || provider?.defaultModel || null;
  const observed = withOllamaRuntimeContextWindow(await withObservedContextWindowsLazy(provider));
  const contextWindow = knownContextWindow(observed, resolvedModel);
  const reserve = localOutputReserveTokens(outputReserveTokens, contextWindow);
  if (!reserve) return null;
  return { contextWindow, outputReserveTokens: reserve, maxPromptTokens: Math.max(0, contextWindow - reserve) };
}

/**
 * The budget a pre-dispatch REFUSAL may act on. `requiredContextTokens` is the prompt plus an output
 * reserve, which defaults to `DEFAULT_OUTPUT_RESERVE_TOKENS` (8,000 tokens nobody asked for). That
 * is fine for ranking fallbacks, but refusing on it turns "provably cannot fit" into "probably
 * cannot fit". So a refusal uses the provable floor (the prompt alone) unless the caller declared its
 * own `outputReserveTokens`; ranking in `getFallbackProvider` keeps the full budget.
 */
function refusalCapabilities({ requestCapabilities, prompt, outputReserveTokens }) {
  if (Number.isFinite(Number(outputReserveTokens))) return requestCapabilities;
  return { ...requestCapabilities, requiredContextTokens: estimateTokens(prompt) };
}

/**
 * Refuse a prompt that provably cannot fit the provider about to run it. Before #7441 the context
 * check ran only inside `getFallbackProvider`, never on the happy path (see
 * `services/observedContextWindows.js`).
 *
 *   - An UNKNOWN window is not a rejection: `contextWindowRejection` answers `null` when nothing
 *     declared a window, and nothing infers one from a model id.
 *   - It compares `refusalCapabilities`, not the raw routing budget: an unrequested reserve must not
 *     manufacture a refusal.
 *   - The refusal is an ORDINARY failure with the existing `context-length` category, which is
 *     request-specific (`providerCooldown.isSchemaTypeCategory`) so it never benches a healthy
 *     server. It carries `effectiveProvider`, so the cascade routes it to a wider-window fallback
 *     (Tier 3 applies the same rule); a pinned (`allowFallback: false`) caller gets the message
 *     in milliseconds instead of a ten-minute stall.
 *   - It judges the REQUESTED provider, ahead of `createRun`'s proactive swap; a swap target was
 *     already vetted by `capabilityRejection`.
 */
async function assertRequestFitsContext(provider, model, requestCapabilities, { runId = null, startTime = null } = {}) {
  const required = Number(requestCapabilities?.requiredContextTokens);
  if (!Number.isFinite(required) || required <= 0) return;

  // Two in-memory projections, both describing what the daemon is doing RIGHT
  // NOW rather than what the record remembers: the windows it is serving, and
  // the ceiling PortOS launched it at — including the ambient
  // `OLLAMA_CONTEXT_LENGTH` rung the toolkit cannot reach for itself (#7472).
  const observed = withOllamaRuntimeContextWindow(await withObservedContextWindowsLazy(provider));
  // `reason` already names both numbers, which is what the operator needs to
  // decide between a smaller prompt and a wider provider — so it IS the
  // message rather than being re-worded beside it.
  const reason = contextWindowRejection(observed, model, requestCapabilities);
  if (!reason) return;

  const message = `${provider.name || provider.id}${model ? ` (${model})` : ''}: ${reason}`;
  // A caller that created its own run record (stageRunner, the loops) has one
  // sitting at `success: null, endTime: null`. Throwing past it leaves the Runs
  // page showing an attempt that never ends and every `success === null`
  // reconciler seeing a phantom active run, so settle it here — the same thing
  // the TUI readiness check below does for its own pre-execution refusal.
  if (runId) {
    await finalizeRunRecord({ runId, output: '', exitCode: 1, success: false, error: message, startTime });
  }
  const err = new Error(message);
  // The cascade only retries a failure annotated with the provider that ran
  // (see runPromptThroughProvider) — without these the refusal would be
  // rethrown straight to the caller and a wider fallback would never be tried.
  err.effectiveProvider = provider;
  err.effectiveModel = model;
  err.errorAnalysis = { category: CONTEXT_LENGTH_CATEGORY, message };
  console.log(`📏 Refused before dispatch: ${message}`);
  throw err;
}

/**
 * Inner helper: execute one attempt against `rawArgs.provider`. Returns
 * { text, runId, model } on success. On failure, throws an Error with
 * `effectiveProvider` and `effectiveModel` attached so the retry path
 * knows which provider actually ran (createRun may have proactively
 * swapped to a fallback when the requested provider was already marked
 * unavailable).
 */
async function executeProviderRunOnce({
  provider,
  prompt,
  source,
  model,
  effort = null,
  executionOptions,
  runId: callerRunId,
  onData: onDataCallback,
  onRunCreated,
  onRunReady,
  onRunSettled,
  beforeExecute,
  timeout: timeoutOverride,
  absoluteTimeoutMs,
  maxTokens,
  cwd: cwdOverride,
  screenshots = [],
  outputReserveTokens,
  callerPolicy = null,
  allowFallback = true,
  toolFree = false,
  isolateMtplxOpenCode = false,
}) {
  if (isolateMtplxOpenCode && (!toolFree || allowFallback || provider.type !== PROVIDER_TYPES.CLI)) {
    throw new Error('The isolated OpenCode MTPLX recipe needs a pinned tool-free CLI request');
  }
  // Caller EXECUTION-MODE policy, enforced on the EXPLICIT provider before a run
  // record exists and carried into fallback selection below, so the pin and the
  // route that might replace it are judged by one rule.
  const pinRejection = callerPolicy ? callerModeRejection(provider, callerPolicy) : null;
  if (pinRejection) {
    throw new ServerError(
      `Provider "${provider.id}" ${pinRejection.reason} — this caller cannot run it.`,
      { status: 422, code: 'PROVIDER_MODE_NOT_PERMITTED' },
    );
  }
  if (screenshots.length > 0
      && provider.type !== PROVIDER_TYPES.API
      && !isVisionCapableCliProvider(provider)
      && !isVisionCapableCodexTuiProvider(provider)) {
    throw new ServerError(
      'The selected provider cannot receive image attachments. Choose Codex, Claude Code, or a vision API provider.',
      { status: 422, code: 'VISION_PROVIDER_UNSUPPORTED' },
    );
  }
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

  // Built here rather than inside the createRun branch below because the
  // context gate needs it on EVERY attempt — a caller that supplies its own
  // runId (stageRunner, the loops) skips that branch entirely and would
  // otherwise dispatch ungated.
  const localBudget = await resolveLocalOutputBudget(provider, effectiveModel, { outputReserveTokens, maxTokens });
  const requestCapabilities = buildRequestCapabilities({ prompt, screenshots, outputReserveTokens: localBudget.outputReserveTokens, callerPolicy });
  await assertRequestFitsContext(
    effectiveProvider,
    effectiveModel,
    refusalCapabilities({ requestCapabilities, prompt, outputReserveTokens: localBudget.outputReserveTokens }),
    { runId: callerRunId, startTime: Date.now() },
  );

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
  let executionAttribution;
  if (Object.keys(executionOptions || {}).length || Object.keys(effectiveProvider.executionOptions || {}).length) {
    const { prepareExecutionOptions } = await import('../lib/provider/providerExecutionOptions.js');
    const prepared = await prepareExecutionOptions(effectiveProvider, effectiveModel, executionOptions, 'run', { cwd: effectiveCwd });
    effectiveProvider = prepared.provider;
    executionAttribution = prepared.attribution;
    effectiveModel = prepared.attribution.model || effectiveModel;
  }
  let runId = callerRunId;
  if (!runId) {
    const runResult = await createRun({
      providerId: provider.id,
      model: effectiveModel,
      prompt,
      source,
      workspacePath: effectiveCwd,
      effort,
      requestCapabilities,
      allowFallback: allowFallback && !Object.keys(executionAttribution?.requested || {}).length,
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

  if (executionAttribution) await patchRunMetadata(runId, { executionOptions: executionAttribution });

  // Lifecycle hooks let a parent orchestrator expose and stop the concrete
  // provider run that is active inside a larger workflow. They fire for the
  // caller-supplied primary run AND for every fresh correction/fallback run.
  // Hook failures are observational only and must not break provider work.
  if (typeof onRunCreated === 'function') {
    try {
      onRunCreated(runId, {
        runId,
        providerId: effectiveProvider.id,
        providerName: effectiveProvider.name || effectiveProvider.id,
        model: effectiveModel,
        providerType: effectiveProvider.type,
      });
    } catch (err) {
      console.error(`❌ run lifecycle start hook failed: ${err.message}`);
    }
  }

  // Compute timeout AFTER the possible fallback switch so it reflects
  // the provider that actually runs — providers can have wildly different
  // `timeout` settings (a 5-min CLI vs a 30-s API), and using the
  // original provider's timeout against a fallback would either time out
  // a still-working run early or let a stuck one hang past its
  // intended cap.
  const resolvedTimeoutOverride = typeof timeoutOverride === 'function' ? timeoutOverride(effectiveProvider) : timeoutOverride;
  const effectiveTimeout = resolvedTimeoutOverride ?? effectiveProvider?.timeout ?? DEFAULT_TIMEOUT_MS;

  // Gate concurrent in-flight calls to a LOCAL endpoint on the EFFECTIVE
  // provider — the one that ACTUALLY runs after createRun's proactive swap
  // (above) and any retry-fallback. This is the single chokepoint the
  // module comment promises: gating the *requested* provider at the call
  // site missed a remote/CLI primary that swaps/fails over to a local
  // backend, defeating the VRAM/OOM serialization. Non-local CLI/TUI providers
  // remain unconstrained.
  const attemptStartedAt = Date.now();
  return withLocalConcurrencyGate(effectiveProvider, async () => {
    // API providers run through the shared toolkit readiness hook. TUI
    // providers spawn OpenCode directly, so they need the same hook here or
    // MTPLX remains stopped until after the TUI has already failed its request.
    if (effectiveProvider.type === PROVIDER_TYPES.TUI) {
      const ready = await import('./provider/providerExecutionReadiness.js')
        .then(({ ensureProviderReadyForExecution }) => ensureProviderReadyForExecution(effectiveProvider))
        .catch((err) => ({
          success: false,
          error: err.message,
        }));
      if (!ready.success) {
        const message = ready.error || 'Provider readiness check failed';
        await finalizeRunRecord({
          runId,
          output: '',
          exitCode: 1,
          success: false,
          error: message,
          startTime: attemptStartedAt,
        });
        const error = new Error(message);
        error.effectiveProvider = effectiveProvider;
        error.effectiveModel = effectiveModel;
        throw error;
      }
    }

    // Registers the run so a context-window reload waits for it, and clamps the window to what a
    // resident runner is serving. Acquired immediately before the promise so nothing can throw
    // between acquisition and the `.finally` release. CLI runs are excluded: `executeCliRun`
    // prepares the daemon's window first and then registers its own child (#17341), and holding a
    // registration here would make that preparation wait out the drain timeout on this very run.
    const ollamaRun = isOllamaBackedProvider(effectiveProvider) && effectiveProvider.type !== PROVIDER_TYPES.CLI
      ? await import('./ollamaRunWindow.js').then(({ beginOllamaRun }) => beginOllamaRun(effectiveProvider, effectiveModel))
      : null;
    if (ollamaRun) effectiveProvider = ollamaRun.provider;
    return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    let apiTimeoutHandle = null;
    let dispatchRefusal = null;
    const admitDispatch = typeof beforeExecute === 'function' ? async () => {
      try {
        await beforeExecute({ runId, provider: effectiveProvider, model: effectiveModel });
      } catch (error) {
        dispatchRefusal = error instanceof Error ? error : new Error(String(error));
        dispatchRefusal.canceled = true;
        throw dispatchRefusal;
      }
    } : undefined;

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
      if (dispatchRefusal) { safeReject(dispatchRefusal); return; }
      if (result?.error || result?.success === false) {
        const err = new Error(result?.error || `${labelByType[effectiveProvider.type] || effectiveProvider.type} execution failed`);
        if (result?.canceled === true) {
          err.code = 'RUN_CANCELED';
          err.canceled = true;
        }
        if (result?.errorAnalysis && typeof result.errorAnalysis === 'object') {
          err.errorAnalysis = result.errorAnalysis;
        }
        for (const key of ['timeoutBound', 'timeoutOrigin', 'runtimeBudgetMs']) {
          if (result?.[key] !== undefined) err[key] = result[key];
        }
        if (isRuntimeBudgetError(result)) {
          err.code = 'RUN_RUNTIME_BUDGET_EXHAUSTED';
          err.runId = runId;
        }
        safeReject(err);
      } else {
        // TUI runs do their own cleanup inside executeTuiRun (preferring
        // the response file the model was directed to write, falling back
        // to cleanTuiResponse on the screen scrape). Trust `result.text`
        // — the accumulated `text` here is the raw chrome-laden stream.
        // Codex and Claude CLI likewise supply stdout as their final text;
        // the accumulated stream includes diagnostics alongside the reply.
        const finalText = effectiveProvider.type === PROVIDER_TYPES.TUI
          ? (typeof result?.text === 'string' ? result.text : '')
          : effectiveProvider.type === PROVIDER_TYPES.CLI && typeof result?.text === 'string'
            ? result.text
            : text;
        // Report the provider that ACTUALLY ran. `effectiveProvider` reflects
        // createRun's proactive swap (when the requested provider was already
        // benched) — distinct from the retry-fallback path, which the outer
        // runPromptThroughProvider annotates separately. Callers that care
        // about the effective provider's type (e.g. vision, which only works
        // on API providers) must read this, since a proactive swap leaves
        // `usedFallback`/`fallbackProvider` unset.
        safeResolve({ text: finalText, runId, model: effectiveModel, provider: effectiveProvider,
          ...(result?.finishReason ? { finishReason: result.finishReason } : {}),
        });
      }
    };

    // executeCliRun / executeTuiRun both read `provider.defaultModel` for
    // arg construction AND the run-started metadata hook. Hand them a
    // clone with effectiveModel pinned so a per-call model override
    // actually picks up (and the hook reports the right model). The
    // guard skips the clone when effectiveModel already equals
    // provider.defaultModel — typical for non-codex CLI providers where
    // resolveEffectiveModel falls through to defaultModel anyway.
    //
    // A per-call reasoning-effort override rides the same clone (there is no
    // `effort` argument on executeCliRun/executeTuiRun): `buildCliArgs` and
    // `buildTuiInvocation` both read `provider.effort`. It is a no-op for
    // providers with no effort control, so a caller that always passes one
    // can't corrupt an opencode/grok/API run.
    const needsModelPin = effectiveModel && effectiveModel !== effectiveProvider.defaultModel;
    const providerForRun = (needsModelPin || effort)
      ? {
        ...effectiveProvider,
        ...(needsModelPin ? { defaultModel: effectiveModel } : {}),
        ...(effort ? { effort } : {}),
      }
      : effectiveProvider;
    // `withGatewayApiKey` attaches a gateway-backed wrapper's sibling key as a
    // NON-ENUMERABLE property (so it never persists or leaks) — which the spread
    // above drops. A model-pinned or effort-overridden CLI/TUI run would then go
    // out with no Authorization header (NVIDIA NIM 401s "Header of type
    // `authorization` was missing") despite a stored key. Re-carry it with the
    // same enumerability so the clone executes with identical credentials.
    if (providerForRun !== effectiveProvider && !providerForRun.apiKey && effectiveProvider?.apiKey) {
      Object.defineProperty(providerForRun, 'apiKey', {
        value: effectiveProvider.apiKey,
        enumerable: false,
        configurable: true,
      });
    }

    if (effectiveProvider.type === PROVIDER_TYPES.CLI) {
      executeCliRun({
        runId, provider: providerForRun, prompt, workspacePath: effectiveCwd, screenshots,
        onData, onComplete, timeout: effectiveTimeout, toolFree,
        ...(toolFree && !allowFallback && maxTokens != null ? { maxTokens } : {}),
        ...(isolateMtplxOpenCode ? { isolateMtplxOpenCode } : {}),
        ...(admitDispatch ? { beforeExecute: admitDispatch } : {}),
      }).catch(safeReject);
    } else if (effectiveProvider.type === PROVIDER_TYPES.API) {
      // API runs take model as a first-class arg — no clone needed. The
      // toolkit's executeApiRun now owns the primary wall-clock timeout (it
      // aborts AND finalizes the run as an ERROR_CATEGORIES.TIMEOUT, firing
      // onComplete → our reject below with a proper timeout classification).
      // We keep a SECONDARY backstop timer here — delayed past the runner's
      // own deadline by a grace window — purely for the pathological case
      // where the runner neither throws nor ever calls onComplete (e.g. a
      // future override): it best-effort stops the run and rejects so callers
      // (meatspacePostLlm, pm2Standardizer, brain) never hang indefinitely.
      // The grace lets the runner's timeout win classification in the normal
      // path; safeReject/safeResolve clear this timer once onComplete lands.
      //
      // Armed against the runner's ABSOLUTE bound, not `effectiveTimeout`.
      // Since #7560 `effectiveTimeout` is the runner's re-armable NO-PROGRESS
      // bound — a run that keeps streaming legitimately outlives it, up to the
      // 30-minute total-runtime cap. This timer still fired at
      // `effectiveTimeout + 2s` and killed it anyway, which put back the exact
      // ceiling #7560 removed and made the new cap unreachable. Worse, it kills
      // via `stopRun`, so the runner finalized the run as a USER CANCEL:
      // `onRunFailed` never fired (no provider bench, no investigation task)
      // and `isRunCanceledError` callers skipped the fallback cascade — a
      // healthy, productive run silently produced nothing. Sixteen NVIDIA NIM
      // nemotron persistent-mind runs died this way at exactly 302s in the two
      // days after #7560 merged, and none before it (#7665).
      const backstopTimeout = apiRunAbsoluteTimeoutMs(effectiveTimeout, absoluteTimeoutMs);
      if (backstopTimeout > 0) apiTimeoutHandle = setTimeout(() => {
        stopRun(runId).catch(() => { /* best-effort cancel */ });
        safeReject(new Error(`API execution timed out after ${backstopTimeout}ms`));
      }, backstopTimeout + API_TIMEOUT_BACKSTOP_GRACE_MS);
      // Thread the caller's effectiveTimeout into the runner's internal timer so
      // a per-call override (e.g. the importer's long stage timeout) governs the
      // ceiling instead of the runner's provider/default fallback — same
      // caller-override precedence CLI/TUI runs already get.
      executeApiRun({ runId, provider: effectiveProvider, model: effectiveModel, prompt, workspacePath: effectiveCwd, screenshots: Array.isArray(screenshots) ? screenshots : [], onData, onComplete, timeout: effectiveTimeout, absoluteTimeoutMs, maxTokens: effectiveProvider === provider ? localBudget.maxTokens : maxTokens, ...(effort ? { effort } : {}), ...(admitDispatch ? { beforeExecute: admitDispatch } : {}) }).catch(safeReject);
    } else if (effectiveProvider.type === PROVIDER_TYPES.TUI) {
      // `source` (e.g. 'pipeline-manuscript-completeness') labels the live,
      // interactive view this TUI run surfaces in the Shell page.
      import('./tuiPromptRunner.js')
        .then(({ executeTuiRun }) => executeTuiRun({ runId, provider: providerForRun, prompt, screenshots, workspacePath: effectiveCwd, onData, onComplete, onReady: onRunReady, timeout: effectiveTimeout, label: source, ...(admitDispatch ? { beforeExecute: admitDispatch } : {}) }))
        .catch(safeReject);
    } else {
      safeReject(new Error(`Unsupported provider type: ${effectiveProvider.type}`));
    }
    }).finally(() => ollamaRun?.release());
  }).finally(() => {
    if (typeof onRunSettled !== 'function') return;
    try { onRunSettled(runId); } catch (err) {
      console.error(`❌ run lifecycle settle hook failed: ${err.message}`);
    }
  });
}
