import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite } from './atomicWrite.js';
import { ensureAntigravityPrintArgs, ensureAntigravityTuiArgs, isAntigravityCommand, ANTIGRAVITY_CLI_ID, ANTIGRAVITY_CONFIGURED_DEFAULT, ANTIGRAVITY_TUI_ID, LEGACY_GEMINI_CLI_ID, LEGACY_GEMINI_TUI_ID } from './antigravity.js';
import { unifyProviderModes } from './providerModes.js';
import { modelContextWindowPatch } from './modelCatalog.js';
import { normalizeModelAccess } from './modelAccess.js';
import { CODEX_CLI_ID, CODEX_CONFIGURED_DEFAULT, CODEX_TUI_ID, isCodexCommand } from './codex.js';
import { CODEX_SHIPPED_MODELS } from './codexShippedModels.js';
import { LOCAL_RUNTIME_MARKER_KEYS } from './localRuntimeMarkers.js';

const CODEX_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
export const CODEX_MODEL_DEFAULTS = {
  defaultModel: 'gpt-5.6-terra',
  lightModel: 'gpt-5.6-luna',
  mediumModel: 'gpt-5.6-terra',
  heavyModel: 'gpt-5.6-sol',
  ultraModel: 'gpt-6-astra',
};
const PRIOR_CODEX_MODEL_CATALOGS = [
  ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.3-codex-spark'],
];
const ANTIGRAVITY_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
export const ANTIGRAVITY_MODEL_DEFAULTS = {
  defaultModel: 'gemini-4-neon-medium',
  lightModel: 'gemini-3.8-flash-medium',
  mediumModel: 'gemini-4-neon-medium',
  heavyModel: 'gemini-4-neon-high',
  ultraModel: 'gemini-4-neon-xhigh',
};
const ANTIGRAVITY_MODELS = [
  'gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low',
  'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
  'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
  'gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator-g1-pro',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
  'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
];
export const ANTIGRAVITY_MODEL_CATALOG = [ANTIGRAVITY_CONFIGURED_DEFAULT, ...ANTIGRAVITY_MODELS];
const PRIOR_ANTIGRAVITY_MODEL_CATALOGS = [
  [
    ANTIGRAVITY_CONFIGURED_DEFAULT,
    'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
    'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
    'gpt-oss-120b-medium',
  ],
  [
    ANTIGRAVITY_CONFIGURED_DEFAULT,
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
    'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
    'gpt-oss-120b-medium',
  ],
  [
    ANTIGRAVITY_CONFIGURED_DEFAULT,
    'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6',
    'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
  ],
  [
    ANTIGRAVITY_CONFIGURED_DEFAULT,
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.5-flash-high', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6',
    'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
  ],
  [
    ANTIGRAVITY_CONFIGURED_DEFAULT,
    'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.5-flash-high', 'gemini-3.5-flash-medium', 'gemini-3.5-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6',
    'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
  ],
];
const CODEX_CONTEXT_WINDOW = 1_000_000;
const GEMINI_CONTEXT_WINDOW = 1_048_576;
const STALE_GENERIC_CONTEXT_WINDOW = 128_000;

function matchesAnyExactCatalog(models, catalogs) {
  return Array.isArray(models) && catalogs.some(
    catalog => catalog.length === models.length && catalog.every((model, index) => model === models[index]),
  );
}

function shouldUpgradeContextWindow(value) {
  return value == null || Number(value) === STALE_GENERIC_CONTEXT_WINDOW;
}

function canonicalProviderContextWindow(provider) {
  if (provider?.type !== 'cli' && provider?.type !== 'tui') return null;
  const id = String(provider?.id || '').toLowerCase();
  if (id === CODEX_CLI_ID || id === CODEX_TUI_ID || isCodexCommand(provider.command)) return CODEX_CONTEXT_WINDOW;
  if (id === ANTIGRAVITY_CLI_ID || id === ANTIGRAVITY_TUI_ID || isAntigravityCommand(provider.command)) return GEMINI_CONTEXT_WINDOW;
  return null;
}

function migrateCodexProvider(data) {
  if (!data?.providers) return false;
  let changed = false;
  for (const provider of Object.values(data.providers)) {
    const isCodexProcessProvider = (provider?.id === CODEX_CLI_ID || provider?.id === CODEX_TUI_ID)
      && (provider?.type === 'cli' || provider?.type === 'tui');
    if (!isCodexProcessProvider) continue;
    const isSentinelOnly = Array.isArray(provider.models)
      && provider.models.length === 1
      && provider.models[0] === CODEX_CONFIGURED_DEFAULT
      && CODEX_MODEL_KEYS.every(key => provider[key] === CODEX_CONFIGURED_DEFAULT);
    const isPriorSeededList = matchesAnyExactCatalog(provider.models, PRIOR_CODEX_MODEL_CATALOGS);
    if (isSentinelOnly || isPriorSeededList) {
      provider.models = [...CODEX_SHIPPED_MODELS];
      if (isSentinelOnly) {
        for (const key of CODEX_MODEL_KEYS) provider[key] = CODEX_MODEL_DEFAULTS[key];
      }
      changed = true;
    }
    // A narrowed custom catalog may intentionally leave out the shipped ultra model.
    const { ultraModel } = CODEX_MODEL_DEFAULTS;
    if ((provider.ultraModel == null || provider.ultraModel === '')
      && Array.isArray(provider.models) && provider.models.includes(ultraModel)) {
      provider.ultraModel = ultraModel;
      changed = true;
    }
  }
  return changed;
}

function stripLegacyModelPin(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model') {
      const next = args[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) i += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--model=')) continue;
    out.push(arg);
  }
  return out;
}

function migrateAntigravityProviders(data) {
  if (!data?.providers) return false;
  let changed = false;
  const mappings = [
    { legacyId: LEGACY_GEMINI_CLI_ID, targetId: ANTIGRAVITY_CLI_ID, name: 'Antigravity CLI', type: 'cli', timeout: 300000 },
    { legacyId: LEGACY_GEMINI_TUI_ID, targetId: ANTIGRAVITY_TUI_ID, name: 'Antigravity TUI', type: 'tui', timeout: 600000 },
  ];
  for (const mapping of mappings) {
    const legacy = data.providers[mapping.legacyId];
    if (!legacy) continue;
    if (!data.providers[mapping.targetId]) {
      const envVars = { ...(legacy.envVars || {}) };
      delete envVars.GEMINI_SANDBOX;
      const legacyArgs = stripLegacyModelPin(legacy.args || []);
      const migrated = {
        ...legacy,
        id: mapping.targetId,
        name: mapping.name,
        type: mapping.type,
        command: 'agy',
        args: mapping.type === 'cli'
          ? ensureAntigravityPrintArgs(legacyArgs)
          : ensureAntigravityTuiArgs(legacyArgs),
        models: [...ANTIGRAVITY_MODEL_CATALOG],
        timeout: legacy.timeout || mapping.timeout,
        envVars,
      };
      for (const key of ANTIGRAVITY_MODEL_KEYS) migrated[key] = ANTIGRAVITY_CONFIGURED_DEFAULT;
      data.providers[mapping.targetId] = migrated;
    }
    if (data.activeProvider === mapping.legacyId) data.activeProvider = mapping.targetId;
    for (const p of Object.values(data.providers)) {
      if (p.fallbackProvider === mapping.legacyId) p.fallbackProvider = mapping.targetId;
    }
    delete data.providers[mapping.legacyId];
    changed = true;
  }
  return changed;
}

function upgradeAntigravityTierPins(provider, { populateMissing }) {
  for (const [key, target] of Object.entries(ANTIGRAVITY_MODEL_DEFAULTS)) {
    const current = provider[key];
    const isSentinel = current === ANTIGRAVITY_CONFIGURED_DEFAULT;
    const isUnset = current == null || current === '';
    if (isSentinel || (isUnset && (populateMissing || key === 'ultraModel'))) {
      provider[key] = target;
    }
  }
}

function migrateAntigravityModelCatalog(data) {
  if (!data?.providers) return false;
  let changed = false;
  for (const provider of Object.values(data.providers)) {
    const isAntigravityProcessProvider = (provider?.id === ANTIGRAVITY_CLI_ID || provider?.id === ANTIGRAVITY_TUI_ID)
      && (provider?.type === 'cli' || provider?.type === 'tui');
    if (!isAntigravityProcessProvider) continue;
    const isSentinelOnly = Array.isArray(provider.models)
      && provider.models.length === 1
      && provider.models[0] === ANTIGRAVITY_CONFIGURED_DEFAULT;
    const isPriorSeededList = matchesAnyExactCatalog(provider.models, PRIOR_ANTIGRAVITY_MODEL_CATALOGS);
    if (!isSentinelOnly && !isPriorSeededList) continue;
    provider.models = [...ANTIGRAVITY_MODEL_CATALOG];
    upgradeAntigravityTierPins(provider, { populateMissing: isSentinelOnly });
    changed = true;
  }
  return changed;
}

function migrateProviderContextWindows(data) {
  if (!data?.providers) return false;
  let changed = false;
  for (const provider of Object.values(data.providers)) {
    const contextWindow = canonicalProviderContextWindow(provider);
    if (!contextWindow || !shouldUpgradeContextWindow(provider.contextWindow)) continue;
    provider.contextWindow = contextWindow;
    changed = true;
  }
  return changed;
}

export function createProviderServiceState(config = {}) {
  const {
    dataDir = './data',
    providersFile = 'providers.json',
    sampleFile = null,
    providersCacheTtlMs = 1000,
    onProvidersSaved = null,
    cachedModelIds = null,
    resolveCompositeProvider = null,
  } = config;
  const providersPath = join(dataDir, providersFile);
  let providersCache = null;
  let providersCacheAt = -Infinity;
  const writes = new AsyncLocalStorage();
  const rootQueue = { tail: Promise.resolve(), loadInFlight: null };
  let activeWrite = null;
  let restoring = false;

  function currentQueue() {
    const lease = writes.getStore();
    return lease?.active ? lease : rootQueue;
  }

  function withProvidersWrite(work, { serveCommittedReads = true } = {}) {
    const queue = currentQueue();
    const pending = queue.tail.then(() => {
      // Save hooks may call back into the service. Give their work a child
      // queue so it can finish inside this write, still one operation at a time.
      const lease = { active: true, tail: Promise.resolve(), loadInFlight: null };
      if (queue === rootQueue && serveCommittedReads) activeWrite = lease;
      return writes.run(lease, async () => {
        try {
          return await work();
        } finally {
          lease.active = false;
          await lease.tail;
          if (queue === rootQueue) activeWrite = null;
        }
      });
    });
    queue.tail = pending.catch(() => {});
    return pending;
  }

  function normalizeProviderMap(data) {
    if (data?.providers && Object.getPrototypeOf(data.providers) !== null) {
      data.providers = Object.assign(Object.create(null), data.providers);
    }
    return data;
  }

  function refreshProvidersCache(data) {
    providersCache = normalizeProviderMap(data);
    providersCacheAt = Date.now();
    return providersCache;
  }

  async function parseOrRescue(content, source) {
    try {
      return JSON.parse(content);
    } catch (err) {
      const corruptPath = `${source}.corrupt.${Date.now()}`;
      console.error(`❌ providers.json parse failed (${err.message}); renamed to ${corruptPath} and starting from empty`);
      await rename(source, corruptPath).catch(() => {});
      return { activeProvider: null, providers: {} };
    }
  }

  async function writeProvidersFile(data) {
    await atomicWrite(providersPath, data, { mode: 0o600 });
  }

  async function readProvidersFromDisk() {
    if (!existsSync(providersPath)) {
      if (sampleFile && existsSync(sampleFile)) {
        const sample = await readFile(sampleFile, 'utf-8');
        let parsed;
        try {
          parsed = JSON.parse(sample);
        } catch (err) {
          console.error(`❌ sample providers file ${sampleFile} parse failed (${err.message}); starting from empty`);
          return { activeProvider: null, providers: {} };
        }
        unifyProviderModes(parsed);
        await writeProvidersFile(parsed);
        return parsed;
      }
      return { activeProvider: null, providers: {} };
    }

    const content = await readFile(providersPath, 'utf-8');
    const data = await parseOrRescue(content, providersPath);
    const migratedCodex = migrateCodexProvider(data);
    const migratedAntigravity = migrateAntigravityProviders(data);
    const migratedAntigravityModels = migrateAntigravityModelCatalog(data);
    const migratedContextWindows = migrateProviderContextWindows(data);
    const migratedModes = unifyProviderModes(data);
    if (migratedModes || migratedCodex || migratedAntigravity || migratedAntigravityModels || migratedContextWindows) {
      await writeProvidersFile(data);
      if (migratedCodex) console.log('🔧 Migrated Codex provider catalogs and tier defaults');
      if (migratedAntigravity) console.log('🔧 Migrated Gemini provider config to Antigravity CLI (agy)');
      if (migratedAntigravityModels) console.log('🔧 Migrated Antigravity providers to the selectable agy model catalog');
      if (migratedContextWindows) console.log('🔧 Migrated provider context windows to current canonical values');
    }
    return data;
  }

  const hasFreshCache = () => providersCache && Date.now() - providersCacheAt < providersCacheTtlMs;

  function loadProviders() {
    if (hasFreshCache()) return Promise.resolve(providersCache);
    const queue = currentQueue();
    // A save hook may wait on host work that reads providers from another
    // async context. Keep these reads on the committed snapshot while a
    // transaction owns the queue, or share its initial load at startup.
    if (queue === rootQueue && activeWrite && !restoring) {
      if (providersCache) return Promise.resolve(providersCache);
      if (activeWrite.loadInFlight) return activeWrite.loadInFlight;
    }
    // A cold read may seed, migrate, or rename providers.json. Recheck the
    // cache once admitted so it cannot write over a newer transaction.
    queue.loadInFlight ??= withProvidersWrite(async () => (
      hasFreshCache() ? providersCache : refreshProvidersCache(await readProvidersFromDisk())
    ), { serveCommittedReads: false }).finally(() => { queue.loadInFlight = null; });
    return queue.loadInFlight;
  }

  async function loadProvidersForWrite() {
    // The committed cache stays readable during an atomic write and survives
    // a failed write unchanged. Preserve the map's reserved-key protection.
    return normalizeProviderMap(structuredClone(await loadProviders()));
  }

  function restoreProvidersFile(restore) {
    return withProvidersWrite(async () => {
      restoring = true;
      try {
        return await restore();
      } finally {
        providersCache = null;
        restoring = false;
      }
    });
  }

  async function notifyProvidersSaved(data) {
    if (typeof onProvidersSaved !== 'function') return;
    try {
      await onProvidersSaved(data);
    } catch (err) {
      console.error(`❌ providers save hook failed: ${err.message}`);
    }
  }

  async function saveProviders(data) {
    await writeProvidersFile(data);
    refreshProvidersCache(data);
    await notifyProvidersSaved(data);
  }

  function buildProviderRecord(existing, providerData) {
    const id = providerData.id || providerData.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    if (existing[id]) throw new Error('Provider with this ID already exists');
    const modelAccess = normalizeModelAccess(providerData.modelAccess);
    const provider = {
      id,
      name: providerData.name,
      type: providerData.type || 'cli',
      command: providerData.command || null,
      args: providerData.args || [],
      endpoint: providerData.endpoint || null,
      apiKey: providerData.apiKey || '',
      models: providerData.models || [],
      ...(providerData.hardwareRequirements ? { hardwareRequirements: providerData.hardwareRequirements } : {}),
      ...(providerData.modelHardwareRequirements ? { modelHardwareRequirements: providerData.modelHardwareRequirements } : {}),
      defaultModel: providerData.defaultModel || null,
      effort: providerData.effort || null,
      ...(providerData.executionOptions ? { executionOptions: providerData.executionOptions } : {}),
      ...(providerData.executionSelectionRoot === true ? { executionSelectionRoot: true } : {}),
      ...(providerData.executionSourceProviderId ? { executionSourceProviderId: providerData.executionSourceProviderId } : {}),
      lightModel: providerData.lightModel || null,
      mediumModel: providerData.mediumModel || null,
      heavyModel: providerData.heavyModel || null,
      ultraModel: providerData.ultraModel || null,
      fallbackProvider: providerData.fallbackProvider || null,
      fallbackModel: providerData.fallbackModel || null,
      numCtx: providerData.numCtx || null,
      ...(providerData.modelNumCtx && Object.keys(providerData.modelNumCtx).length ? { modelNumCtx: providerData.modelNumCtx } : {}),
      ...(providerData.providerRouting && Object.keys(providerData.providerRouting).length ? { providerRouting: providerData.providerRouting } : {}),
      temperature: providerData.temperature,
      topP: providerData.topP,
      thinking: providerData.thinking,
      contextWindow: providerData.contextWindow || null,
      ...(providerData.harnessContext ? { harnessContext: providerData.harnessContext } : {}),
      ...modelContextWindowPatch(providerData.modelContextWindows),
      timeout: providerData.timeout || 300000,
      enabled: providerData.enabled !== false,
      ...(typeof providerData.textTransport === 'string' && providerData.textTransport ? { textTransport: providerData.textTransport } : {}),
      ...(providerData.textTransportEnabled === true ? { textTransportEnabled: true } : {}),
      ...(providerData.textTransportReadRiskAcknowledged === true ? { textTransportReadRiskAcknowledged: true } : {}),
      ...Object.fromEntries(LOCAL_RUNTIME_MARKER_KEYS.filter((key) => providerData[key] === true).map((key) => [key, true])),
      ...(typeof providerData.gatewayBacked === 'string' && providerData.gatewayBacked ? { gatewayBacked: providerData.gatewayBacked } : {}),
      ...(providerData.orcarouterBacked === true ? { orcarouterBacked: true } : {}),
      ...(modelAccess ? { modelAccess } : {}),
      ...(providerData.allowCustomEndpoint === true ? { allowCustomEndpoint: true } : {}),
      ...(providerData.ignoreUserConfig === true ? { ignoreUserConfig: true } : {}),
      ...(providerData.codexAuthMode === 'chatgpt' || providerData.codexAuthMode === 'api' ? { codexAuthMode: providerData.codexAuthMode } : {}),
      ...(providerData.credentialBootstrap?.command ? { credentialBootstrap: providerData.credentialBootstrap } : {}),
      envVars: providerData.envVars || {},
      secretEnvVars: providerData.secretEnvVars || [],
      headlessArgs: providerData.headlessArgs || [],
      tuiPromptDelayMs: providerData.tuiPromptDelayMs || 2500,
      ...(providerData.lowPriorityOnUsageLimit === true ? { lowPriorityOnUsageLimit: true } : {}),
      ...(providerData.tuiIdleTimeoutMs != null ? { tuiIdleTimeoutMs: providerData.tuiIdleTimeoutMs } : {}),
      ...Object.fromEntries(['harnessId', 'method', 'serviceId', 'credentialBootstrapId']
        .filter(key => typeof providerData[key] === 'string' && providerData[key])
        .map(key => [key, providerData[key]])),
      ...(Array.isArray(providerData.catalogNarrowing) ? { catalogNarrowing: [...providerData.catalogNarrowing] } : {}),
    };
    return provider;
  }

  function storeProviderRecords(data, records) {
    for (const record of records) {
      data.providers[record.id] = record;
      if (!data.activeProvider) data.activeProvider = record.id;
    }
    unifyProviderModes(data);
  }

  return {
    loadProviders,
    loadProvidersForWrite,
    withProvidersWrite,
    saveProviders,
    restoreProvidersFile,
    buildProviderRecord,
    storeProviderRecords,
    sampleFile,
    cachedModelIds,
    resolveCompositeProvider,
  };
}
