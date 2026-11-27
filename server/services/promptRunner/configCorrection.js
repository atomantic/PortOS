/** Retries a provider with a valid configured model after a model selection failure. */

import { ERROR_CATEGORIES } from '../../lib/aiToolkit/errorDetection.js';
import { isGenerationModel } from '../../lib/localModelHeuristics.js';
import { executeProviderRunOnce, providerHonorsModelOverride } from './providerExecution.js';

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
export async function attemptConfigCorrection({ args, source, failed, failedModel, category, investigation, primaryKey, stopOnTerminalRequest }) {
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
