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
import { getProviderById, updateProvider } from './providers.js';
import { listModels } from './localLlm.js';
import * as ollamaManager from './ollamaManager.js';
import { getConfig, updateConfig } from './cos.js';

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

function resolveInstalledModelId(models) {
  const ids = (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
    .filter((id) => typeof id === 'string' && id.trim());
  return ids.find((id) => matchesLocalPersistentMindModel(id)) || null;
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
      'This host has a curated GPU coding-agent path (or otherwise does not use the free local Persistent Mind default). Use Models → LLMs → Recommended coding-agent setup when applicable.',
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
  if (running) {
    const models = await listModels('ollama').catch(() => []);
    matchedModel = resolveInstalledModelId(models);
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
  const mindReady = profile.enabled === true
    && profile.providerId === LOCAL_PERSISTENT_MIND_PROVIDER_ID
    && matchesLocalPersistentMindModel(profile.model);
  steps.push(step(
    'mind-profile',
    mindReady ? 'ready' : 'todo',
    mindReady
      ? `Persistent Mind profile pins \`${profile.providerId}\` / \`${profile.model}\`.`
      : 'Optionally pin Persistent Mind to the Ollama provider and recommended model.',
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
    providerEnabled,
    mindProfileReady: mindReady,
  };
}

/**
 * Enable the Ollama provider (and pin its default model when known). Optionally
 * write the Persistent Mind profile. Does not install Ollama or pull weights.
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

  const modelId = (typeof options.modelId === 'string' && options.modelId.trim())
    || status.matchedModel
    || LOCAL_PERSISTENT_MIND_MODEL;

  const provider = await getProviderById(LOCAL_PERSISTENT_MIND_PROVIDER_ID).catch(() => null);
  if (!provider) {
    return { success: false, error: 'Built-in ollama provider is missing.', status };
  }

  const models = Array.isArray(provider.models) ? [...provider.models] : [];
  if (!models.includes(modelId)) models.unshift(modelId);

  await updateProvider(LOCAL_PERSISTENT_MIND_PROVIDER_ID, {
    enabled: true,
    defaultModel: modelId,
    models,
  });

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
