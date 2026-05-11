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
import { stripCodeFences } from './aiProvider.js';
import { getActiveProvider, getProviderById } from '../services/providers.js';
import { buildPrompt, getStage } from '../services/promptService.js';
import { createRun, executeApiRun, executeCliRun } from '../services/runner.js';

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

export function resolveModel(provider, modelHint) {
  if (!modelHint) return provider.defaultModel || null;
  if (isTierName(modelHint)) {
    return provider[TIER_TO_MODEL_KEY[modelHint]] || provider.defaultModel || null;
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

// Wraps executeApiRun / executeCliRun as a Promise so callers can await one
// completion. Mirrors the pattern in worldBuilderExpand.js#callLLM — both
// runner entry points are async and can reject before onComplete fires, so
// we forward those rejections through the outer Promise instead of letting
// them surface as unhandledRejection (Node ≥15 process-killer).
function awaitRunnerCall({ provider, model, prompt, runId, source }) {
  return new Promise((resolve, reject) => {
    let text = '';
    if (provider.type === 'cli') {
      // executeCliRun reads `provider.defaultModel` for both the CLI args
      // (`buildCliArgs(provider)`) and the run-started metadata hook. The
      // toolkit's CLI entry doesn't accept a separate model param, so to
      // honor a stage-level model override (or a tier-name resolution like
      // `model: 'heavy'`) we hand it a shallow clone with the resolved
      // model in `defaultModel`. Without this, `runStagedLLM(..., { modelOverride: 'codex-mini' })`
      // would silently fall back to the provider's stock default AND the
      // run record would log the wrong model.
      const providerForCli = model && model !== provider.defaultModel
        ? { ...provider, defaultModel: model }
        : provider;
      executeCliRun(
        runId,
        providerForCli,
        prompt,
        process.cwd(),
        (chunk) => { text += chunk; },
        (result) => {
          if (result?.error || result?.success === false) {
            reject(new Error(result?.error || 'CLI execution failed'));
          } else {
            resolve(text);
          }
        },
        providerForCli.timeout ?? 300000,
      ).catch(reject);
    } else if (provider.type === 'api') {
      executeApiRun(
        runId,
        provider,
        model,
        prompt,
        process.cwd(),
        [],
        (data) => { text += typeof data === 'string' ? data : (data?.text || ''); },
        (result) => {
          if (result?.error) reject(new Error(result.error));
          else resolve(text);
        },
      ).catch(reject);
    } else {
      reject(new Error(`Unsupported provider type: ${provider.type}`));
    }
  });
}

/**
 * Extract the first balanced object/array from an LLM response. Some
 * providers prepend explanation prose; the prompt asks for JSON only but
 * we have to be defensive. Lifted from the writers-room evaluator so the
 * pipeline gets the same lenient parser when it eventually requests JSON.
 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty AI response');
  let str = stripCodeFences(text);
  const objMatch = str.match(/[{[][\s\S]*[\]}]/);
  if (objMatch) str = objMatch[0];
  return JSON.parse(str);
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
  let model = resolveModel(provider, options.modelOverride || stage?.model);
  // Special case: gemini-cli requires an explicit model — toolkit defaults
  // to `auto` which can resolve to a slow reasoning model (LM Studio gotcha).
  if (provider.id === 'gemini-cli' && !model) {
    model = provider.lightModel || 'gemini-2.5-flash';
  }

  const { runId } = await createRun({
    providerId: provider.id,
    model,
    prompt,
    source: options.source || 'staged-llm',
  });
  console.log(`📝 stage: ${provider.id} / ${model || '(default)'} / ${stageName} → ${runId.slice(0, 8)}`);

  const text = await awaitRunnerCall({ provider, model, prompt, runId, source: options.source });
  const content = options.returnsJson ? extractJson(text) : text;
  return { content, model: model || null, providerId: provider.id, runId };
}
