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
import { resolveEffectiveModel, runPromptThroughProvider, DEFAULT_TIMEOUT_MS } from './promptRunner.js';
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

// Stage config can pin a specific provider via `stage.provider`. If set we
// must use it (or fail) — falling back to the active provider would route
// silently through whatever's currently selected, defeating the override.
async function resolveProviderForStage(stage, { providerOverride } = {}) {
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
  const active = await getActiveProvider().catch(() => null);
  if (active?.enabled) return active;
  throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
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
 *   - providerOverride: explicit provider id, beats stage.provider
 *   - modelOverride: explicit model id, beats stage.model
 *   - timeoutOverride: explicit ms timeout, beats stage.timeout and the provider default
 *   - returnsJson: parse `content` via `extractJson` before returning
 *   - source: free-form tag persisted on the run record (e.g. 'pipeline-text-stage',
 *     'writers-room-evaluate') so /runs is filterable
 */
export async function runStagedLLM(stageName, variables, options = {}) {
  const stage = getStage(stageName);
  const provider = await resolveProviderForStage(stage, options);
  const prompt = await buildPrompt(stageName, variables);
  const resolvedModel = resolveModel(provider, options.modelOverride || stage?.model);
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
    effectiveModel = resolveEffectiveModel(effectiveProvider, resolvedModel);
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
  console.log(`📝 stage: ${effectiveProvider.id} / ${effectiveModel || '(default)'} / ${stageName} → ${runId.slice(0, 8)}`);

  // Stage runs pre-create the run record (so the runId can be logged BEFORE
  // the LLM call starts), then thread that id through the shared runner.
  const { text } = await runPromptThroughProvider({
    provider: effectiveProvider, model: effectiveModel, prompt, source: options.source || 'staged-llm', runId,
    timeout: effectiveTimeout,
  });
  // Codex CLI dumps the full transcript (banner + metadata + echoed prompt +
  // `codex\n<reply>` + token-stats footer). Carve out the assistant reply
  // before either parsing JSON or returning text. Idempotent for non-Codex
  // providers — returns input unchanged when the banner isn't present.
  const cleaned = extractCodexAssistant(text);
  const content = options.returnsJson ? extractJson(cleaned, { promptToStrip: prompt }) : cleaned;
  return { content, model: effectiveModel || null, providerId: effectiveProvider.id, runId };
}
