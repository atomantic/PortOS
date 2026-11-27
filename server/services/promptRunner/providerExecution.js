/** Executes one provider attempt and records the model, resource limits and lifecycle of the run. */

import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';
import { isRuntimeBudgetError } from '../../lib/aiToolkit/errorDetection.js';
import { isOllamaBackedProvider } from '../../lib/aiToolkit/internal/ollamaBacked.js';
import { apiRunAbsoluteTimeoutMs } from '../../lib/aiToolkit/internal/runTimeouts.js';
import { knownContextWindow } from '../../lib/aiToolkit/providerStatus.js';
import { callerModeRejection } from '../../lib/callerModePolicy.js';
import { isVisionCapableCodexTuiProvider } from '../../lib/codex.js';
import { localOutputReserveTokens } from '../../lib/contextBudget.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withLocalConcurrencyGate } from '../../lib/localLlmConcurrency.js';
import { isGenerationModel, isVisionCapableCliProvider } from '../../lib/localModelHeuristics.js';
import { createRun, executeApiRun, executeCliRun, extractBakedModel, hasModelFlag, stopRun, patchRunMetadata, finalizeRunRecord } from '../runner.js';
import { assertRequestFitsContext, buildRequestCapabilities, refusalCapabilities, resolveLocalOutputBudget } from './localBudget.js';

export const DEFAULT_TIMEOUT_MS = 300000;
// Grace past the runner's own API deadline: lets executeApiRun's timers win and classify TIMEOUT;
// the backstop fires only if the runner never reports completion.
const API_TIMEOUT_BACKSTOP_GRACE_MS = 2000;
const APPEND_CHUNK = (acc, chunk) => acc + (typeof chunk === 'string' ? chunk : (chunk?.text || ''));

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
 * Inner helper: execute one attempt against `rawArgs.provider`. Returns
 * { text, runId, model } on success. On failure, throws an Error with
 * `effectiveProvider` and `effectiveModel` attached so the retry path
 * knows which provider actually ran (createRun may have proactively
 * swapped to a fallback when the requested provider was already marked
 * unavailable).
 */
export async function executeProviderRunOnce({
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
  captureClaudeOutputLimit = false,
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
    const { prepareExecutionOptions } = await import('../../lib/provider/providerExecutionOptions.js');
    const prepared = await prepareExecutionOptions(effectiveProvider, effectiveModel, executionOptions, 'run', { cwd: effectiveCwd });
    effectiveProvider = prepared.provider;
    executionAttribution = prepared.attribution;
    effectiveModel = prepared.attribution.model || effectiveModel;
  }
  let runId = callerRunId;
  let proactivelySwapped = false;
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
      proactivelySwapped = true;
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
      const ready = await import('../provider/providerExecutionReadiness.js')
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
      ? await import('../ollamaRunWindow.js').then(({ beginOllamaRun }) => beginOllamaRun(effectiveProvider, effectiveModel))
      : null;
    let dispatchMaxTokens = proactivelySwapped ? maxTokens : localBudget.maxTokens;
    if (ollamaRun && ollamaRun.provider !== effectiveProvider) {
      effectiveProvider = ollamaRun.provider;
      // The resident runner has a smaller window. Reuse the planned reserve as
      // a ceiling so a later window check can only tighten the output cap.
      if (!proactivelySwapped && !(Number.isInteger(maxTokens) && maxTokens > 0)) {
        dispatchMaxTokens = localOutputReserveTokens(localBudget.outputReserveTokens, knownContextWindow(effectiveProvider, effectiveModel))
          ?? dispatchMaxTokens;
      }
    }
    return dispatchProviderRun({
      runId, effectiveProvider, effectiveModel, effectiveCwd, effectiveTimeout, dispatchMaxTokens,
      prompt, screenshots, beforeExecute, onDataCallback, effort, toolFree, allowFallback,
      maxTokens, isolateMtplxOpenCode, captureClaudeOutputLimit, absoluteTimeoutMs, onRunReady, source,
    }).finally(() => ollamaRun?.release());
  }).finally(() => {
    if (typeof onRunSettled !== 'function') return;
    try { onRunSettled(runId); } catch (err) {
      console.error(`❌ run lifecycle settle hook failed: ${err.message}`);
    }
  });
}

function dispatchProviderRun({
  runId, effectiveProvider, effectiveModel, effectiveCwd, effectiveTimeout, dispatchMaxTokens,
  prompt, screenshots, beforeExecute, onDataCallback, effort, toolFree, allowFallback,
  maxTokens, isolateMtplxOpenCode, captureClaudeOutputLimit, absoluteTimeoutMs, onRunReady, source,
}) {
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
          ...(result?.reasoningOutputLimit ? { reasoningOutputLimit: result.reasoningOutputLimit } : {}),
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
        ...(captureClaudeOutputLimit && toolFree && !allowFallback ? { captureClaudeOutputLimit } : {}),
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
      executeApiRun({ runId, provider: effectiveProvider, model: effectiveModel, prompt, workspacePath: effectiveCwd, screenshots: Array.isArray(screenshots) ? screenshots : [], onData, onComplete, timeout: effectiveTimeout, absoluteTimeoutMs, maxTokens: dispatchMaxTokens, ...(effort ? { effort } : {}), ...(admitDispatch ? { beforeExecute: admitDispatch } : {}) }).catch(safeReject);
    } else if (effectiveProvider.type === PROVIDER_TYPES.TUI) {
      // `source` (e.g. 'pipeline-manuscript-completeness') labels the live,
      // interactive view this TUI run surfaces in the Shell page.
      import('../tuiPromptRunner.js')
        .then(({ executeTuiRun }) => executeTuiRun({ runId, provider: providerForRun, prompt, screenshots, workspacePath: effectiveCwd, onData, onComplete, onReady: onRunReady, timeout: effectiveTimeout, label: source, ...(admitDispatch ? { beforeExecute: admitDispatch } : {}) }))
        .catch(safeReject);
    } else {
      safeReject(new Error(`Unsupported provider type: ${effectiveProvider.type}`));
    }
  });
}
