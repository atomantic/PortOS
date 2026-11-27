/** Settles failed provider runs through same-provider corrections, fallback routing and investigation. */

import { EXECUTION_OPTIONS_ERROR, resolveExecutionOptions } from '../../lib/executionOptions.js';
import { analyzeError, ERROR_CATEGORIES, isRunCanceledError, isRuntimeBudgetError, isContentRefusalError } from '../../lib/aiToolkit/errorDetection.js';
import { getAIToolkitInstance } from '../../lib/aiToolkitState.js';
import { resolveProviderBench } from '../../lib/provider/providerCooldown.js';
import { peekFallbackChain } from '../../lib/provider/providerFallbackChainCache.js';
import { attachGatewaySiblingKey } from '../../lib/provider/providerGateways.js';
import { isCompositeProviderId } from '../../lib/provider/providerRef.js';
import { createSingleFlight } from '../../lib/singleFlight.js';
import { getAllProviders, getProviderById } from '../provider/providers.js';
// initAutoFixer registers these hooks without adding the CoS service to each prompt caller's import graph.
import { getProviderRecoveryHandlers } from '../provider/providerRecoveryHooks.js';
import { attemptConfigCorrection } from './configCorrection.js';
import { buildRequestCapabilities } from './localBudget.js';
import { executeProviderRunOnce, resolveEffectiveModel } from './providerExecution.js';
import { attemptSchemaCorrection, buildSchemaFailureError, correctResponseToSchema } from './schemaRepair.js';

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

export async function recoverProviderFailure(args, rawArgs, firstError) {
  // Stops and caller spending ceilings carry no provider-health verdict.
  // Neither enters correction/fallback, benching, or fault investigation.
  if (firstError?.code === EXECUTION_OPTIONS_ERROR) throw stripFallbackContext(firstError);

  if (isRunCanceledError(firstError) || isRuntimeBudgetError(firstError) || isContentRefusalError(firstError)
    || firstError?.errorAnalysis?.category === ERROR_CATEGORIES.OUTPUT_LIMIT) {
    throw stripFallbackContext(firstError);
  }

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

    const tier2Result = await attemptSchemaCorrection({
      args, rawArgs, failed, failedModel, category, firstError, investigation, primaryKey, stopOnTerminalRequest,
    });
    if (tier2Result) return tier2Result;

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
 * same provider id and request capabilities onto one shared promise. Resolves like `pickFallbackProvider` (null when none);
 * the mark is skipped when no fallback exists, so a provider with no recovery path isn't benched.
 *
 * @param {object} failed — the provider that actually ran and failed
 * @param {Error} firstError — the execution error (carries message + errorAnalysis)
 * @returns {Promise<{ provider: object, model: string|null }|null>}
 */
function coalesceFallbackMarkAndPick(failed, firstError, requestCapabilities) {
  const allowedModes = [...(requestCapabilities?.allowedModes ?? [])].sort().join(',');
  const capabilityKey = `${requestCapabilities?.hasImages === true ? 'images' : 'text'}:${requestCapabilities?.requiredContextTokens || 0}:${allowedModes}`;
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
    await import('../usage.js')
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
