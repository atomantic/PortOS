/** Resolve the requested provider and publish the initial run artifacts. */
import { resolveExecutionOptions, executionOptionsError } from './executionOptions.js';
import { atomicWrite } from './atomicWrite.js';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { join } from 'path';

const DEFAULT_OUTPUT_RESERVE_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;

function deriveRequestCapabilities({ prompt, screenshots, requestCapabilities }) {
  if (requestCapabilities && typeof requestCapabilities === 'object') return requestCapabilities;
  return {
    requiredContextTokens: Math.ceil(String(prompt ?? '').length / CHARS_PER_TOKEN) + DEFAULT_OUTPUT_RESERVE_TOKENS,
    hasImages: Array.isArray(screenshots) && screenshots.length > 0,
  };
}

export function createRunFactory({
  runsPath, ensureRunsDir, providerService, providerStatusService,
  redactStoredPrompt, withAssetPublication, hooks, registerExternalRun, unregisterExternalRun,
}) {
  return async function createRun(options) {
    const {
      providerId,
      model,
      prompt,
      workspacePath = process.cwd(),
      workspaceName = 'default',
      timeout,
      source = 'devtools',
      fallbackProviderId = null,
      effort = null,
      executionOptions,
      requestCapabilities = null,
      screenshots = [],
      allowFallback = true,
      // The exact record a routing-free caller will execute. The run is
      // recorded against it as given: no store lookup, no availability swap
      // or refusal, no enabled check. For a caller whose contract is "run on
      // this provider or report its own failure", where a benched or
      // since-edited store record must not change which request goes out.
      provider: pinnedProvider = null,
      // A host executor can make Stop effective before metadata becomes
      // visible, including cancellation from the onRunCreated hook.
      externalRun = null,
    } = options;

    if (!providerService) {
      throw new Error('Provider service not configured');
    }

    const requestedProvider = pinnedProvider ?? await providerService.getProviderById(providerId);
    const optionRequest = resolveExecutionOptions(
      { source: 'provider', options: requestedProvider?.executionSelectionDefaults ?? requestedProvider?.executionOptions },
      { source: 'selection', options: requestedProvider?.executionSelectionOptions },
      { source: 'run', options: executionOptions },
    );
    const hasExecutionOptions = Object.keys(optionRequest.requested).length > 0;
    let effectiveProviderId = providerId;
    let usedFallback = false;
    // Model hint to run on the fallback provider when we proactively swap
    // below. Stays null on the non-fallback path so the requested `model`
    // wins as before.
    let fallbackModelHint = null;
    const effectiveRequestCapabilities = deriveRequestCapabilities({
      prompt,
      screenshots,
      requestCapabilities,
    });

    if (!pinnedProvider && providerStatusService && !providerStatusService.isAvailable(providerId)) {
      if (!allowFallback || hasExecutionOptions) {
        const status = providerStatusService.getStatus(providerId) || {};
        throw new Error(`Provider ${providerId} is unavailable (${status.reason || 'unknown'}) and fallback is disabled`);
      }
      const allProviders = await providerService.getAllProviders();
      const providersMap = {};
      for (const p of allProviders.providers) {
        providersMap[p.id] = p;
      }

      const fallback = providerStatusService.getFallbackProvider(
        providerId,
        providersMap,
        fallbackProviderId,
        null,
        effectiveRequestCapabilities
      );

      if (fallback) {
        effectiveProviderId = fallback.provider.id;
        usedFallback = true;
        fallbackModelHint = fallback.model || null;
        // Name the benched PRIMARY and why it was skipped, not just the
        // fallback — otherwise the log reads as an unexplained provider switch
        // ("why is my enabled provider not being used?"). `enabled` is the user
        // toggle; this swap is driven by the separate runtime availability state.
        const benched = providerStatusService.getStatus(providerId) || {};
        const recovery = providerStatusService.getTimeUntilRecovery(providerId);
        const primaryName = providersMap[providerId]?.name || providerId;
        console.log(`⚡ Primary ${primaryName} unavailable (${benched.reason || 'unknown'}${recovery ? `, recovers in ${recovery}` : ''}) — using fallback ${fallback.provider.name} (source: ${fallback.source})`);
      } else {
        const timeUntilRecovery = providerStatusService.getTimeUntilRecovery(providerId);
        throw new Error(
          `Provider ${providerId} is unavailable (${providerStatusService.getStatus(providerId).reason}) ` +
          `and no fallback is available. Recovery in: ${timeUntilRecovery || 'unknown'}`
        );
      }
    }

    const provider = effectiveProviderId === providerId ? requestedProvider : await providerService.getProviderById(effectiveProviderId);
    if (hasExecutionOptions && provider?.type === 'api') throw executionOptionsError('This API transport does not support these execution options');
    if (!provider) {
      throw new Error('Provider not found');
    }

    if (!pinnedProvider && !provider.enabled) {
      throw new Error('Provider is disabled');
    }

    await ensureRunsDir();

    const runId = randomUUID();
    const runDir = join(runsPath, runId);
    await mkdir(runDir);

    // On fallback, the requested `model` was resolved against the PRIMARY
    // provider and almost never exists on the fallback — use the configured
    // fallback model (or the fallback provider's own default) instead of
    // leaking the primary's model id onto the fallback's record + log line.
    const recordModel = usedFallback
      ? (fallbackModelHint || provider.defaultModel || null)
      : (model || provider.defaultModel || null);

    const storedPrompt = redactStoredPrompt(prompt);
    const metadata = {
      id: runId,
      type: 'ai',
      providerId: effectiveProviderId,
      providerName: provider.name,
      originalProviderId: usedFallback ? providerId : null,
      usedFallback,
      model: recordModel,
      effort,
      ...(hasExecutionOptions ? { executionOptions: optionRequest } : {}),
      workspacePath,
      workspaceName,
      source,
      prompt: storedPrompt.substring(0, 500),
      // Full prompt size (chars) — `prompt` above is truncated for display.
      // Hosts use this to estimate input-token usage on completion.
      promptLength: prompt.length,
      startTime: new Date().toISOString(),
      endTime: null,
      duration: null,
      exitCode: null,
      success: null,
      error: null,
      errorCategory: null,
      errorAnalysis: null,
      outputSize: 0
    };

    if (externalRun) registerExternalRun(runId, externalRun);
    try {
      await withAssetPublication(async () => {
        // The record must never name missing prompt/output bytes after a failure.
        await atomicWrite(join(runDir, 'prompt.txt'), storedPrompt);
        await atomicWrite(join(runDir, 'output.txt'), '');
        await atomicWrite(join(runDir, 'metadata.json'), metadata);
      });
      hooks.onRunCreated?.(metadata);
    } catch (error) {
      if (externalRun) unregisterExternalRun(runId);
      throw error;
    }
    console.log(`🤖 AI run [${source}]: ${provider.name}/${metadata.model}`);

    const effectiveTimeout = timeout ?? provider.timeout;

    // Surface `fallbackModel` so callers that re-resolve the model against
    // the fallback provider (e.g. stageRunner's args-baked-model logic) use
    // the configured fallback model instead of the primary's leaked one.
    return { runId, runDir, provider, metadata, timeout: effectiveTimeout, usedFallback, fallbackModel: fallbackModelHint };
  };
}
