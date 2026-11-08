/**
 * Status + apply for the free local Persistent Mind path (Ollama + 7B).
 *
 * Detect / install / pull stay on the existing local-LLM surfaces
 * (`installBackend`, `controlOllamaServer`, `installModel`). This module only
 * answers "where is this host on the Grok-box mind checklist?" and applies the
 * PortOS-side pins: enable the `ollama` provider, set its default model, and
 * optionally write the Persistent Mind profile. It never downloads weights and
 * never starts a mind turn.
 */

import { detectSystemCapabilities } from '../lib/systemCapabilities.js';
import {
  LOCAL_PERSISTENT_MIND_MODEL,
  LOCAL_PERSISTENT_MIND_PROVIDER_ID,
  localPersistentMindRecommendation,
  matchesLocalPersistentMindModel,
} from '../lib/localPersistentMindRecommendation.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { getNavPageForPath } from '../lib/navManifest.js';
import { getProviderById, updateProvider } from './providers.js';
import { listModels } from './localLlm.js';
import * as ollamaManager from './ollamaManager.js';
import { getConfig } from './cosState.js';
import { updateConfig } from './cos.js';

const STEP_IDS = Object.freeze([
  'recommendation',
  'ollama-installed',
  'ollama-running',
  'model-present',
  'provider-enabled',
  'mind-profile',
]);

const step = (id, status, detail = null, action = null) => ({
  id,
  status, // 'ready' | 'todo' | 'blocked' | 'skipped'
  detail,
  action,
});

async function probeOllamaInstalled(findCommand = findCommandOnPath) {
  const resolved = await findCommand('ollama');
  return Boolean(resolved);
}

async function probeOllamaRunning() {
  const status = await ollamaManager.getStatus().catch(() => null);
  return status?.available === true;
}

function listedModelIds(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
}

function resolveInstalledModelId(ids) {
  return ids.find((id) => matchesLocalPersistentMindModel(id)) || null;
}

/**
 * The id Apply may write. An explicit `modelId` is honored only when that
 * exact id is on the daemon's list, or when it names the recommended model
 * and an installed alias is already there — the installed id is what gets
 * pinned, never the unpulled spelling.
 */
function installedPinTarget(status, requestedId) {
  if (status.modelCatalog !== 'listed') return null;
  const installed = new Set(status.installedModelIds || []);
  if (!requestedId) return status.matchedModel || null;
  if (installed.has(requestedId)) return requestedId;
  if (matchesLocalPersistentMindModel(requestedId) && status.matchedModel && installed.has(status.matchedModel)) {
    return status.matchedModel;
  }
  return null;
}

function pinRefusal(status) {
  if (status.modelCatalog === 'listed') {
    return `Pull \`${LOCAL_PERSISTENT_MIND_MODEL}\` before pinning the Persistent Mind profile.`;
  }
  if (status.modelCatalog === 'list-failed') {
    return 'The Ollama model list could not be read. Confirm the recommended model is installed before pinning the Persistent Mind profile.';
  }
  return 'Start Ollama and confirm the recommended model is installed before pinning the Persistent Mind profile.';
}

/**
 * Describe the Grok-box / CPU-only Persistent Mind setup checklist.
 *
 * @param {{ capabilities?: object, findCommand?: Function }} [deps]
 */
export async function describeLocalPersistentMindSetup(deps = {}) {
  const capabilities = deps.capabilities || await detectSystemCapabilities();
  const recommendation = localPersistentMindRecommendation(capabilities);
  const steps = [];

  if (!recommendation) {
    steps.push(step(
      'recommendation',
      'skipped',
      `This host has a curated GPU coding-agent path (or otherwise does not use the free local Persistent Mind default). Use ${getNavPageForPath('/models/llms-runtimes')?.breadcrumb ?? 'Runtimes'} → Recommended coding-agent setup when applicable.`,
    ));
    return {
      applicable: false,
      recommendation: null,
      steps,
      stepIds: STEP_IDS,
      ready: false,
    };
  }

  steps.push(step(
    'recommendation',
    'ready',
    `${recommendation.machine}: ${recommendation.topology}. Coding stays on ${recommendation.codingHarnesses}.`,
  ));

  const installed = await probeOllamaInstalled(deps.findCommand || findCommandOnPath);
  steps.push(step(
    'ollama-installed',
    installed ? 'ready' : 'todo',
    installed ? 'Ollama CLI is on PATH.' : 'Ollama is not installed (or not on PortOS PATH).',
    installed ? null : { kind: 'install-backend', backend: 'ollama', label: 'Install Ollama' },
  ));

  let running = false;
  if (installed) {
    running = await probeOllamaRunning();
    steps.push(step(
      'ollama-running',
      running ? 'ready' : 'todo',
      running ? 'Ollama daemon is answering on the local endpoint.' : 'Ollama is installed but not answering yet.',
      running ? null : { kind: 'start-ollama', label: 'Start Ollama' },
    ));
  } else {
    steps.push(step(
      'ollama-running',
      'blocked',
      'Install Ollama before starting the daemon.',
    ));
  }

  let matchedModel = null;
  let installedModelIds = [];
  // A failed or skipped list is not an empty catalog. Only `listed` may say
  // the recommended model is absent.
  let modelCatalog = 'daemon-down';
  if (running) {
    try {
      const models = await listModels('ollama');
      installedModelIds = listedModelIds(models);
      matchedModel = resolveInstalledModelId(installedModelIds);
      modelCatalog = 'listed';
    } catch {
      modelCatalog = 'list-failed';
    }
  }

  if (modelCatalog === 'listed') {
    steps.push(step(
      'model-present',
      matchedModel ? 'ready' : 'todo',
      matchedModel
        ? `Recommended model is present as \`${matchedModel}\`.`
        : `Pull \`${LOCAL_PERSISTENT_MIND_MODEL}\` (${recommendation.modelSize}) — tool-capable instruct build for the mind.`,
      matchedModel
        ? null
        : {
          kind: 'pull-model',
          backend: 'ollama',
          modelId: LOCAL_PERSISTENT_MIND_MODEL,
          label: `Pull ${recommendation.modelLabel}`,
        },
    ));
  } else if (modelCatalog === 'list-failed') {
    steps.push(step(
      'model-present',
      'blocked',
      'Ollama is answering, but the installed-model list could not be read.',
    ));
  } else {
    steps.push(step(
      'model-present',
      'blocked',
      'Start Ollama before pulling the recommended model.',
    ));
  }

  const provider = await getProviderById(LOCAL_PERSISTENT_MIND_PROVIDER_ID).catch(() => null);
  const providerEnabled = provider?.enabled === true;
  const providerModelOk = matchedModel
    ? matchesLocalPersistentMindModel(provider?.defaultModel)
    : false;

  let providerStatus = 'todo';
  let providerDetail = 'Enable the built-in Ollama API provider and pin the recommended model.';
  if (!provider) {
    providerStatus = 'blocked';
    providerDetail = 'The built-in `ollama` provider record is missing.';
  } else if (providerEnabled && matchedModel && providerModelOk) {
    providerStatus = 'ready';
    providerDetail = `Ollama provider is enabled with default \`${provider.defaultModel}\`.`;
  } else if (providerEnabled && matchedModel && !providerModelOk) {
    providerStatus = 'todo';
    providerDetail = `Ollama provider is enabled — set default model to \`${matchedModel}\`.`;
  } else if (providerEnabled && !matchedModel) {
    providerStatus = 'ready';
    providerDetail = 'Ollama provider is enabled. Pull the recommended model next (or apply after the pull).';
  }

  steps.push(step(
    'provider-enabled',
    providerStatus,
    providerDetail,
    provider
      ? { kind: 'enable-provider', providerId: LOCAL_PERSISTENT_MIND_PROVIDER_ID, label: 'Enable Ollama provider' }
      : null,
  ));

  const config = await getConfig().catch(() => null);
  const profile = normalizePersistentMindProfile(config?.persistentMindProfile);
  const mindPinned = profile.enabled === true
    && profile.providerId === LOCAL_PERSISTENT_MIND_PROVIDER_ID
    && matchesLocalPersistentMindModel(profile.model);
  // A pin to weights that are not pulled fails every mind wake with
  // model-not-found, so it is not ready until the model list confirms it.
  // Daemon-down and a failed list are a different fact from "not pulled".
  const mindReady = mindPinned && Boolean(matchedModel);
  let mindDetail = 'Optionally pin Persistent Mind to the Ollama provider and recommended model.';
  if (mindReady) {
    mindDetail = `Persistent Mind profile pins \`${profile.providerId}\` / \`${profile.model}\`.`;
  } else if (mindPinned && modelCatalog === 'listed') {
    mindDetail = `Persistent Mind profile pins \`${profile.providerId}\` / \`${profile.model}\`, but that model is not pulled — mind wakes fail until it is.`;
  } else if (mindPinned && modelCatalog === 'list-failed') {
    mindDetail = `Persistent Mind profile pins \`${profile.providerId}\` / \`${profile.model}\`, but the model list could not be read. Mind wakes stay unconfirmed until the list succeeds and the model is installed.`;
  } else if (mindPinned) {
    mindDetail = `Persistent Mind profile pins \`${profile.providerId}\` / \`${profile.model}\`, but Ollama is unavailable. Mind wakes fail until the daemon is up and the model is installed.`;
  }
  steps.push(step(
    'mind-profile',
    mindReady ? 'ready' : 'todo',
    mindDetail,
    { kind: 'set-mind-profile', label: 'Set Persistent Mind profile', optional: true },
  ));

  const requiredReady = steps
    .filter((s) => s.id !== 'mind-profile')
    .every((s) => s.status === 'ready' || s.status === 'skipped');

  return {
    applicable: true,
    recommendation,
    steps,
    stepIds: STEP_IDS,
    ready: requiredReady,
    matchedModel,
    installedModelIds,
    modelCatalog,
    providerEnabled,
    mindProfileReady: mindReady,
  };
}

/**
 * Enable the Ollama provider (and pin its default model when an installed
 * match is known). Optionally write the Persistent Mind profile. Does not
 * install Ollama or pull weights, so it never writes a model the daemon has
 * not listed — including an explicit `modelId` that only spells the
 * recommended tag. The setup card does not send `modelId`; the apply route
 * still accepts one, and that id has to be on the listed set.
 *
 * @param {{ setMindProfile?: boolean, modelId?: string }} [options]
 */
export async function applyLocalPersistentMindSetup(options = {}) {
  const setMindProfile = options.setMindProfile === true;
  const status = await describeLocalPersistentMindSetup();
  if (!status.applicable) {
    return {
      success: false,
      error: 'This host is not on the free local Persistent Mind default path.',
      status,
    };
  }

  const requestedId = (typeof options.modelId === 'string' && options.modelId.trim())
    ? options.modelId.trim()
    : null;
  const modelId = installedPinTarget(status, requestedId);

  if (setMindProfile && !modelId) {
    return {
      success: false,
      error: pinRefusal(status),
      status,
    };
  }

  const provider = await getProviderById(LOCAL_PERSISTENT_MIND_PROVIDER_ID).catch(() => null);
  if (!provider) {
    return { success: false, error: 'Built-in ollama provider is missing.', status };
  }

  const providerUpdate = { enabled: true };
  if (modelId) {
    const models = Array.isArray(provider.models) ? [...provider.models] : [];
    if (!models.includes(modelId)) models.unshift(modelId);
    providerUpdate.defaultModel = modelId;
    providerUpdate.models = models;
  }
  await updateProvider(LOCAL_PERSISTENT_MIND_PROVIDER_ID, providerUpdate);

  let profile = null;
  if (setMindProfile) {
    const config = await getConfig();
    const nextProfile = normalizePersistentMindProfile({
      ...(config?.persistentMindProfile || {}),
      enabled: true,
      providerId: LOCAL_PERSISTENT_MIND_PROVIDER_ID,
      model: modelId,
    });
    const saved = await updateConfig({ persistentMindProfile: nextProfile });
    profile = normalizePersistentMindProfile(saved?.persistentMindProfile);
  }

  const nextStatus = await describeLocalPersistentMindSetup();
  return {
    success: true,
    providerId: LOCAL_PERSISTENT_MIND_PROVIDER_ID,
    modelId,
    profile,
    status: nextStatus,
  };
}
