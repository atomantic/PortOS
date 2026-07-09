/**
 * Shared staged-LLM runner.
 *
 * Single entry point for "run a named stage from `data/prompts/stages/` against
 * the active (or stage-pinned) provider, with tier-aware model resolution and
 * runner.js-tracked transcripts." Replaces two parallel implementations:
 *
 *   - server/services/writersRoom/evaluator.js (callApiProvider + callCliProvider
 *     + buildCliInvocation — bypassed runner.js, lost transcript persistence)
 *   - server/services/pipeline/textStages.js#callLLM (already used runner.js but
 *     lacked tier-name resolution and stage.provider pinning)
 *
 * Both call paths now route here so a single CLI-spawn fix applies once and
 * every stage call lands in `data/runs/<runId>/` for replay.
 */

import { ServerError } from './errorHandler.js';
import { findBalancedBlocks, tryParseWithRepair } from './jsonExtract.js';
import { resolveEffectiveModel, runPromptThroughProvider, DEFAULT_TIMEOUT_MS, isLocalEndpoint } from './promptRunner.js';
import { stripCodeFences } from './aiProvider.js';
import { extractCodexAssistant } from './codexAssistantExtract.js';
import { getActiveProvider, getProviderById } from '../services/providers.js';
import { buildPrompt, getStage } from '../services/promptService.js';
import { createRun, patchRunMetadata } from '../services/runner.js';
import { MIN_TIMEOUT as STAGE_TIMEOUT_MIN_MS, MAX_TIMEOUT as STAGE_TIMEOUT_MAX_MS } from './aiToolkit/constants.js';

// Stage configs name a model by tier (PromptManager UI). Map each tier name
// to the provider's per-tier model field; an unset tier falls through to
// `defaultModel`.
const TIER_TO_MODEL_KEY = Object.freeze({
  default: 'defaultModel',
  quick: 'lightModel',
  coding: 'mediumModel',
  heavy: 'heavyModel',
});

const isTierName = (m) => typeof m === 'string' && m in TIER_TO_MODEL_KEY;

// First-element fallback when defaultModel is unset on a provider that
// exposes a `models` array (some toolkit-configured providers ship a model
// list but no explicit default). Without this, API-side runners that require
// an explicit model would receive `null` and 400. Mirrors the older pipeline
// fallback that the shared runner replaced.
const providerFallbackModel = (provider) =>
  provider.defaultModel
  || (Array.isArray(provider.models) && provider.models[0])
  || null;

// Per-call timeout bounds come from the canonical aiToolkit/constants.js
// (imported at the top of the file). The runner, the route validator, and
// the toolkit's own provider/run validation all reject the same shapes.
// Internal callers (extractors, pipeline stages) hit the runner directly,
// so it must enforce the same bounds as the HTTP boundary or a caller
// could slip through a value the schema would reject.

// Normalize a stage- or caller-supplied timeout into a positive integer
// milliseconds value (or `undefined` to mean "fall through to provider
// default"). Reject NaN, non-integer, exponent/hex string forms, and
// anything outside [STAGE_TIMEOUT_MIN_MS, STAGE_TIMEOUT_MAX_MS] — matches
// parseTimeoutMs on the client and the route validator's preprocess. The
// digit-only string gate is critical: `Number('1e3')` is 1000 and
// `Number.isInteger(1000)` is true, so without the gate an internal caller
// passing `'1e3'` would be silently accepted here while the validator
// rejects the same shape.
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
  if (isTierName(modelHint)) {
    return provider[TIER_TO_MODEL_KEY[modelHint]] || providerFallbackModel(provider);
  }
  return modelHint;
}

// Compose the model hint for a stage with soft-default awareness (#1558).
//
// The model dimension is NOT symmetric with the provider dimension. A
// `stage.provider` is opt-in — almost no stage sets one — so a run-level
// `providerDefault` applies to the common (unpinned) case and only loses to the
// rare deliberate `stage.provider` pin. But nearly every stage in the shipped
// `stage-config.json` carries a `stage.model` *tier* value (`default`/`quick`/
// `coding`/`heavy`) — that tier is the model-dimension equivalent of "no
// provider pinned", a default mapping, NOT a deliberate per-stage model choice.
// So a run-level `modelDefault` must OVERRIDE a stage's tier (otherwise
// launching Series Autopilot with a model would be a no-op on ~every stage),
// while still LOSING to a deliberate explicit-model pin (an actual model id like
// `lmstudio:gptoss-20b`, the case #1558 set out to protect).
//
// Precedence, strongest first:
//   1. modelOverride        — hard per-call model id (manual "regenerate with model X")
//   2. explicit stage.model — a deliberate pin (non-tier model id) beats the run default
//   3. modelDefault         — the run-level soft default (Series Autopilot's run model)
//   4. stage.model tier     — the stage's default tier mapping (default/quick/coding/heavy)
//   5. provider default     — resolveModel's own fallback
function resolveModelHint(stage, options = {}) {
  const stageModel = stage?.model;
  const stagePin = stageModel && !isTierName(stageModel) ? stageModel : null;
  const stageTier = isTierName(stageModel) ? stageModel : null;
  return options.modelOverride || stagePin || options.modelDefault || stageTier || null;
}

// A conservative-large window assumed for frontier CLI / cloud-API providers
// that haven't declared one. 128K is below every current frontier model's real
// ceiling (Claude/GPT/Gemini are ≥128K, often ~1M), so it means "a typical
// whole manuscript fits in one call" without over-promising. Users with very
// large manuscripts can set an explicit `contextWindow` to lift it further.
export const DEFAULT_LARGE_CONTEXT_WINDOW = 128_000;
export const CODEX_CONTEXT_WINDOW = 1_000_000;
export const GEMINI_CONTEXT_WINDOW = 1_048_576;
export const GROK_CONTEXT_WINDOW = 256_000;

// Keep in sync with client/src/utils/providers.js.
const KNOWN_MODEL_CONTEXT_WINDOWS = Object.freeze([
  [/gpt[-_.:/]?5\.5(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/gpt[-_.:/]?5\.4[-_.:/]?mini(?:[-_.:/]|\b)/i, 400_000],
  [/gpt[-_.:/]?5\.4(?![-_.:/]?(?:mini|nano))(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/claude[-_.:/]?fable[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?mythos[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?opus[-_.:/]?4[-_.:/]?8/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?4[-_.:/]?6(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?4(?:[-_.:/]|\b)/i, 200_000],
  [/claude[-_.:/]?haiku[-_.:/]?4(?:[-_.:/]|\b)/i, 200_000],
  [/gemini[-_.:/]?2\.5[-_.:/]?pro(?:[-_.:/]|\b)/i, GEMINI_CONTEXT_WINDOW],
]);

export function knownModelContextWindow(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const found = KNOWN_MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model));
  return found ? found[1] : null;
}

export function knownProviderContextWindow(provider) {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return null;
  const id = String(provider?.id || '').toLowerCase();
  const command = String(provider?.command || '').toLowerCase();
  if (id === 'codex' || id === 'codex-tui' || command === 'codex') return CODEX_CONTEXT_WINDOW;
  if (id === 'antigravity-cli' || id === 'antigravity-tui' || command === 'agy') return GEMINI_CONTEXT_WINDOW;
  if (id === 'grok-cli' || id === 'grok-tui' || command === 'grok') return GROK_CONTEXT_WINDOW;
  return null;
}

// The local-backend concurrency gate (cap concurrent in-flight calls per local
// endpoint so N parallel stage calls don't thrash one GPU's VRAM) lives in
// promptRunner.js — the actual execution layer — so it covers the initially
// selected provider, a proactive createRun swap, AND a runtime fallback that
// lands on a local backend. Re-exported here for callers/tests that reference
// the gate by its historical stageRunner path. `isLocalEndpoint` is shared from
// the same module so the context-window heuristic below and the gate agree on
// what "local" means.
export { withLocalConcurrencyGate, LOCAL_LLM_MAX_CONCURRENCY } from './promptRunner.js';
export { isLocalEndpoint };

// CLI/TUI providers (Claude Code, Codex, Antigravity) are frontier models;
// non-local API providers are cloud. Local backends (ollama/lmstudio on
// localhost) are the only genuinely small-window case.
const isLikelyLargeContextProvider = (provider) => {
  if (provider?.type === 'cli' || provider?.type === 'tui') return true;
  if (provider?.type === 'api') return !isLocalEndpoint(provider.endpoint);
  return false;
};

// Planning-time context window for a provider/model: an explicit
// `contextWindow` wins, else a known model window for the resolved model, else
// a known provider-level window for configured-default process providers, else
// the Ollama per-request `numCtx`, else a large default for frontier providers,
// else null (the budgeter applies a conservative floor for unknown local
// backends).
export function effectiveContextWindow(provider, model) {
  if (Number(provider?.contextWindow) > 0) return Number(provider.contextWindow);
  const modelWindow = knownModelContextWindow(model);
  if (modelWindow) return modelWindow;
  const providerWindow = knownProviderContextWindow(provider);
  if (providerWindow) return providerWindow;
  if (Number(provider?.numCtx) > 0) return Number(provider.numCtx);
  if (isLikelyLargeContextProvider(provider)) return DEFAULT_LARGE_CONTEXT_WINDOW;
  return null;
}

/**
 * Resolve which provider/model a stage WOULD run against (without executing)
 * plus its planning context window — for callers that must budget the prompt
 * before building it (e.g. manuscript editorial chunking).
 *
 * Best-effort planning: this resolves the PRIMARY provider; a runtime fallback
 * to a different (possibly smaller-window) provider is not reflected here.
 */
export async function resolveStageContext(stageName, options = {}) {
  const stage = getStage(stageName);
  const provider = await resolveProviderForStage(stage, options);
  const requestedModel = resolveModel(provider, resolveModelHint(stage, options));
  const model = resolveEffectiveModel(provider, requestedModel);
  return { provider, model, contextWindow: effectiveContextWindow(provider, model) };
}

// Provider resolution precedence, strongest first:
//   1. `providerOverride` — an explicit per-call choice ("run THIS request with
//      provider X right now", e.g. a route's regenerate-with-provider button).
//      The most specific signal, so it beats even a stage pin. Throws if the
//      requested provider is unavailable — the caller asked for it by name.
//   2. `stage.provider` — a deliberate per-stage pin (Prompts page /
//      stage-config.json). Beats a blanket run-level default so a pinned stage
//      keeps running on its chosen provider even when something sets a different
//      default for everything else (e.g. Series Autopilot's run provider).
//   3. `providerDefault` — a blanket run-level default that applies ONLY to
//      stages without their own pin. Unlike an override it is a soft preference:
//      if it's unavailable we fall through to the active provider rather than
//      throwing, because it was never a per-call demand.
//   4. The active provider — the system-wide fallback.
async function resolveProviderForStage(stage, { providerOverride, providerDefault } = {}) {
  if (providerOverride) {
    const pinned = await getProviderById(providerOverride).catch(() => null);
    if (pinned?.enabled) return pinned;
    throw new ServerError(
      `Requested provider "${providerOverride}" is not available`,
      { status: 503, code: 'PROVIDER_OVERRIDE_UNAVAILABLE' }
    );
  }
  if (stage?.provider) {
    const pinned = await getProviderById(stage.provider).catch(() => null);
    if (pinned?.enabled) return pinned;
    throw new ServerError(
      `Stage provider "${stage.provider}" is not available — re-pick a provider in Prompts or the stage settings`,
      { status: 503, code: 'STAGE_PROVIDER_UNAVAILABLE' }
    );
  }
  if (providerDefault) {
    const fallback = await getProviderById(providerDefault).catch(() => null);
    if (fallback?.enabled) return fallback;
    // Soft default: an unavailable run default is not a hard error — drop to the
    // active provider below instead of throwing.
  }
  const active = await getActiveProvider().catch(() => null);
  if (active?.enabled) return active;
  throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
}

/**
 * Resolve the JUDGE provider/model for a WRITER stage — the writer/judge model
 * split (#2167, CWQE Phase 3). autonovel found this essential: "the model that
 * evaluates must differ from the model that writes — intentionally different to
 * avoid self-congratulation." A calibrated quality judge scored by the SAME model
 * that drafted the text grades itself generous.
 *
 * A writer stage config may carry `judgeProvider` (and optional `judgeModel`).
 * When set, the judge runs on that provider/model. When UNSET, the judge falls
 * back to the writer stage's own resolved provider/model — a working default that
 * still scores the draft, while the UI encourages the user to configure a
 * different (harsher) judge model.
 *
 * Returns `{ provider, model }` (model may be null → provider's own default).
 * The caller passes these as `providerOverride`/`modelOverride` to
 * `runStagedLLM('pipeline-judge-issue', …)` so the judge PROMPT runs against the
 * resolved judge provider rather than its own stage-config default.
 */
export async function resolveJudgeForStage(stage, options = {}) {
  // An explicit per-call `providerOverride` is a deliberate "judge with THIS
  // provider right now" demand — it beats a stage-level judge pin (mirrors how
  // resolveProviderForStage lets providerOverride beat stage.provider).
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
  // No judge pin (or an explicit override): default to the writer stage's own
  // resolved provider/model. Reuses the exact writer-resolution precedence so the
  // judge lands on the same provider the draft ran on (self-judge fallback) until
  // a distinct judge is configured — the UI encourages picking a harsher model.
  const provider = await resolveProviderForStage(stage, options);
  const model = resolveModel(provider, resolveModelHint(stage, options));
  return { provider, model };
}

/**
 * Extract the first balanced object/array from an LLM response. Some
 * providers prepend explanation prose; the prompt asks for JSON only but
 * we have to be defensive. Walks the same fence-stripped text as
 * `lib/jsonExtract` so stages benefit from string-aware brace walking +
 * Codex `}}]` and trailing-comma repairs.
 *
 * Picks the earliest *parseable* top-level block, regardless of whether
 * it's an object or array. This is the only safe heuristic given:
 *   - Banner lines like `[workdir, /tmp]` precede the real JSON, so
 *     `indexOf('[')` is a lying delimiter peek.
 *   - An object response may legitimately contain an inner array field
 *     (e.g. `{"a":[1,2]}`), and a raw walker run with `blockType: 'array'`
 *     would happily return that `[1,2]` if asked.
 * By gathering balanced candidates for BOTH shapes, parsing each in
 * source order, and returning the first that parses, banners get
 * skipped (their contents don't parse as JSON) and the wrapper shape
 * is preserved (`[{"a":1}]` parses as the array; `{"a":[1,2]}` parses
 * as the object because the `{` opener comes before the inner `[`).
 *
 * When `promptToStrip` is supplied, any verbatim occurrence of that
 * string is removed from `text` BEFORE walking. This handles CLI
 * runners (notably Codex) that echo the input prompt to stdout — the
 * prompt itself frequently contains fenced JSON schema examples that
 * would otherwise parse and win on source-order ranking. Stripping
 * the echo leaves only the model's actual response in the text the
 * walker sees.
 */
export function extractJson(text, { promptToStrip } = {}) {
  if (!text || typeof text !== 'string') throw new Error('Empty AI response');
  if (typeof promptToStrip === 'string' && promptToStrip) {
    // Remove every verbatim occurrence so we don't have to guess where
    // a CLI runner inserted line wrapping or trim. The prompt is fixed
    // text we built ourselves a few lines up — split-join is safer
    // than building a regex (which would need escaping).
    text = text.split(promptToStrip).join('');
  }

  // Trim leading + trailing fences via stripCodeFences (note: it strips
  // each side independently, so a response that only has a leading
  // ```json with no closing fence will still get its opener removed —
  // that's intentional and matches every other JSON-from-LLM helper in
  // the codebase). What we DELIBERATELY do NOT do here is grab the
  // first inner ```…``` fenced block: on Codex CLI runs the prompt
  // itself can echo to stdout before the model response, and many
  // stage prompts contain fenced JSON schema examples that would
  // precede the real answer. Walking the whole text with
  // findBalancedBlocks is safer — an echoed schema either parses
  // (and gets ranked by source order) or fails parse-with-repair and
  // is silently skipped in favor of the real response.
  const s = stripCodeFences(text.trim());

  // Collect candidates of BOTH shapes with their source-text positions.
  // findBalancedBlocks returns block substrings in order; indexOf gives
  // us the start so we can interleave the two shape lists.
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

  // Fall back to the raw text if neither shape walker found anything —
  // the response might still be parseable JSON (e.g. a bare number or
  // string literal). tryParseWithRepair handles those too.
  if (!candidates.length) candidates.push({ block: s, start: 0 });

  let lastError;
  for (const { block } of candidates) {
    const parsed = tryParseWithRepair(block);
    if (!parsed.error) return parsed.value;
    lastError = parsed.error;
  }

  // No fallback to jsonExtract.extractJson here: that helper grabs the
  // first inner ```…``` fenced block, which is exactly the prompt-echo
  // failure mode this implementation was rewritten to avoid. Surface
  // the last parse error from the candidate loop so callers see the
  // concrete reason instead of a generic "no JSON block found".
  throw new Error(`Invalid JSON in AI response: ${lastError?.message || 'no JSON block found'}`);
}

/**
 * Run a named stage end-to-end. Returns `{ content, model, providerId, runId }`
 * (or the parsed JSON in the `content` field when `returnsJson` is true).
 *
 * Options:
 *   - providerOverride: explicit per-call provider id, beats stage.provider
 *   - providerDefault: blanket run-level provider id used ONLY when the stage has
 *     no pin of its own; loses to stage.provider and falls through to the active
 *     provider if unavailable (see resolveProviderForStage)
 *   - modelOverride: explicit model id (hard), beats everything
 *   - modelDefault: blanket run-level model id (Series Autopilot's run model,
 *     #1558). Soft: it OVERRIDES a stage's tier value (default/quick/coding/heavy)
 *     but LOSES to a deliberate explicit-model pin (a non-tier model id) and to a
 *     hard modelOverride. See resolveModelHint for the full precedence — the model
 *     dimension is deliberately NOT symmetric with providerDefault because nearly
 *     every stage carries a tier value while stage.provider is opt-in.
 *   - timeoutOverride: explicit ms timeout, beats stage.timeout and the provider default
 *   - returnsJson: parse `content` via `extractJson` before returning
 *   - source: free-form tag persisted on the run record (e.g. 'pipeline-text-stage',
 *     'writers-room-evaluate') so /runs is filterable
 */
export async function runStagedLLM(stageName, variables, options = {}) {
  const stage = getStage(stageName);
  const prompt = await buildPrompt(stageName, variables);
  return executeStagePrompt({ stage, label: stageName, prompt, options });
}

/**
 * Run an INLINE (caller-supplied) prompt end-to-end — no named stage template.
 * Same provider/model resolution, runner.js transcript persistence, runtime
 * fallback, and JSON extraction as `runStagedLLM`, but the prompt body is passed
 * directly. With no stage there is no stage-pinned provider/model/timeout, so it
 * resolves to `options.providerOverride` (or the active provider). Used by
 * user-defined editorial checks (#1346) whose prompt is authored from the UI.
 *
 * Same options as runStagedLLM (providerOverride / modelOverride /
 * timeoutOverride / returnsJson / source).
 */
export async function runInlineLLM(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ServerError('runInlineLLM requires a non-empty prompt', { status: 400, code: 'INLINE_PROMPT_REQUIRED' });
  }
  return executeStagePrompt({ stage: null, label: options.source || 'inline-llm', prompt, options });
}

/**
 * Run a caller-supplied (inline) prompt but resolve the provider/model/timeout
 * from a NAMED STAGE's pin — not just the active/overridden provider. Use this for
 * an inline helper call that SUPPORTS a stage-pinned check (e.g. a cross-chunk
 * setup summary for an editorial stage pinned to a private local provider): the
 * helper then runs on the SAME provider as the stage, so manuscript text is never
 * silently routed to a different (e.g. cloud) provider than the stage chose. The
 * prompt body is still caller-supplied (no stage template is rendered). With a
 * falsy `stageName` this is identical to `runInlineLLM` (active/overridden provider).
 *
 * Same options as runStagedLLM (providerOverride / modelOverride /
 * timeoutOverride / returnsJson / source).
 */
export async function runStageScopedInlineLLM(stageName, prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ServerError('runStageScopedInlineLLM requires a non-empty prompt', { status: 400, code: 'INLINE_PROMPT_REQUIRED' });
  }
  const stage = stageName ? getStage(stageName) : null;
  return executeStagePrompt({ stage, label: options.source || stageName || 'inline-llm', prompt, options });
}

/**
 * Shared execution body for runStagedLLM / runInlineLLM. Takes an already-built
 * prompt + an optional resolved stage (null for inline), resolves the provider/
 * model/timeout, creates the run record, executes through the shared runner
 * (with runtime fallback reconciliation), and returns
 * `{ content, model, providerId, runId }`. `label` is the free-form name used in
 * the log line (the stage name, or the inline source tag).
 */
async function executeStagePrompt({ stage, label, prompt, options }) {
  const provider = await resolveProviderForStage(stage, options);
  const resolvedModel = resolveModel(provider, resolveModelHint(stage, options));
  // resolveEffectiveModel gates the override per provider type and, for
  // CLI providers with a baked --model/-m flag in args, extracts the
  // args-pinned model id so the run record + log line reflect what
  // truly executes (rather than guessing from defaultModel, which can
  // diverge from the args-baked value).
  let effectiveProvider = provider;
  let effectiveModel = resolveEffectiveModel(effectiveProvider, resolvedModel);

  // Per-stage timeout override; timeoutOverride from the caller beats
  // stage.timeout, which beats the provider default. `normalizeTimeout`
  // coerces via `Number(...)` (so legacy stringified values from
  // pre-validation installs still resolve), rejects non-finite or ≤0
  // (so a stray "0" can't silently instant-cancel), and caps at
  // STAGE_TIMEOUT_MAX_MS — applied to BOTH stage.timeout and the caller
  // override, since `runPromptThroughProvider`/`executeCliRun` treat `0`
  // as "no timeout" and would happily run unbounded if we forwarded a
  // garbage override.
  const stageTimeout = normalizeTimeout(stage?.timeout);
  const overrideTimeout = normalizeTimeout(options.timeoutOverride);
  const effectiveTimeout = overrideTimeout ?? stageTimeout;

  // createRun may pick a fallback provider when the requested one is marked
  // unavailable by providerStatusService. Capture the full result and
  // reconcile, mirroring the promptRunner.js#createRun caller-runId path —
  // otherwise execution would proceed against the original provider while
  // /runs metadata claims the fallback ran. Pass `timeout` with a fallback
  // to `provider.timeout` so the run record's persisted timeout reflects
  // what executeXxxRun actually enforces (the runner falls back to
  // `effectiveProvider.timeout` when no override is set — mirror that here
  // so the recorded value isn't a misleading `undefined`).
  const runResult = await createRun({
    providerId: provider.id,
    model: effectiveModel,
    prompt,
    source: options.source || 'staged-llm',
    // createRun.timeout is returned but not persisted into metadata.json
    // by the toolkit (only providerId/model/source/etc. are written at
    // creation time). We always patch below to record the effective
    // timeout so /runs can show what executeXxxRun actually enforced.
    timeout: effectiveTimeout ?? provider.timeout ?? DEFAULT_TIMEOUT_MS,
  });
  const { runId } = runResult;
  const fellBack = runResult.provider && runResult.provider.id !== provider.id;
  if (fellBack) {
    effectiveProvider = runResult.provider;
    // Re-resolve against the FALLBACK provider. Do NOT pass `resolvedModel` —
    // that was resolved against the PRIMARY (e.g. codex's
    // `codex-configured-default`) and forwarding it leaks a model id the
    // fallback can't run. Prefer the configured `fallbackModel`; null falls
    // through to the fallback provider's own default / args-baked model.
    effectiveModel = resolveEffectiveModel(effectiveProvider, runResult.fallbackModel ?? null);
  }
  // Always patch metadata with the effective timeout (the toolkit doesn't
  // persist `timeout` in its initial metadata.json write). On fallback we
  // also patch provider id/name/model so /runs attribution matches the
  // provider that actually ran. Best-effort: attribution, not load-bearing.
  const recordedTimeout = effectiveTimeout ?? effectiveProvider.timeout ?? DEFAULT_TIMEOUT_MS;
  const metadataPatch = { timeout: recordedTimeout };
  if (fellBack) {
    metadataPatch.model = effectiveModel;
    metadataPatch.providerId = effectiveProvider.id;
    metadataPatch.providerName = effectiveProvider.name;
  }
  patchRunMetadata(runId, metadataPatch).catch(() => { /* best-effort */ });
  console.log(`📝 stage: ${effectiveProvider.id} / ${effectiveModel || '(default)'} / ${label} → ${runId.slice(0, 8)}`);

  // Stage runs pre-create the run record (so the runId can be logged BEFORE
  // the LLM call starts), then thread that id through the shared runner.
  // On runtime fallback (primary attempted + failed, fallback retried + won)
  // `runPromptThroughProvider` ignores our pre-created `runId` and creates
  // a fresh one for the fallback's record — so the successful output lives
  // at `result.runId`, NOT the `runId` we passed in. The pre-created record
  // stays as the failed-primary entry. Capture the post-fallback attribution
  // (runId / model / providerId) here so the persisted stage result points
  // at the run that actually produced the text — otherwise pipeline history
  // / restore links land on a failed record.
  // The local-backend concurrency gate is applied INSIDE runPromptThroughProvider
  // (around each actual execution — primary, proactive swap, and runtime
  // fallback), so we do NOT wrap here: a second gate on the same local endpoint
  // would deadlock against the inner one (outer holds the only slot, inner waits
  // forever).
  const runResult2 = await runPromptThroughProvider({
    provider: effectiveProvider, model: effectiveModel, prompt, source: options.source || 'staged-llm', runId,
    timeout: effectiveTimeout,
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
  // Codex CLI dumps the full transcript (banner + metadata + echoed prompt +
  // `codex\n<reply>` + token-stats footer). Carve out the assistant reply
  // before either parsing JSON or returning text. Idempotent for non-Codex
  // providers — returns input unchanged when the banner isn't present.
  const cleaned = extractCodexAssistant(text);
  const content = options.returnsJson ? extractJson(cleaned, { promptToStrip: prompt }) : cleaned;
  return { content, model: finalModel || null, providerId: finalProvider.id, runId: finalRunId };
}
