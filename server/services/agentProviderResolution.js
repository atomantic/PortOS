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
import { publicReviewPostureForTask, resolvePublicReviewProvider } from './publicReviewProviderSelection.js';

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
  // A public-review stage is resolved against the POSTURE it declares, not the
  // usual pin → active → fallback chain: the ordinary chain is allowed to swap
  // onto any healthy provider, and swapping untrusted contributor content onto
  // a provider with no enforced posture is exactly what must not happen. The
  // eligible set comes from this install's own enabled providers, so a stage
  // configured on a machine that only has grok resolves to grok.
  const publicReviewPosture = publicReviewPostureForTask(task);
  if (publicReviewPosture) return resolvePublicReviewAgentProvider(task, publicReviewPosture);
  return resolveOrdinaryProviderAndModel(task);
}

/**
 * Provider + model for a public-review stage. A stage's own provider/model/
 * effort pins (`metadata.provider` / `metadata.model`, set by the pipeline
 * hand-off from the stage config) are honored when the pin is still eligible;
 * otherwise the install's own eligible set decides, and an install with none
 * fails PERMANENTLY so the task surfaces instead of re-dispatching forever.
 */
async function resolvePublicReviewAgentProvider(task, posture) {
  const resolved = await resolvePublicReviewProvider({
    posture,
    pinnedProviderId: task.metadata?.provider || null,
  });
  if (!resolved.ok) {
    return { ok: false, permanent: true, error: resolved.error, providerId: task.metadata?.provider || undefined };
  }
  const { provider } = resolved;
  if (task.metadata?.provider && !resolved.pinHonored) {
    emitLog('warn', `Public-review stage provider ${task.metadata.provider} is not eligible for the ${posture} posture — using ${provider.id}`, {
      taskId: task.id,
      providerId: provider.id,
    });
  }
  // A model pin only survives when it was chosen FOR this provider; otherwise
  // fall back to the provider's own default rather than handing one vendor's
  // model id to another (the failure mode documented in the ordinary path).
  const modelSelection = await selectModelForTask(task, provider);
  const pinnedModel = task.metadata?.model;
  const selectedModel = pinnedModel && task.metadata?.provider === provider.id
    ? pinnedModel
    : (modelSelection.model || provider.defaultModel || null);
  emitLog('info', `Public-review stage (${posture}) resolved to provider ${provider.id}${selectedModel ? ` model ${selectedModel}` : ''}`, {
    taskId: task.id,
    providerId: provider.id,
    model: selectedModel,
  });
  return { ok: true, provider, selectedModel, modelSelection };
}

async function resolveOrdinaryProviderAndModel(task) {
  // A task can pin a specific provider via metadata.provider (e.g. a CoS job's
  // per-job AI override). Resolve it BEFORE the active-provider availability
  // gate so a pinned-but-healthy provider isn't blocked when the *active*
  // provider is down or unset — independence from the active provider is the
  // whole point of pinning. The pinned provider then runs through the same
  // availability/fallback logic below as any other resolved provider.
  let provider = null;
  const userProviderId = task.metadata?.provider;
  let userProviderMissing = false;
  if (userProviderId) {
    const userProvider = await getProviderById(userProviderId);
    if (userProvider) {
      emitLog('info', `Using user-specified provider: ${userProviderId}`, { taskId: task.id });
      provider = userProvider;
    } else {
      userProviderMissing = true;
      emitLog('warn', `User-specified provider "${userProviderId}" not found, using active provider`, { taskId: task.id });
    }
  }
  if (!provider) provider = await getActiveProvider();

  if (!provider) {
    return { ok: false, error: 'No active AI provider configured' };
  }

  // Type of the DIRECTLY-resolved (pinned/active) provider, captured before any
  // fallback swap below. It gates the "permanent" flag on the api-type rejection:
  // an api provider is permanent (a config error that re-fails identically
  // forever) ONLY when the task was directly resolved onto an api provider — i.e.
  // the pinned/active provider is itself api. A fallback that lands on an api
  // provider is instead judged by THIS type: a CLI primary that's momentarily
  // unavailable (directType 'cli') may recover, so its api fallback is transient
  // and stays retryable; but an api primary whose fallback is also api (directType
  // 'api') can never gain a harness, so it stays permanent (no infinite retry).
  const directProviderType = provider.type;
  // Id of that same DIRECTLY-resolved provider — the one a `task.metadata.model`
  // pin was chosen FOR. Compared against `provider.id` after the fallback block
  // to detect a provider swap, which invalidates the pin (see below).
  const directProviderId = provider.id;
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
      // TRANSIENT, never permanent: a null fallback here can mean a configured
      // CLI/TUI fallback is merely momentarily down (getFallbackProvider skips
      // unavailable candidates), so blocking would strand a task that recovers
      // when that fallback returns. Permanence is decided by PROVIDER TYPE where we
      // can actually inspect it — the harness check below, reached once the
      // provider is available again — not inferred from a transient unavailable +
      // null-fallback combination. A down api provider with no viable path retries
      // cheaply (it fails fast here, spawning no agent) and self-heals to a
      // permanent block the moment it becomes reachable.
      return { ok: false, error: errorMsg, providerId: provider.id, providerStatus: status };
    }
  }

  // Harness boundary guard. `api`-type providers (Ollama / LM Studio / kimi over
  // HTTP) return plain text with NO filesystem tool harness — they can't
  // Read/Write/Edit/Bash, so a CoS agent task resolved onto one would spawn a
  // child process that writes nothing to disk. Fail clearly instead. This catches
  // an api provider arriving via a task pin OR via the fallback chain (the default
  // fallback priority includes lmstudio/ollama). The fix for users: add a CLI
  // coding provider — e.g. Claude Ollama, or OpenCode MTPLX when a separate
  // MTPLX runtime is already running locally.
  if (provider.type === 'api') {
    return {
      ok: false,
      // PERMANENT config error when the DIRECTLY-resolved (pinned/active) provider
      // was itself api — no CLI/TUI harness is reachable for this task no matter
      // how many times it re-dispatches, so the caller must retire it rather than
      // leave it silently re-failing forever. An api provider reached by falling
      // back from a CLI primary (directProviderType 'cli') is instead TRANSIENT:
      // the primary may recover, so the task stays retryable.
      permanent: directProviderType === 'api',
      error: `Provider "${provider.id}" is an HTTP API provider with no file-writing harness — CoS agent tasks need a CLI/TUI coding provider (claude, codex, "Claude Ollama", or "OpenCode MTPLX").`,
      providerId: provider.id
    };
  }

  // Select optimal model for this task (async to allow learning-based suggestions)
  const modelSelection = await selectModelForTask(task, provider);
  let selectedModel = modelSelection.model;

  // A configured "Fallback Model" pin (from the provider- or task-level
  // fallback we took above) wins over the usual selection — the user
  // explicitly chose this model to run on the fallback. The compatibility
  // check below still guards it against the fallback provider's model list.
  if (fallbackModelPin) selectedModel = fallbackModelPin;

  // Validate model is compatible with provider. An EXPLICIT user-specified
  // model (task.metadata.model → tier 'user-specified') is honored even when
  // it isn't in the provider's `models` list: that list is a convenience
  // enumeration, but the pass-through CLIs (claude/codex/opencode) accept any
  // valid id — and the claude providers even disagree on alias form
  // (`claude-code` lists `claude-haiku-4-5`, `claude-code-tui` lists the dated
  // `claude-haiku-4-5-20251001`). Silently downgrading an explicit pin to the
  // tier fallback — which for the default tier is the HEAVY model — both
  // violates the user's intent and maximizes cost, so we trust the pin and let
  // the provider reject a genuine typo at runtime. Auto-selected models (and a
  // fallback-model pin, which the comment above deliberately guards) still fall
  // back to the provider's tier default.
  //
  // …but ONLY on the provider the pin was chosen for. A `task.metadata.model`
  // pin is provider-scoped (the task form picks a provider and then a model from
  // THAT provider's catalog) — it is not a provider-agnostic preference. When
  // the pinned/active provider is down and the fallback block above swapped us
  // onto a different provider, the pin no longer describes anything the new
  // provider can run, and the pass-through exemption — which deliberately skips
  // the model list — is exactly what stops us from noticing. That combination
  // shipped `claude --model gemini-3.6-flash` after an `antigravity-tui` auth
  // outage: the CLI rejected it in ~1.5s ("There's an issue with the selected
  // model"), on every retry, until the task hit max retries and blocked. So a
  // provider swap drops the pin back to the new provider's own default unless
  // that provider actually lists it.
  // A missing pinned provider is also a provider swap, even when the active
  // provider happens to be the same object the resolver returned. The task's
  // model was selected for the missing provider and must not silently become a
  // pin for the active provider.
  const providerSwapped = userProviderMissing || provider.id !== directProviderId;
  const pinnedProviderId = userProviderId || directProviderId;
  const isUserPin = modelSelection.tier === 'user-specified' && !fallbackModelPin;
  const isUserPinnedModel = isUserPin && !providerSwapped;
  if (isUserPin && providerSwapped && !(provider.models || []).includes(selectedModel)) {
    // Handled here rather than left to the list check below, which can't fire at
    // all for a fallback provider that enumerates no `models`.
    emitLog('warn', `Dropping model "${selectedModel}" pinned for provider "${pinnedProviderId}" — running on fallback "${provider.id}" with its default model`, {
      taskId: task.id,
      requestedModel: selectedModel,
      pinnedProviderId,
      providerId: provider.id
    });
    selectedModel = provider.defaultModel || null;
  }
  if (selectedModel && provider.models && provider.models.length > 0) {
    const modelIsValid = provider.models.includes(selectedModel);
    if (!modelIsValid && isUserPinnedModel) {
      emitLog('info', `Honoring user-specified model "${selectedModel}" not in provider "${provider.id}" list (CLI pass-through)`, {
        taskId: task.id,
        requestedModel: selectedModel,
        providerId: provider.id
      });
    } else if (!modelIsValid) {
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
