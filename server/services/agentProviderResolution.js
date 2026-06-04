/**
 * Agent Provider Resolution
 *
 * Resolves which AI provider + model an agent task should run on. Extracted
 * from `spawnAgentForTask` in agentLifecycle.js to keep that orchestrator
 * readable — this owns the availability check, fallback selection, the
 * user-specified provider override, and per-task model selection/validation.
 *
 * The function never touches spawn-local state (the dedup guard, execution
 * lane, tool-execution tracking). On a resolvable failure it returns
 * `{ ok: false, error, ... }` and lets the caller fire `cleanupOnError` +
 * the `agent:error` event; an unexpected throw bubbles to the caller's
 * widened try/catch the same way the inline code did.
 */

import { emitLog } from './cosEvents.js';
import { getActiveProvider, getAllProviders, getProviderById } from './providers.js';
import { isProviderAvailable, getFallbackProvider, getProviderStatus } from './providerStatus.js';
import { selectModelForTask } from './agentModelSelection.js';

/**
 * Resolve the provider + model for a task.
 *
 * @param {object} task
 * @returns {Promise<
 *   | { ok: true, provider: object, selectedModel: string, modelSelection: object }
 *   | { ok: false, error: string, providerId?: string, providerStatus?: object }
 * >}
 */
export async function resolveAgentProviderAndModel(task) {
  let provider = await getActiveProvider();

  if (!provider) {
    return { ok: false, error: 'No active AI provider configured' };
  }

  // Check provider availability (usage limits, rate limits, etc.)
  // Set when we fall back below to a provider with a configured "Fallback
  // Model" pin — it overrides the usual per-task model selection so the
  // user's chosen fallback provider+model pair is honored on agent runs.
  let fallbackModelPin = null;
  const providerAvailable = isProviderAvailable(provider.id);
  if (!providerAvailable) {
    const status = getProviderStatus(provider.id);
    emitLog('warn', `Provider ${provider.id} unavailable: ${status.message}`, {
      taskId: task.id,
      providerId: provider.id,
      reason: status.reason
    });

    // Try to get a fallback provider (check task-level, then provider-level, then system default).
    // getFallbackProvider indexes its providers arg by id, so pass a map — NOT the
    // { activeProvider, providers: [...] } shape getAllProviders() returns (mirrors promptRunner.js).
    const { providers: providerList = [] } = await getAllProviders();
    const providersMap = Object.fromEntries(providerList.map((p) => [p.id, p]));
    const taskFallbackId = task.metadata?.fallbackProvider;
    const taskFallbackModel = task.metadata?.fallbackModel;
    const fallbackResult = await getFallbackProvider(provider.id, providersMap, taskFallbackId, taskFallbackModel);

    if (fallbackResult) {
      emitLog('info', `Using fallback provider: ${fallbackResult.provider.id} (source: ${fallbackResult.source})`, {
        taskId: task.id,
        primaryProvider: provider.id,
        fallbackProvider: fallbackResult.provider.id,
        fallbackSource: fallbackResult.source
      });
      provider = fallbackResult.provider;
      fallbackModelPin = fallbackResult.model || null;
    } else {
      const errorMsg = `Provider ${provider.id} unavailable (${status.message}) and no fallback available`;
      return { ok: false, error: errorMsg, providerId: provider.id, providerStatus: status };
    }
  }

  // Check if user specified a different provider in task metadata
  const userProviderId = task.metadata?.provider;
  if (userProviderId && userProviderId !== provider.id) {
    const userProvider = await getProviderById(userProviderId);
    if (userProvider) {
      emitLog('info', `Using user-specified provider: ${userProviderId}`, { taskId: task.id });
      provider = userProvider;
      // The fallback pin belonged to the fallback provider we just replaced —
      // it must not carry onto the user's explicitly chosen provider, which
      // gets its own normal model selection.
      fallbackModelPin = null;
    } else {
      emitLog('warn', `User-specified provider "${userProviderId}" not found, using active provider`, { taskId: task.id });
    }
  }

  // Select optimal model for this task (async to allow learning-based suggestions)
  const modelSelection = await selectModelForTask(task, provider);
  let selectedModel = modelSelection.model;

  // A configured "Fallback Model" pin (from the provider- or task-level
  // fallback we took above) wins over the usual selection — the user
  // explicitly chose this model to run on the fallback. The compatibility
  // check below still guards it against the fallback provider's model list.
  if (fallbackModelPin) selectedModel = fallbackModelPin;

  // Validate model is compatible with provider
  if (selectedModel && provider.models && provider.models.length > 0) {
    const modelIsValid = provider.models.includes(selectedModel);
    if (!modelIsValid) {
      emitLog('warn', `Model "${selectedModel}" not valid for provider "${provider.id}", falling back to provider default`, {
        taskId: task.id,
        requestedModel: selectedModel,
        providerId: provider.id,
        validModels: provider.models
      });
      selectedModel = modelSelection.tier === 'heavy' ? provider.heavyModel :
                      modelSelection.tier === 'light' ? provider.lightModel :
                      modelSelection.tier === 'medium' ? provider.mediumModel :
                      provider.defaultModel;
    }
  }

  const logMessage = modelSelection.learningReason
    ? `Model selection: ${selectedModel} (${modelSelection.reason} - ${modelSelection.learningReason})`
    : `Model selection: ${selectedModel} (${modelSelection.reason})`;
  emitLog('info', logMessage, {
    taskId: task.id,
    model: selectedModel,
    tier: modelSelection.tier,
    reason: modelSelection.reason,
    ...(modelSelection.learningReason && { learningReason: modelSelection.learningReason })
  });

  return { ok: true, provider, selectedModel, modelSelection };
}
