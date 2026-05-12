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
import { extractJson as extractJsonShared } from './jsonExtract.js';
import { providerHonorsModelOverride, runPromptThroughProvider } from './promptRunner.js';
import { getActiveProvider, getProviderById } from '../services/providers.js';
import { buildPrompt, getStage } from '../services/promptService.js';
import { createRun } from '../services/runner.js';

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
 * we have to be defensive. Delegates to `lib/jsonExtract.extractJson` so
 * stages benefit from string-aware brace walking + Codex `}}]` and
 * trailing-comma repairs.
 *
 * Picks `blockType` by peeking at the first JSON delimiter (`{` vs `[`)
 * after stripping fences and any prose prefix. Without this, an array-of-
 * objects response like `[{"a":1}]` would object-walk first, return the
 * inner `{"a":1}`, and silently lose the array wrapper. Falls through to
 * the other shape if the preferred walk produced no parseable block.
 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty AI response');
  // Mirror jsonExtract.extractJson's fence handling so the delimiter peek
  // sees the same string the walker will see.
  let probe = text.trim();
  const fence = probe.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) probe = fence[1].trim();
  const firstObj = probe.indexOf('{');
  const firstArr = probe.indexOf('[');
  const preferArray = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj);
  const primary = preferArray ? 'array' : 'object';
  const secondary = preferArray ? 'object' : 'array';

  const first = extractJsonShared(text, { blockType: primary });
  if (first.value !== undefined) return first.value;
  const second = extractJsonShared(text, { blockType: secondary });
  if (second.value !== undefined) return second.value;
  throw new Error(`Invalid JSON in AI response: ${first.lastError?.message || 'no JSON block found'}`);
}

/**
 * Run a named stage end-to-end. Returns `{ content, model, providerId, runId }`
 * (or the parsed JSON in the `content` field when `returnsJson` is true).
 *
 * Options:
 *   - providerOverride: explicit provider id, beats stage.provider
 *   - modelOverride: explicit model id, beats stage.model
 *   - returnsJson: parse `content` via `extractJson` before returning
 *   - source: free-form tag persisted on the run record (e.g. 'pipeline-text-stage',
 *     'writers-room-evaluate') so /runs is filterable
 */
export async function runStagedLLM(stageName, variables, options = {}) {
  const stage = getStage(stageName);
  const provider = await resolveProviderForStage(stage, options);
  const prompt = await buildPrompt(stageName, variables);
  const resolvedModel = resolveModel(provider, options.modelOverride || stage?.model);
  // Non-codex CLI providers ignore per-call model overrides at the
  // runner.js#buildCliArgs layer, so recording the resolved model in
  // createRun would lie about what actually ran. Drop the override at
  // the record + log boundary for those providers — promptRunner does
  // the same internally. PLAN.md tracks extending buildCliArgs to honor
  // per-call model for all CLI providers; once that lands the gate goes
  // away (and the gemini-cli fast-model fallback can be reintroduced
  // here, since today it would be silently dropped anyway).
  const effectiveModel = providerHonorsModelOverride(provider)
    ? resolvedModel
    : (provider.defaultModel || provider.models?.[0] || null);

  const { runId } = await createRun({
    providerId: provider.id,
    model: effectiveModel,
    prompt,
    source: options.source || 'staged-llm',
  });
  console.log(`📝 stage: ${provider.id} / ${effectiveModel || '(default)'} / ${stageName} → ${runId.slice(0, 8)}`);

  // Stage runs pre-create the run record (so the runId can be logged BEFORE
  // the LLM call starts), then thread that id through the shared runner.
  const { text } = await runPromptThroughProvider({
    provider, model: effectiveModel, prompt, source: options.source || 'staged-llm', runId,
  });
  const content = options.returnsJson ? extractJson(text) : text;
  return { content, model: effectiveModel || null, providerId: provider.id, runId };
}
