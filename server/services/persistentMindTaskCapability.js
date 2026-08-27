/**
 * Supervised CoS-task capability for the persistent mind.
 *
 * The model receives a bounded catalog and may return typed task requests. This
 * service re-checks the user's grant after inference, validates every selected
 * app/provider/model/effort against current configuration, records the request
 * and outcome in the mind trajectory, and only then queues an internal task.
 */

import {
  PERSISTENT_MIND_TASK_LIMITS,
  normalizePersistentMindCapabilities,
  persistentMindTaskRequestSchema,
} from '../lib/persistentMindCapabilities.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';
import { canonicalStringify } from '../lib/objects.js';
import { antigravityBaseModels, effortLevelsForProvider, filterSelectableModels } from '../lib/providerModels.js';
import { PR_COMPLETIONS } from '../lib/prDisposition.js';
import { sha256Text } from '../lib/fileUtils.js';
import { getActiveApps } from './apps.js';
import { loadState } from './cosState.js';
import { addTask, getTaskById } from './cosTaskStore.js';
import { listProviders } from './providers.js';

const MAX_CATALOG_APPS = 50;
const MAX_CATALOG_PROVIDERS = 50;
const MAX_CATALOG_MODELS = 60;
const MAX_CATALOG_PROMPT_CHARS = 16_000;
const MAX_CATALOG_APP_PROMPT_CHARS = 4_000;

const isRunnableApp = (app) => typeof app?.repoPath === 'string' && app.repoPath.trim().length > 0;
const isRunnableAgentProvider = (provider) => provider?.enabled !== false
  && (provider?.type === 'cli' || provider?.type === 'tui');

const selectableModelIds = (provider) => {
  const stored = filterSelectableModels(antigravityBaseModels(provider?.models))
    .filter((model) => typeof model === 'string' && model.trim()
      && model.trim().length <= PERSISTENT_MIND_TASK_LIMITS.modelChars)
    .map((model) => model.trim());
  const configuredDefault = filterSelectableModels([provider?.defaultModel])[0];
  const withDefault = typeof configuredDefault === 'string' && configuredDefault.trim()
    && configuredDefault.trim().length <= PERSISTENT_MIND_TASK_LIMITS.modelChars
    ? [configuredDefault.trim(), ...stored]
    : stored;
  return [...new Set(withDefault)].slice(0, MAX_CATALOG_MODELS);
};

const providerCatalogEntry = (provider) => {
  const models = selectableModelIds(provider);
  return {
    id: provider.id,
    name: String(provider.name || provider.id).slice(0, 100),
    type: provider.type || null,
    models: models.map((model) => ({
      id: model,
      efforts: effortLevelsForProvider(provider, model) || [],
    })),
  };
};

export async function readPersistentMindTaskCatalog() {
  const [apps, providers] = await Promise.all([getActiveApps(), listProviders()]);
  return {
    apps: apps
      .filter((app) => isRunnableApp(app) && typeof app?.id === 'string' && app.id
        && app.id.length <= PERSISTENT_MIND_TASK_LIMITS.appIdChars)
      .slice(0, MAX_CATALOG_APPS)
      .map((app) => ({ id: app.id, name: String(app.name || app.id).slice(0, 100) })),
    providers: providers
      .filter((provider) => isRunnableAgentProvider(provider)
        && typeof provider?.id === 'string' && provider.id
        && provider.id.length <= PERSISTENT_MIND_TASK_LIMITS.providerIdChars)
      .slice(0, MAX_CATALOG_PROVIDERS)
      .map(providerCatalogEntry),
  };
}

const boundedPromptCatalog = (catalog) => {
  const bounded = { apps: [], providers: [] };
  for (const app of Array.isArray(catalog?.apps) ? catalog.apps : []) {
    bounded.apps.push(app);
    if (JSON.stringify({ apps: bounded.apps }).length > MAX_CATALOG_APP_PROMPT_CHARS) {
      bounded.apps.pop();
      break;
    }
  }
  for (const provider of Array.isArray(catalog?.providers) ? catalog.providers : []) {
    const kept = { ...provider, models: [] };
    bounded.providers.push(kept);
    if (JSON.stringify(bounded).length > MAX_CATALOG_PROMPT_CHARS) {
      bounded.providers.pop();
      break;
    }
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      kept.models.push(model);
      if (JSON.stringify(bounded).length > MAX_CATALOG_PROMPT_CHARS) {
        kept.models.pop();
        break;
      }
    }
  }
  return bounded;
};

export function buildPersistentMindTaskCapabilityPrompt({ enabled, catalog = { apps: [], providers: [] } } = {}) {
  if (!enabled) {
    return `# CoS agent task capability
Task creation access is OFF. Return an empty taskRequests array. You may recommend a task conversationally, but must not claim it was queued.`;
  }
  const promptCatalog = boundedPromptCatalog(catalog);
  return `# CoS agent task capability
Task creation access is ON. You may request up to ${PERSISTENT_MIND_TASK_LIMITS.maxPerTurn} internal CoS agent tasks when the current wake calls for concrete delegated work. Each task runs in an isolated worktree, opens a pull request, and is auto-approved into the normal CoS scheduler. The scheduler still enforces capacity, autonomy, and budget gates.

For each task, choose one configured app, provider, model (or "" for the provider's configured default), supported effort (or "" for the provider default), and exactly one PR completion policy:
- "review-then-merge": run the configured code-review loop, then merge only when its gate passes.
- "merge-on-green": skip code review and merge after CI is green.
- "leave-open": open the PR and wait for a human to review and merge it.

Configured choices (ids are authoritative; do not invent ids):
${JSON.stringify(promptCatalog)}

Use taskRequests only for specific, non-duplicate work. Put the complete agent instructions in prompt and a concise queue label in description. In your conversational message describe the request as pending; do not claim the task was created or completed because the capability outcome is recorded only after inference.`;
}

const wakeIdentity = (wake, turnId) => (
  wake?.kind === 'message' ? wake.message?.id : wake?.id
) || turnId;

const requestFingerprint = (request) => sha256Text(canonicalStringify(request));

const taskIdFor = (wakeId, fingerprint) => (
  `sys-mind-${sha256Text(`${PERSISTENT_MIND_ID}:${wakeId}:${fingerprint}`).slice(0, 24)}`
);

const boundedError = (error) => String(error?.message || error || 'Task creation failed').slice(0, 300);

const validateChoice = (request, apps, providers) => {
  const app = apps.find((candidate) => candidate.id === request.appId && isRunnableApp(candidate));
  if (!app) return { error: `App '${request.appId}' has no configured repository` };
  const provider = providers.find((candidate) => (
    candidate.id === request.providerId && isRunnableAgentProvider(candidate)
  ));
  if (!provider) return { error: `Provider '${request.providerId}' is not an enabled CLI/TUI coding provider` };
  const models = selectableModelIds(provider);
  if (request.model && !models.includes(request.model)) {
    return { error: `Model '${request.model}' is not configured for provider '${request.providerId}'` };
  }
  const efforts = effortLevelsForProvider(provider, request.model || null) || [];
  if (request.effort && !efforts.includes(request.effort)) {
    return { error: `Effort '${request.effort}' is not supported by provider '${request.providerId}'` };
  }
  return { app, provider };
};

async function queueOneTask({ request, taskId, apps, providers }) {
  const existing = await getTaskById(taskId);
  if (existing) return { success: true, duplicate: true, task: existing };
  const choice = validateChoice(request, apps, providers);
  if (choice.error) return { success: false, error: choice.error };
  const task = await addTask({
    id: taskId,
    description: request.description,
    prompt: request.prompt,
    priority: request.priority,
    app: request.appId,
    provider: request.providerId,
    model: request.model || undefined,
    effort: request.effort || undefined,
    useWorktree: true,
    openPR: true,
    prCompletion: request.prCompletion,
    simplify: true,
    worktreeChangesExpected: true,
    approvalRequired: false,
  }, 'internal');
  return { success: true, duplicate: task.duplicate === true, task };
}

const eventDataFor = (request, outcome, displayText) => ({
  displayText,
  appId: request.appId,
  providerId: request.providerId,
  model: request.model || null,
  effort: request.effort || null,
  prCompletion: request.prCompletion,
  ...(outcome ? {
    success: outcome.success === true,
    duplicate: outcome.duplicate === true,
    taskId: outcome.task?.id || null,
  } : {}),
  ...(outcome?.error ? { status: boundedError(outcome.error) } : {}),
});

/**
 * Execute model-returned requests sequentially so capability events preserve
 * request order. A stable wake+index id makes a replay after a crash at-most-once.
 */
export async function executePersistentMindTaskRequests({
  taskRequests,
  turnId,
  wake,
  signal,
  recordCapabilityEvent,
} = {}) {
  const requests = Array.isArray(taskRequests)
    ? taskRequests.slice(0, PERSISTENT_MIND_TASK_LIMITS.maxPerTurn)
    : [];
  if (requests.length === 0) return [];

  const [root, apps, providers] = await Promise.all([loadState(), getActiveApps(), listProviders()]);
  const enabled = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities).createTasks;
  const record = typeof recordCapabilityEvent === 'function'
    ? recordCapabilityEvent
    : () => Promise.resolve();
  const sourceWakeId = wakeIdentity(wake, turnId);
  const results = [];

  for (const [index, candidate] of requests.entries()) {
    const parsed = persistentMindTaskRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      const capabilityId = `cos-task-${sha256Text(`${sourceWakeId}:invalid:${index}`).slice(0, 24)}`;
      const outcome = { success: false, error: 'Task request failed validation' };
      await record({
        kind: 'result',
        id: capabilityId,
        data: { displayText: `CoS task request ${index + 1} was rejected`, success: false, status: outcome.error },
      });
      results.push(outcome);
      continue;
    }

    const request = parsed.data;
    const fingerprint = requestFingerprint(request);
    const capabilityId = `cos-task-${sha256Text(`${sourceWakeId}:${fingerprint}`).slice(0, 24)}`;
    await record({
      kind: 'request',
      id: capabilityId,
      data: eventDataFor(request, null, `Requested CoS task ${index + 1} for ${request.appId}`),
    });
    const taskId = taskIdFor(sourceWakeId, fingerprint);
    const outcome = signal?.aborted
      ? { success: false, error: 'Persistent mind turn was interrupted before task creation' }
      : enabled
      ? await Promise.resolve()
        .then(() => queueOneTask({ request, taskId, apps, providers }))
        .then((value) => value, (error) => ({ success: false, error: boundedError(error) }))
      : { success: false, error: 'Persistent mind task creation access is disabled' };
    const displayText = outcome.success
      ? `${outcome.duplicate ? 'Reused' : 'Queued'} CoS task ${outcome.task.id}`
      : `CoS task request ${index + 1} was not queued`;
    await record({ kind: 'result', id: capabilityId, data: eventDataFor(request, outcome, displayText) });
    results.push(outcome);
  }
  return results;
}

export const PERSISTENT_MIND_TASK_PR_COMPLETIONS = PR_COMPLETIONS;
