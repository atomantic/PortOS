/**
 * System Resources report + AI-assisted cleanup triage.
 *
 * The report is deliberately bounded to storage PortOS already understands:
 * classified data categories, PostgreSQL, model stores, package caches,
 * runtime dependencies, and aggregate browser-download usage. It never walks
 * arbitrary home-directory files and never sends filesystem paths or personal
 * record names to an AI provider.
 */

import os from 'os';
import { statfs } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { PATHS, dirSize } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';
import { getDataOverview } from './dataManager.js';
import { listHfModelStorage, listLoraStorage } from './mediaModelStorage.js';
import * as ollamaManager from './ollamaManager.js';
import * as lmStudioManager from './lmStudioManager.js';
import { listJobs } from './mediaJobQueue/index.js';
import * as cos from './cos.js';

export const REPORT_CACHE_TTL_MS = 30_000;

const LOW_RISK_DATA_CATEGORIES = new Set([
  'autofixer',
  'browser-downloads',
  'browser-profile',
  'cache',
  'conflict-journal',
  'image-clean-tmp',
  'insights',
  'jira-reports',
  'review',
  'runs',
  'screenshots',
  'tools',
  'update-detached',
  'video-thumbnails',
]);

const TRIAGE_RESPONSE_SCHEMA = z.object({
  summary: z.string().trim().min(1).max(1400),
  recommendations: z.array(z.object({
    candidateId: z.string().trim().min(1).max(320),
    priority: z.enum(['first', 'next', 'optional']),
    reason: z.string().trim().min(1).max(600),
    tradeoff: z.string().trim().min(1).max(600),
  }).strict()).max(8),
  cautions: z.array(z.string().trim().min(1).max(500)).max(8),
}).strict();

const finiteOrNull = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const sumBytes = (values) => values.reduce(
  (sum, value) => sum + (Number.isFinite(value) ? value : 0),
  0,
);

const sumKnownBytes = (values) => {
  const known = values.filter(Number.isFinite);
  return known.length > 0 ? sumBytes(known) : null;
};

function filesystemFrom(stats) {
  if (!stats) return null;
  const totalBytes = finiteOrNull(stats.blocks * stats.bsize);
  const freeBytes = finiteOrNull(stats.bavail * stats.bsize);
  if (!totalBytes || freeBytes == null) return null;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: Math.round((usedBytes / totalBytes) * 100),
  };
}

const backendState = (value) => (value == null ? 'unavailable' : 'ready');

function dataCleanupCandidates(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .filter((category) => category.deletable && category.size > 0)
    .map((category) => {
      const oneClick = category.purgeScope === 'category'
        && !category.busy
        && LOW_RISK_DATA_CATEGORIES.has(category.key);
      const manualReview = category.purgeScope === 'items';
      return {
        id: `data:${category.key}`,
        label: category.label,
        kind: 'data',
        estimatedBytes: category.size,
        risk: oneClick ? 'low' : manualReview ? 'high' : 'medium',
        reason: category.description,
        loaded: false,
        busy: Boolean(category.busy),
        manualOnly: !oneClick,
        managePath: '/data',
        action: oneClick ? { type: 'data-category', key: category.key } : null,
      };
    });
}

function modelCleanupCandidates(downloaded) {
  return downloaded.map((model) => ({
    id: model.id,
    label: model.name,
    kind: 'model',
    estimatedBytes: model.sizeBytes,
    risk: model.risk || 'medium',
    reason: model.loaded
      ? 'Model weights are installed and the model is currently resident in memory.'
      : model.residencyUnknown
        ? 'PortOS could not verify whether this model is resident. Refresh the backend before deleting it.'
        : model.inventoryUnknown
          ? 'The backend reported this model, but its on-disk folder could not be verified for safe cleanup.'
          : model.cleanupReason || 'Downloaded model weights can be installed again later, but re-downloading may be slow or bandwidth-intensive.',
    loaded: model.loaded,
    busy: model.loaded || model.residencyUnknown,
    manualOnly: model.loaded || model.residencyUnknown || model.inventoryUnknown,
    managePath: model.managePath,
    action: model.loaded || model.residencyUnknown || model.inventoryUnknown ? null : model.action,
  }));
}

export function buildCleanupCandidates({ categories, downloadedModels, npmCacheBytes }) {
  const candidates = [
    ...dataCleanupCandidates(categories),
    ...modelCleanupCandidates(downloadedModels),
  ];
  if (Number.isFinite(npmCacheBytes) && npmCacheBytes > 0) {
    candidates.push({
      id: 'cache:npm',
      label: 'npm download cache',
      kind: 'cache',
      estimatedBytes: npmCacheBytes,
      risk: 'low',
      reason: 'Package tarballs are re-downloadable. PortOS reports this cache but does not delete global package-manager state in-app.',
      loaded: false,
      busy: false,
      manualOnly: true,
      managePath: null,
      action: null,
    });
  }
  return candidates.sort((a, b) => (b.estimatedBytes || 0) - (a.estimatedBytes || 0));
}

const normalizeLmStudioRepo = (value) => String(value || '')
  .split('/').pop()
  .trim()
  .toLowerCase()
  .replace(/[-.]gguf$/i, '')
  .replace(/[-.]mlx[-.].*$/i, '');

function downloadedModelInventory({
  hf,
  loraStorage,
  ollamaStatus,
  ollamaStored,
  ollamaLoaded,
  ollamaResidencyError,
  lmStudioModels,
  lmStudioStored,
  lmStudioLoaded,
  lmStudioResidencyError,
}) {
  const ollamaLoadedIds = new Set((ollamaLoaded || []).flatMap((model) => [model.id, model.name]).filter(Boolean));
  const lmStudioLoadedIds = new Set((lmStudioLoaded || []).flatMap((model) => [
    model.id,
    normalizeLmStudioRepo(model.id),
  ]).filter(Boolean));

  const huggingFace = (hf?.models || []).map((model) => ({
    id: `hf:${model.id}`,
    backend: 'huggingface',
    name: model.label || model.repo,
    detail: model.repo,
    sizeBytes: model.size,
    sizeIsEstimate: false,
    loaded: false,
    managePath: '/media/models',
    action: { type: 'hf-model', dirName: model.id },
  }));
  const loras = (loraStorage?.loras || []).map((model) => ({
    id: `lora:${model.filename}`,
    backend: 'lora',
    name: model.name,
    detail: 'LoRA adapter',
    sizeBytes: model.size,
    sizeIsEstimate: false,
    risk: 'high',
    cleanupReason: 'A trained or imported LoRA adapter may be the only copy and can take hours to reproduce.',
    loaded: false,
    managePath: '/media/loras',
    action: { type: 'lora', filename: model.filename },
  }));
  const ollamaApi = new Map((ollamaStatus?.models || []).map((model) => [model.id, model]));
  const ollamaDiskModels = Array.isArray(ollamaStored) ? ollamaStored : [];
  const ollamaRows = [
    ...ollamaDiskModels,
    ...(ollamaStatus?.models || []).filter((model) => !ollamaDiskModels.some((stored) => stored.id === model.id))
      .map((model) => ({ ...model, inventoryUnknown: true })),
  ];
  const ollama = ollamaRows.map((stored) => {
    const model = ollamaApi.get(stored.id) || stored;
    return {
      id: `ollama:${stored.id}`,
      backend: 'ollama',
      name: model.name || stored.name || stored.id,
      detail: [model.params, model.quantization, model.family].filter(Boolean).join(' · '),
      sizeBytes: finiteOrNull(stored.size ?? model.size),
      // Ollama layers can be shared between tags, so the per-model size is an
      // upper-bound estimate rather than guaranteed reclaimed bytes.
      sizeIsEstimate: true,
      loaded: !ollamaResidencyError && ollamaLoadedIds.has(stored.id),
      residencyUnknown: Boolean(ollamaResidencyError),
      inventoryUnknown: !Array.isArray(ollamaStored) || Boolean(stored.inventoryUnknown),
      managePath: '/settings/local-llm',
      action: ollamaStatus?.available
        ? { type: 'local-model', backend: 'ollama', modelId: stored.id }
        : null,
    };
  });

  const lmStudioApiGroups = new Map();
  for (const model of (lmStudioModels || [])) {
    const key = normalizeLmStudioRepo(model.id);
    const group = lmStudioApiGroups.get(key) || { models: [], ids: new Set(), quantizations: new Set() };
    group.models.push(model);
    group.ids.add(model.id);
    if (model.quantization) group.quantizations.add(model.quantization);
    lmStudioApiGroups.set(key, group);
  }
  const lmStudioDiskModels = Array.isArray(lmStudioStored) ? lmStudioStored : [];
  const diskKeys = new Set(lmStudioDiskModels.map((model) => normalizeLmStudioRepo(model.id)));
  const lmStudioRows = [
    ...lmStudioDiskModels,
    ...[...lmStudioApiGroups.entries()]
      .filter(([key]) => !diskKeys.has(key))
      .map(([, group]) => ({
        id: [...group.ids][0],
        name: [...group.ids][0],
        size: group.models.map((model) => finiteOrNull(model.size)).find(Number.isFinite) ?? null,
        inventoryUnknown: true,
      })),
  ];
  const lmstudio = lmStudioRows.map((stored) => {
    const group = lmStudioApiGroups.get(normalizeLmStudioRepo(stored.id));
    const quantizations = group ? [...group.quantizations] : [];
    const loaded = !lmStudioResidencyError && (
      lmStudioLoadedIds.has(stored.id)
      || lmStudioLoadedIds.has(normalizeLmStudioRepo(stored.id))
      || group?.models.some((model) => model.state === 'loaded')
    );
    return {
      id: `lmstudio:${stored.id}`,
      backend: 'lmstudio',
      name: stored.name || stored.id,
      detail: [
        quantizations.length ? `${quantizations.length} quantization${quantizations.length === 1 ? '' : 's'}: ${quantizations.join(', ')}` : null,
        'removes the whole model folder',
      ].filter(Boolean).join(' · '),
      sizeBytes: finiteOrNull(stored.size),
      sizeIsEstimate: Boolean(stored.inventoryUnknown),
      loaded,
      residencyUnknown: Boolean(lmStudioResidencyError),
      inventoryUnknown: !Array.isArray(lmStudioStored) || Boolean(stored.inventoryUnknown),
      cleanupReason: 'Deleting this entry removes the whole LM Studio model folder, including every downloaded quantization in it.',
      managePath: '/settings/local-llm',
      action: { type: 'local-model', backend: 'lmstudio', modelId: stored.id },
    };
  });
  return [...huggingFace, ...loras, ...ollama, ...lmstudio]
    .sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
}

function loadedModelInventory({ ollamaLoaded, lmStudioLoaded }) {
  return [
    ...(ollamaLoaded || []).map((model) => ({
      id: `ollama:${model.id}`,
      backend: 'ollama',
      name: model.name || model.id,
      memoryBytes: finiteOrNull(model.sizeVram ?? model.size),
      expiresAt: model.expiresAt || null,
    })),
    ...(lmStudioLoaded || []).map((model) => ({
      id: `lmstudio:${model.id}`,
      backend: 'lmstudio',
      name: model.id,
      memoryBytes: null,
      expiresAt: null,
    })),
  ];
}

function mediaQueueSummary(jobs) {
  const live = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const byKind = Object.fromEntries(['image', 'video', 'training', 'audio'].map((kind) => {
    const matching = live.filter((job) => job.kind === kind);
    return [kind, {
      queued: matching.filter((job) => job.status === 'queued').length,
      running: matching.filter((job) => job.status === 'running').length,
    }];
  }));
  return {
    queued: live.filter((job) => job.status === 'queued').length,
    running: live.filter((job) => job.status === 'running').length,
    byKind,
  };
}

function agentQueueSummary(tasks, status) {
  if (!tasks) return null;
  return {
    pendingUser: tasks.user?.grouped?.pending?.length || 0,
    pendingSystem: tasks.cos?.grouped?.pending?.length || 0,
    awaitingApproval: tasks.cos?.awaitingApproval?.length || 0,
    inProgress: (tasks.user?.grouped?.in_progress?.length || 0)
      + (tasks.cos?.grouped?.in_progress?.length || 0),
    activeAgents: status ? status.activeAgents || 0 : null,
    pausedAgents: status ? status.pausedAgents || 0 : null,
    daemonRunning: status?.running ?? null,
    daemonPaused: status?.paused ?? null,
  };
}

export async function buildSystemResourceReport() {
  const npmCachePath = process.env.npm_config_cache || join(os.homedir(), '.npm');
  const dependencyPaths = [
    join(PATHS.root, 'node_modules'),
    join(PATHS.root, 'client', 'node_modules'),
    join(PATHS.root, 'server', 'node_modules'),
  ];

  const [
    diskStats,
    dataOverview,
    databaseRow,
    hf,
    loraStorage,
    ollamaStatus,
    ollamaStored,
    ollamaLoaded,
    ollamaBytes,
    lmStudioAvailable,
    lmStudioModels,
    lmStudioStored,
    lmStudioLoaded,
    lmStudioBytes,
    npmCacheBytes,
    dependencySizes,
    browserDownloadsBytes,
    cosTasks,
    cosStatus,
  ] = await Promise.all([
    statfs('/').catch(() => null),
    getDataOverview({ strict: true }).catch(() => null),
    query('SELECT pg_database_size(current_database()) AS bytes')
      .then((result) => result.rows[0] || null)
      .catch(() => null),
    listHfModelStorage({ strict: true }).catch(() => null),
    listLoraStorage({ strict: true }).catch(() => null),
    ollamaManager.getStatus(true).catch(() => null),
    ollamaManager.listStoredModels().catch(() => null),
    ollamaManager.getLoadedModels().catch(() => null),
    dirSize(ollamaManager.getModelsDir(), { strict: true }).catch(() => null),
    lmStudioManager.checkLMStudioAvailable(true).catch(() => null),
    lmStudioManager.getAvailableModels(true).catch(() => null),
    lmStudioManager.listStoredModels().catch(() => null),
    lmStudioManager.getLoadedModels(true).catch(() => null),
    lmStudioManager.getModelsDir().then((path) => dirSize(path, { strict: true })).catch(() => null),
    dirSize(npmCachePath, { strict: true }).catch(() => null),
    Promise.all(dependencyPaths.map((path) => dirSize(path, { strict: true }).catch(() => null))),
    dirSize(PATHS.browserDownloads, { strict: true }).catch(() => null),
    cos.getAllTasks().catch(() => null),
    cos.getStatus().catch(() => null),
  ]);

  const filesystem = filesystemFrom(diskStats);
  const databaseBytes = finiteOrNull(databaseRow?.bytes);
  const dependenciesBytes = sumKnownBytes(dependencySizes);
  const ollamaResidencyError = ollamaLoaded == null
    ? 'Ollama residency probe failed'
    : ollamaManager.getLastLoadedModelsError();
  const lmStudioResidencyError = lmStudioLoaded == null
    ? 'LM Studio residency probe failed'
    : lmStudioManager.getLastLoadedModelsError();
  const lmStudioListError = lmStudioModels == null
    ? 'LM Studio model inventory failed'
    : lmStudioManager.getLastListError();
  const downloadedModels = downloadedModelInventory({
    hf,
    loraStorage,
    ollamaStatus,
    ollamaStored,
    ollamaLoaded,
    ollamaResidencyError,
    lmStudioModels,
    lmStudioStored,
    lmStudioLoaded,
    lmStudioResidencyError,
  });
  const loadedModels = loadedModelInventory({ ollamaLoaded, lmStudioLoaded });
  const categories = dataOverview?.categories || null;
  const cleanupCandidates = buildCleanupCandidates({
    categories,
    downloadedModels,
    npmCacheBytes,
  });
  const mediaQueue = mediaQueueSummary(listJobs());
  const agentQueue = agentQueueSummary(cosTasks, cosStatus);
  const modelBytes = sumKnownBytes([hf?.totalBytes, loraStorage?.totalBytes, ollamaBytes, lmStudioBytes]);
  const storageAreas = [
    {
      id: 'portos-data', label: 'PortOS data', kind: 'data',
      sizeBytes: finiteOrNull(dataOverview?.totalSize), status: backendState(dataOverview),
      managePath: '/data', protected: false,
      note: 'Generated media, records, backups, worktrees, caches, and other classified app data.',
    },
    {
      id: 'postgres', label: 'PostgreSQL', kind: 'database',
      sizeBytes: databaseBytes, status: backendState(databaseRow),
      managePath: '/settings/database', protected: true,
      note: 'Primary relational records and vector indexes.',
    },
    {
      id: 'huggingface', label: 'Hugging Face models', kind: 'model',
      sizeBytes: finiteOrNull(hf?.totalBytes), status: backendState(hf),
      managePath: '/media/models', protected: false,
      note: 'Image, video, audio, and text-encoder weights in the shared Hub cache.',
    },
    {
      id: 'loras', label: 'LoRA adapters', kind: 'model',
      sizeBytes: finiteOrNull(loraStorage?.totalBytes), status: backendState(loraStorage),
      managePath: '/media/loras', protected: false,
      note: 'Fine-tuning adapters in PortOS data. This total also appears inside PortOS data.',
    },
    {
      id: 'ollama', label: 'Ollama models', kind: 'model',
      sizeBytes: finiteOrNull(ollamaBytes), status: backendState(ollamaBytes),
      managePath: '/settings/local-llm', protected: false,
      note: 'Local language-model manifests and shared blobs.',
    },
    {
      id: 'lmstudio', label: 'LM Studio models', kind: 'model',
      sizeBytes: finiteOrNull(lmStudioBytes), status: backendState(lmStudioBytes),
      managePath: '/settings/local-llm', protected: false,
      note: 'Downloaded GGUF or MLX model directories.',
    },
    {
      id: 'npm-cache', label: 'npm cache', kind: 'cache',
      sizeBytes: finiteOrNull(npmCacheBytes), status: backendState(npmCacheBytes),
      managePath: null, protected: false,
      note: 'Global package download cache; reported only, never deleted in-app.',
    },
    {
      id: 'dependencies', label: 'PortOS dependencies', kind: 'runtime',
      sizeBytes: dependenciesBytes,
      status: dependencySizes.every(Number.isFinite) ? 'ready' : 'unavailable',
      managePath: null, protected: true,
      note: 'Installed Node.js dependencies required by the running app.',
    },
    {
      id: 'browser-downloads', label: 'Browser downloads', kind: 'personal',
      sizeBytes: finiteOrNull(browserDownloadsBytes), status: backendState(browserDownloadsBytes),
      managePath: null, protected: true,
      note: 'Aggregate Downloads-folder usage. File names are never inspected or sent to AI.',
    },
  ];
  const storageErrors = storageAreas
    .filter((area) => area.status === 'unavailable')
    .map((area) => area.id);
  const sourceErrors = [...new Set([
    ...storageErrors,
    ...(!filesystem ? ['filesystem'] : []),
    ...(!ollamaStatus?.available ? ['ollama-backend'] : []),
    ...(ollamaStored == null ? ['ollama-inventory'] : []),
    ...(ollamaResidencyError ? ['ollama-residency'] : []),
    ...(lmStudioAvailable !== true ? ['lmstudio-backend'] : []),
    ...(lmStudioStored == null ? ['lmstudio-inventory'] : []),
    ...(lmStudioListError ? ['lmstudio-catalog'] : []),
    ...(lmStudioResidencyError ? ['lmstudio-residency'] : []),
    ...(cosTasks == null ? ['agent-queue'] : []),
    ...(cosStatus == null ? ['agent-status'] : []),
  ])];
  const managedReclaimableBytes = sumBytes(cleanupCandidates
    .filter((candidate) => candidate.risk === 'low' && candidate.action)
    .map((candidate) => candidate.estimatedBytes));
  const queuedAgents = agentQueue
    // Awaiting-approval tasks are already part of pendingSystem. Keep the
    // review count as a useful breakdown without counting those tasks twice in
    // the top-line queued total.
    ? agentQueue.pendingUser + agentQueue.pendingSystem
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    filesystem,
    summary: {
      knownFootprintBytes: sumKnownBytes(storageAreas.map((area) => area.sizeBytes)),
      footprintMayOverlap: true,
      portosDataBytes: finiteOrNull(dataOverview?.totalSize),
      databaseBytes,
      modelBytes,
      managedReclaimableBytes,
      loadedModels: loadedModels.length,
      queuedJobs: agentQueue ? mediaQueue.queued + queuedAgents : null,
      runningJobs: agentQueue ? mediaQueue.running + agentQueue.inProgress : null,
    },
    storageAreas,
    dataCategories: categories,
    models: {
      downloaded: downloadedModels,
      loaded: loadedModels,
      totals: {
        huggingface: finiteOrNull(hf?.totalBytes),
        loras: finiteOrNull(loraStorage?.totalBytes),
        ollama: finiteOrNull(ollamaBytes),
        lmstudio: finiteOrNull(lmStudioBytes),
        all: modelBytes,
      },
    },
    queues: { media: mediaQueue, agents: agentQueue },
    cleanupCandidates,
    sourceErrors,
  };
}

let reportCache = null;
let reportCacheAt = 0;
let reportInFlight = null;

export function resetSystemResourceReportCache() {
  reportCache = null;
  reportCacheAt = 0;
  reportInFlight = null;
}

export function getSystemResourceReport({ force = false } = {}) {
  if (!force && reportCache && Date.now() - reportCacheAt < REPORT_CACHE_TTL_MS) {
    return Promise.resolve(reportCache);
  }
  if (!reportInFlight) {
    reportInFlight = buildSystemResourceReport().then(
      (report) => {
        reportCache = report;
        reportCacheAt = Date.now();
        reportInFlight = null;
        return report;
      },
      (error) => {
        reportInFlight = null;
        throw error;
      },
    );
  }
  return reportInFlight;
}

export function buildSystemResourceTriagePrompt(report) {
  const candidates = report.cleanupCandidates.slice(0, 50).map((candidate, index) => ({
    // Deliberately opaque. A model id or LoRA filename can contain a personal
    // project name, so even candidate identifiers stay machine-local.
    id: `candidate-${index + 1}`,
    kind: candidate.kind,
    estimatedBytes: candidate.estimatedBytes,
    risk: candidate.risk,
    loaded: candidate.loaded,
    busy: candidate.busy,
    manualOnly: candidate.manualOnly,
    actionable: Boolean(candidate.action),
  }));
  const context = {
    filesystem: report.filesystem,
    summary: report.summary,
    queues: report.queues,
    unavailableSources: report.sourceErrors,
    candidates,
  };
  return `You are triaging disk pressure for a private, single-user PortOS installation.

Rank only the cleanup candidates supplied below. Never invent a path, file, command, candidate id, or deletion action. Treat byte counts as estimates: model layers and hardlinks can overlap, and deleting one tagged model may reclaim less than its displayed size. Do not recommend deleting a loaded or busy item until it is unloaded or idle. Respect risk: prefer low-risk reproducible caches, explain rebuild/download costs, and put protected or user-authored data behind manual review. If free space is healthy, say so and keep recommendations conservative.

Return ONLY JSON with this exact shape:
{
  "summary": "short assessment",
  "recommendations": [
    { "candidateId": "one supplied id", "priority": "first|next|optional", "reason": "why it helps", "tradeoff": "what is lost or rebuilt" }
  ],
  "cautions": ["important caveat"]
}

SYSTEM REPORT (no filesystem paths or personal filenames):
${JSON.stringify(context, null, 2)}`;
}

export async function triageSystemResources({
  providerId,
  model,
  effort,
  onRunCreated,
  onRunSettled,
} = {}) {
  const report = await getSystemResourceReport();
  const triageCandidates = report.cleanupCandidates.slice(0, 50);
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, {
    message: 'No AI provider is configured for system-resource triage',
    code: 'NO_PROVIDER',
  });

  const result = await runPromptThroughProvider({
    provider,
    model: selectedModel,
    effort,
    prompt: buildSystemResourceTriagePrompt(report),
    source: 'system-resource-triage',
    responseSchema: TRIAGE_RESPONSE_SCHEMA,
    onRunCreated,
    onRunSettled,
  });
  const parsed = TRIAGE_RESPONSE_SCHEMA.parse(JSON.parse(result.text));
  const candidatesById = new Map(triageCandidates.map((candidate, index) => [`candidate-${index + 1}`, candidate]));
  const seen = new Set();
  const recommendations = parsed.recommendations.flatMap((recommendation) => {
    const candidate = candidatesById.get(recommendation.candidateId);
    if (!candidate || seen.has(candidate.id)) return [];
    seen.add(candidate.id);
    return [{ ...recommendation, candidateId: candidate.id, candidate }];
  });
  if (parsed.recommendations.length > 0 && recommendations.length === 0) {
    throw new ServerError('AI triage did not reference any known cleanup candidate', {
      status: 502,
      code: 'LLM_OUTPUT_CONTRACT',
    });
  }

  return {
    report,
    triage: {
      summary: parsed.summary,
      recommendations,
      cautions: parsed.cautions,
      runId: result.runId,
      providerId: result.provider?.id || provider.id,
      model: result.model || selectedModel,
    },
  };
}
