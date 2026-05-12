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
import { providerHonorsModelOverride, runPromptThroughProvider } from './promptRunner.js';
import { stripCodeFences } from './aiProvider.js';
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
  // Pass the prompt down so extractJson can strip any echoed copy of
  // it before walking — Codex CLI echoes stdin to stdout, and stage
  // prompts often contain fenced JSON schema examples that would
  // otherwise parse-and-win over the model's actual response.
  const content = options.returnsJson ? extractJson(text, { promptToStrip: prompt }) : text;
  return { content, model: effectiveModel || null, providerId: provider.id, runId };
}
