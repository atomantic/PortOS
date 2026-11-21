/**
 * Shared staged-LLM runner.
 *
 * Single entry point for "run a named stage from `data/prompts/stages/` against
 * the active (or stage-pinned) provider, with tier-aware model resolution and
 * runner.js-tracked transcripts." Every stage call lands in `data/runs/<runId>/`
 * for replay.
 */

import { callerModeRejection } from '../lib/callerModePolicy.js';
import { isProcessProvider } from '../lib/provider/providerTypes.js';
import { ServerError } from '../lib/errorHandler.js';
import { findBalancedBlocks, tryParseWithRepair } from '../lib/jsonExtract.js';
import { buildRequestCapabilities, resolveEffectiveModel, runPromptThroughProvider, DEFAULT_TIMEOUT_MS, isLocalEndpoint, withObservedContextWindowsLazy } from './promptRunner.js';
import { stripCodeFences } from '../lib/llmText.js';
import { extractCodexAssistant } from '../lib/codexAssistantExtract.js';
import { getActiveProvider, getProviderById } from './provider/providers.js';
import { buildPrompt, getStage } from './promptService.js';
import { stagePinsIgnored } from '../lib/stagePinPolicy.js';
import {
  DEFAULT_LARGE_CONTEXT_WINDOW,
  knownModelContextWindow,
  knownProviderContextWindow,
  catalogModelContextWindow,
} from '../lib/provider/providerContextWindows.js';
// The Ollama `num_ctx` ceiling, resolved through the same module as the pre-dispatch gate so
// budgeter and gate agree (#7466). The dependency-free `internal/` leaf, not the toolkit barrel
// (which reaches `fs`/`child_process`; this module is inside the server suite's import budget).
import { clampToRuntimeContextWindow, withModelNumCtx } from '../lib/aiToolkit/internal/ollamaBacked.js';
// …and the rung the toolkit cannot resolve itself: the ambient `OLLAMA_CONTEXT_LENGTH` (#7472).
import { withOllamaRuntimeContextWindow } from '../lib/ollamaContext.js';
import { createRun, patchRunMetadata } from './runner.js';
import { canonicalStageModelTier, isStageModelTier } from '../lib/stageModelTiers.js';
import { resolveProviderModelTier, MIN_TIMEOUT as STAGE_TIMEOUT_MIN_MS, MAX_TIMEOUT as STAGE_TIMEOUT_MAX_MS } from '../lib/aiToolkit/constants.js';

// Every stage-config field that names a ROUTE. `withStagePinsIgnored` (lib/stagePinPolicy.js)
// strips exactly these, so a run told to use ONE provider/model does. Enumerated once here:
// a new routing pin is added to this list and nowhere else.
const ROUTING_PIN_FIELDS = Object.freeze(['provider', 'effort', 'judgeProvider', 'judgeModel']);

// The stage as the resolvers should see it: identity unless the run ignores pins, in which
// case the routing fields above are dropped. Two fields SURVIVE: a `model` TIER (a
// per-provider mapping, not a pin; only an explicit model id is dropped) and `timeout`
// (how long the stage's WORK takes; dropping it would abort long stages).
export function effectiveStage(stage) {
  if (!stage || !stagePinsIgnored()) return stage;
  const stripped = { ...stage };
  for (const field of ROUTING_PIN_FIELDS) delete stripped[field];
  if (stripped.model && !isStageModelTier(stripped.model)) delete stripped.model;
  return stripped;
}

// First-element fallback when a provider ships a `models` array but no default; API runners
// that require an explicit model would otherwise receive `null` and 400.
const providerFallbackModel = (provider) =>
  provider.defaultModel
  || (Array.isArray(provider.models) && provider.models[0])
  || null;

// Timeout bounds come from aiToolkit/constants.js. Internal callers hit the runner directly,
// so it must enforce the same bounds as the HTTP boundary.

// Normalize a timeout into a positive integer ms (or `undefined` → provider default). Rejects
// NaN, non-integers, exponent/hex strings and anything outside [STAGE_TIMEOUT_MIN_MS,
// STAGE_TIMEOUT_MAX_MS], matching the client and route validator. The digit-only string gate
// matters: `Number('1e3')` is an integer 1000 the validator would reject.
function normalizeTimeout(raw) {
  if (raw == null) return undefined;
  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    n = Number(raw.trim());
  } else {
    return undefined;
  }
  if (!Number.isInteger(n) || n < STAGE_TIMEOUT_MIN_MS || n > STAGE_TIMEOUT_MAX_MS) return undefined;
  return n;
}

export function resolveModel(provider, modelHint) {
  if (!modelHint) return providerFallbackModel(provider);
  if (isStageModelTier(modelHint)) {
    return resolveProviderModelTier(provider, canonicalStageModelTier(modelHint)) || providerFallbackModel(provider);
  }
  return modelHint;
}

// Compose the model hint for a stage with soft-default awareness (#1558).
//
// Not symmetric with the provider dimension: nearly every stage carries a `stage.model`
// *tier* (a default mapping, not a deliberate choice), so a run-level `modelDefault` must
// OVERRIDE a tier while still LOSING to an explicit model-id pin.
//
// Precedence, strongest first:
//   1. modelOverride        — hard per-call model id
//   2. explicit stage.model — a deliberate (non-tier) pin
//   3. modelDefault         — the run-level soft default
//   4. stage.model tier     — the stage's default tier mapping
//   5. provider default     — resolveModel's own fallback
//
// Takes an `effectiveStage`-masked stage, so step 2 is gone for a run that forced one model.
function resolveModelHint(stage, options = {}) {
  const stageModel = stage?.model;
  const stagePin = stageModel && !isStageModelTier(stageModel) ? stageModel : null;
  const stageTier = isStageModelTier(stageModel) ? stageModel : null;
  return options.modelOverride || stagePin || options.modelDefault || stageTier || null;
}

// Compose the reasoning-effort hint for a stage (#3641).
//
// Symmetric with the PROVIDER dimension: `stage.effort` is always a deliberate pin, so it
// beats the run-level default.
//
// Precedence, strongest first:
//   1. effortOverride — hard per-call effort
//   2. stage.effort   — a deliberate per-stage pin
//   3. effortDefault  — the run-level soft default
//   4. null           — no flag; the provider's own config decides
//
// Safe to pass unconditionally: `runPromptThroughProvider` clamps it to the provider's
// ladder and drops it for a provider with no effort control. Takes an `effectiveStage`-masked stage.
export function resolveEffortHint(stage, options = {}) {
  return options.effortOverride || stage?.effort || options.effortDefault || null;
}

// The local-backend concurrency gate lives in promptRunner.js (the execution layer, covering
// swaps and runtime fallbacks).
// `isLocalEndpoint` is shared so the context-window heuristic below agrees on "local".
export { isLocalEndpoint };

// CLI/TUI providers are frontier models and non-local API providers are cloud; only local
// backends are the small-window case.
const isLikelyLargeContextProvider = (provider) => {
  if (isProcessProvider(provider)) return true;
  if (provider?.type === 'api') return !isLocalEndpoint(provider.endpoint);
  return false;
};

// Which window this provider/model CLAIMS, before the runtime ceiling: explicit
// `contextWindow`, then the provider catalog's window, a known model window, a known
// provider window, `numCtx`, a large frontier default, else null (the budgeter applies a
// floor). Rungs live in lib/provider/providerContextWindows.js, shared with the browser's meter.
// `numCtx` only DECIDES for a non-Ollama local endpoint; on Ollama the clamp already bounds it.
function claimedContextWindow(provider, model) {
  if (Number(provider?.contextWindow) > 0) return Number(provider.contextWindow);
  const catalogWindow = catalogModelContextWindow(provider, model);
  if (catalogWindow) return catalogWindow;
  const modelWindow = knownModelContextWindow(model);
  if (modelWindow) return modelWindow;
  const providerWindow = knownProviderContextWindow(provider);
  if (providerWindow) return providerWindow;
  if (Number(provider?.numCtx) > 0) return Number(provider.numCtx);
  if (isLikelyLargeContextProvider(provider)) return DEFAULT_LARGE_CONTEXT_WINDOW;
  return null;
}

/**
 * Planning-time context window for a provider/model — what the prompt budgeter
 * chunks against: the claimed window held to what the daemon will actually serve
 * (the ceiling bounds every rung, an explicit override included; see
 * {@link clampToRuntimeContextWindow}).
 *
 * The provider is projected through `withOllamaRuntimeContextWindow` first so the
 * ceiling sees both `numCtx` and the ambient `OLLAMA_CONTEXT_LENGTH` (#7472). The
 * projection is in-memory and never persisted; `resolveStageContext` must not do
 * it itself because both of its branches need the same ceiling.
 */
export function effectiveContextWindow(provider, model) {
  const runtime = withOllamaRuntimeContextWindow(withModelNumCtx(provider, model));
  return clampToRuntimeContextWindow(runtime, claimedContextWindow(runtime, model));
}

/**
 * Resolve which provider/model a stage WOULD run against (without executing)
 * plus its planning context window, for callers that budget the prompt before
 * building it (e.g. manuscript editorial chunking). Resolves the PRIMARY
 * provider; a smaller-window runtime fallback is not reflected.
 *
 * Use {@link resolveStageRoute} when only the route is needed; it makes no
 * network call.
 */
export async function resolveStageRoute(stageName, options = {}) {
  const stage = effectiveStage(getStage(stageName));
  const provider = await resolveProviderForStage(stage, options);
  const requestedModel = resolveModel(provider, resolveModelHint(stage, options));
  return { provider, model: resolveEffectiveModel(provider, requestedModel) };
}

/**
 * {@link resolveStageRoute} plus the window to budget the prompt against,
 * measured against what a local daemon is SERVING now (the pre-dispatch gate,
 * #7441, reads the same live listing and would refuse an oversized prompt). The
 * listing is TTL-cached and shared with that gate (one `/v1/models` per endpoint
 * per 15s); a down or silent daemon contributes nothing.
 *
 * `provider` is returned UNMERGED: observed runtime state must not ride a
 * provider record around.
 */
export async function resolveStageContext(stageName, options = {}) {
  const { provider, model } = await resolveStageRoute(stageName, options);
  // An explicit `contextWindow` short-circuits the first rung, so observing could not change the
  // answer: skip the probe. (The `numCtx` ceiling reads the provider RECORD and still applies.)
  if (Number(provider?.contextWindow) > 0) {
    return { provider, model, contextWindow: effectiveContextWindow(provider, model) };
  }
  // Budget-only enrichment: a probe or module-load failure must not become a planning failure.
  const observed = await withObservedContextWindowsLazy(provider).catch(() => provider);
  return { provider, model, contextWindow: effectiveContextWindow(observed, model) };
}

// Provider resolution precedence, strongest first:
//   1. `providerOverride` — explicit per-call choice; beats even a stage pin. Throws if
//      unavailable, since the caller asked for it by name.
//   2. `stage.provider` — a deliberate per-stage pin; beats a run-level default.
//   3. `providerDefault` — a run-level default for unpinned stages only. Soft: if
//      unavailable, fall through to the active provider rather than throw.
//   4. The active provider — the system-wide fallback.
//
// Takes an `effectiveStage`-masked stage; the pin is *stripped*, not demoted, so a run that
// forced one provider also stops throwing STAGE_PROVIDER_UNAVAILABLE for a vanished pin.
async function resolveProviderForStage(stage, { providerOverride, providerDefault, callerPolicy } = {}) {
  const permitted = (provider) => {
    const rejection = callerPolicy ? callerModeRejection(provider, callerPolicy) : null;
    if (rejection) throw new ServerError(`Provider "${provider.id}" ${rejection.reason}`, {
      status: 422, code: 'PROVIDER_MODE_NOT_PERMITTED',
    });
    return provider;
  };
  if (providerOverride) {
    const pinned = await getProviderById(providerOverride).catch(() => null);
    if (pinned?.enabled) return permitted(pinned);
    throw new ServerError(
      `Requested provider "${providerOverride}" is not available`,
      { status: 503, code: 'PROVIDER_OVERRIDE_UNAVAILABLE' }
    );
  }
  if (stage?.provider) {
    const pinned = await getProviderById(stage.provider).catch(() => null);
    if (pinned?.enabled) return permitted(pinned);
    throw new ServerError(
      `Stage provider "${stage.provider}" is not available — re-pick a provider in Prompts or the stage settings`,
      { status: 503, code: 'STAGE_PROVIDER_UNAVAILABLE' }
    );
  }
  if (providerDefault) {
    const fallback = await getProviderById(providerDefault).catch(() => null);
    if (fallback?.enabled) return permitted(fallback);
    // Soft default: drop to the active provider rather than throw.
  }
  const active = await getActiveProvider().catch(() => null);
  if (active?.enabled) return permitted(active);
  throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
}

/**
 * Resolve the JUDGE provider/model for a WRITER stage — the writer/judge split
 * (#2167): the model that evaluates must differ from the one that writes, or it
 * grades itself generous.
 *
 * A writer stage config may carry `judgeProvider` (and optional `judgeModel`);
 * when UNSET the judge falls back to the writer's own resolved provider/model.
 *
 * Returns `{ provider, model }` (model may be null → provider's own default); the
 * caller passes them as `providerOverride`/`modelOverride` to
 * `runStagedLLM('pipeline-judge-issue', …)`.
 */
export async function resolveJudgeForStage(stage, options = {}) {
  // An explicit per-call `providerOverride` beats a stage-level judge pin. The stage is masked
  // first because it is CALLER-supplied: a run that forced one route loses the judge pin and
  // falls through to writer resolution, collapsing the split unless the run set its own
  // judge route (which sets `providerOverride` and short-circuits above).
  stage = effectiveStage(stage);
  if (!options.providerOverride && stage?.judgeProvider) {
    const pinned = await getProviderById(stage.judgeProvider).catch(() => null);
    if (pinned?.enabled) {
      return { provider: pinned, model: resolveModel(pinned, stage.judgeModel || null) };
    }
    throw new ServerError(
      `Judge provider "${stage.judgeProvider}" is not available — re-pick a judge provider in the stage settings`,
      { status: 503, code: 'STAGE_JUDGE_PROVIDER_UNAVAILABLE' }
    );
  }
  // No judge pin or override: self-judge fallback via the writer's resolution precedence.
  const provider = await resolveProviderForStage(stage, options);
  const model = resolveModel(provider, resolveModelHint(stage, options));
  return { provider, model };
}

/**
 * Extract the first balanced object/array from an LLM response. Walks the same
 * fence-stripped text as `lib/jsonExtract` (string-aware brace walking, Codex
 * `}}]` and trailing-comma repairs).
 *
 * Picks the earliest *parseable* top-level block of either shape: banner lines
 * like `[workdir, /tmp]` make `indexOf('[')` lie, and an object may contain an
 * inner array (`{"a":[1,2]}`). Candidates of BOTH shapes are parsed in source
 * order, so banners are skipped and the wrapper shape is preserved.
 *
 * `promptToStrip` is removed verbatim from `text` BEFORE walking: CLI runners
 * (notably Codex) echo the prompt, whose fenced JSON schema examples would
 * otherwise win on source order.
 */
export function extractJson(text, { promptToStrip } = {}) {
  if (!text || typeof text !== 'string') throw new Error('Empty AI response');
  if (typeof promptToStrip === 'string' && promptToStrip) {
    // Verbatim split-join: the prompt is fixed text we built, and a regex would need escaping.
    text = text.split(promptToStrip).join('');
  }

  // Trim leading/trailing fences via stripCodeFences (each side independently, so a lone
  // leading ```json is still removed). Deliberately NOT the first inner fenced block: an
  // echoed prompt's schema examples would precede the real answer. Walking the whole text is
  // safer, since an echoed schema either parses (ranked by source order) or is skipped.
  const s = stripCodeFences(text.trim());

  // Collect candidates of BOTH shapes with source positions (indexOf gives the start).
  const candidates = [];
  let cursor = 0;
  for (const block of findBalancedBlocks(s, { startChar: '{', endChar: '}' })) {
    const idx = s.indexOf(block, cursor);
    candidates.push({ block, start: idx });
    cursor = idx + block.length;
  }
  cursor = 0;
  for (const block of findBalancedBlocks(s, { startChar: '[', endChar: ']' })) {
    const idx = s.indexOf(block, cursor);
    candidates.push({ block, start: idx });
    cursor = idx + block.length;
  }
  candidates.sort((a, b) => a.start - b.start);

  // Fall back to the raw text: it may still be a bare number or string literal.
  if (!candidates.length) candidates.push({ block: s, start: 0 });

  let lastError;
  for (const { block } of candidates) {
    const parsed = tryParseWithRepair(block);
    if (!parsed.error) return parsed.value;
    lastError = parsed.error;
  }

  // No fallback to jsonExtract.extractJson (it grabs the first inner fenced block, the
  // prompt-echo failure mode). Surface the last parse error for a concrete reason.
  throw new Error(`Invalid JSON in AI response: ${lastError?.message || 'no JSON block found'}`);
}

/**
 * Run a named stage end-to-end. Returns `{ content, model, providerId, runId }`
 * (or the parsed JSON in `content` when `returnsJson` is true).
 *
 * Options:
 *   - providerOverride: explicit per-call provider id, beats stage.provider
 *   - providerDefault: run-level provider id used ONLY when the stage has no pin;
 *     falls through to the active provider if unavailable (resolveProviderForStage)
 *   - modelOverride: explicit model id (hard), beats everything
 *   - modelDefault: run-level model id (#1558). Soft: overrides a stage's tier
 *     value but loses to an explicit-model pin and to modelOverride
 *     (see resolveModelHint)
 *   - effortOverride: explicit per-call reasoning effort (hard), beats a stage pin
 *   - effortDefault: run-level reasoning effort (#3641). Soft: only for stages with
 *     no `stage.effort` pin; the runner clamps or drops it (see resolveEffortHint)
 *   - timeoutOverride: explicit ms timeout, beats stage.timeout and the provider default
 *   - maxTokens: API output cap, when the caller budgets an output reserve
 *   - callerPolicy: server-selected execution-mode policy, enforced on pins and every fallback
 *   - returnsJson: parse `content` via `extractJson` before returning
 *   - source: free-form tag persisted on the run record so /runs is filterable
 */
export async function runStagedLLM(stageName, variables, options = {}) {
  const stage = effectiveStage(getStage(stageName));
  const prompt = await buildPrompt(stageName, variables);
  return executeStagePrompt({ stage, label: stageName, prompt, options });
}

/**
 * Run an INLINE (caller-supplied) prompt end-to-end — no named stage template.
 * Same resolution, transcript persistence, fallback and JSON extraction as
 * `runStagedLLM`; with no stage there is no pinned provider/model/timeout, so it
 * resolves to `options.providerOverride` (or the active provider). Used by
 * user-defined editorial checks (#1346).
 *
 * Same options as runStagedLLM plus `allowFallback`: pass `false` when the caller
 * budgeted an already-rendered prompt against the resolved provider and a
 * smaller fallback could not accept it.
 */
export async function runInlineLLM(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ServerError('runInlineLLM requires a non-empty prompt', { status: 400, code: 'INLINE_PROMPT_REQUIRED' });
  }
  return executeStagePrompt({ stage: null, label: options.source || 'inline-llm', prompt, options });
}

/**
 * Run a caller-supplied (inline) prompt but resolve the provider/model/timeout
 * from a NAMED STAGE's pin, so an inline helper for a stage pinned to a private
 * local provider runs on the SAME provider as the stage and manuscript text is
 * never routed elsewhere. With a falsy `stageName` this equals `runInlineLLM`.
 *
 * The guarantee is only as strong as the pin: inside `withStagePinsIgnored` this
 * follows the run's provider (see lib/stagePinPolicy.js).
 *
 * Same options as runStagedLLM.
 */
export async function runStageScopedInlineLLM(stageName, prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ServerError('runStageScopedInlineLLM requires a non-empty prompt', { status: 400, code: 'INLINE_PROMPT_REQUIRED' });
  }
  const stage = stageName ? effectiveStage(getStage(stageName)) : null;
  return executeStagePrompt({ stage, label: options.source || stageName || 'inline-llm', prompt, options });
}

/**
 * Shared execution body for runStagedLLM / runInlineLLM: takes a built prompt and
 * an optional resolved stage (null for inline), resolves provider/model/timeout,
 * creates the run record, executes through the shared runner (with runtime
 * fallback reconciliation), and returns `{ content, model, providerId, runId }`.
 * `label` names the log line.
 */
async function executeStagePrompt({ stage, label, prompt, options }) {
  const provider = await resolveProviderForStage(stage, options);
  const resolvedModel = resolveModel(provider, resolveModelHint(stage, options));
  const effectiveEffort = resolveEffortHint(stage, options);
  // resolveEffectiveModel gates the override per provider type and extracts a CLI provider's
  // args-baked model id, so the record reflects what truly executes.
  let effectiveProvider = provider;
  let effectiveModel = resolveEffectiveModel(effectiveProvider, resolvedModel);

  // timeoutOverride beats stage.timeout beats the provider default. `normalizeTimeout` accepts
  // legacy stringified values, rejects non-finite or ≤0 (a "0" must not instant-cancel) and
  // caps at STAGE_TIMEOUT_MAX_MS for BOTH sources, since the runner treats `0` as no timeout.
  const stageTimeout = normalizeTimeout(stage?.timeout);
  const overrideTimeout = normalizeTimeout(options.timeoutOverride);
  const effectiveTimeout = overrideTimeout ?? stageTimeout;

  // createRun may pick a fallback provider when the requested one is unavailable. Capture the
  // result and reconcile (as promptRunner.js#createRun does) so /runs doesn't claim the
  // fallback ran while the original executes. `timeout` falls back to `provider.timeout`,
  // mirroring the runner, so the recorded value isn't `undefined`.
  const runResult = await createRun({
    providerId: provider.id,
    // Constrain this proactive swap too.
    ...(options.callerPolicy ? { requestCapabilities: buildRequestCapabilities({ prompt, callerPolicy: options.callerPolicy }) } : {}),
    model: effectiveModel,
    prompt,
    source: options.source || 'staged-llm',
    effort: effectiveEffort,
    allowFallback: options.allowFallback !== false,
    // createRun.timeout is not persisted into metadata by the toolkit; patched below.
    timeout: effectiveTimeout ?? provider.timeout ?? DEFAULT_TIMEOUT_MS,
  });
  const { runId } = runResult;
  const fellBack = runResult.provider && runResult.provider.id !== provider.id;
  if (fellBack) {
    effectiveProvider = runResult.provider;
  // Re-resolve against the FALLBACK provider without `resolvedModel` (resolved for the
  // PRIMARY; it would leak a model id the fallback can't run). Prefer `fallbackModel`.
    effectiveModel = resolveEffectiveModel(effectiveProvider, runResult.fallbackModel ?? null);
  }
  // Always patch the effective timeout; on fallback also provider id/name/model so /runs
  // attribution matches. Best-effort, not load-bearing.
  const recordedTimeout = effectiveTimeout ?? effectiveProvider.timeout ?? DEFAULT_TIMEOUT_MS;
  const metadataPatch = { timeout: recordedTimeout, effort: effectiveEffort };
  if (fellBack) {
    metadataPatch.model = effectiveModel;
    metadataPatch.providerId = effectiveProvider.id;
    metadataPatch.providerName = effectiveProvider.name;
  }
  patchRunMetadata(runId, metadataPatch).catch(() => { /* best-effort */ });
  console.log(`📝 stage: ${effectiveProvider.id} / ${effectiveModel || '(default)'} / ${label} → ${runId.slice(0, 8)}`);

  // The run record is pre-created so the runId can be logged BEFORE the call. On runtime
  // fallback `runPromptThroughProvider` creates a fresh record, so the output lives at
  // `result.runId`, not the id we passed; capture the post-fallback attribution so history
  // links don't land on the failed primary. The local-backend concurrency gate is applied
  // INSIDE runPromptThroughProvider; wrapping here would deadlock against the inner one.
  const runResult2 = await runPromptThroughProvider({
    provider: effectiveProvider, model: effectiveModel, prompt, source: options.source || 'staged-llm', runId,
    timeout: effectiveTimeout,
    maxTokens: options.maxTokens,
    callerPolicy: options.callerPolicy,
    // Always passed: the runner clamps it or omits the flag for a provider with no effort control.
    effort: effectiveEffort,
    allowFallback: options.allowFallback !== false,
    onRunCreated: options.onRunCreated,
    onRunReady: options.onRunReady,
    onRunSettled: options.onRunSettled,
  });
  const { text } = runResult2;
  let finalRunId = runId;
  let finalProvider = effectiveProvider;
  let finalModel = effectiveModel;
  if (runResult2.usedFallback && runResult2.fallbackProvider) {
    finalRunId = runResult2.runId;
    finalProvider = runResult2.fallbackProvider;
    finalModel = runResult2.model ?? finalModel;
    console.log(`⚡ stage fallback succeeded: ${finalProvider.id} / ${finalModel || '(default)'} / ${label} → ${finalRunId.slice(0, 8)}`);
  }
  // Codex CLI dumps banner + metadata + echoed prompt + reply + footer: carve out the reply.
  // Idempotent for other providers.
  const cleaned = extractCodexAssistant(text);
  const content = options.returnsJson ? extractJson(cleaned, { promptToStrip: prompt }) : cleaned;
  return { content, model: finalModel || null, providerId: finalProvider.id, runId: finalRunId,
    ...(runResult2.finishReason ? { finishReason: runResult2.finishReason } : {}),
  };
}
