import { readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite } from './atomicWrite.js';
import { ensureAntigravityPrintArgs, ensureAntigravityTuiArgs, ANTIGRAVITY_CLI_ID, ANTIGRAVITY_CONFIGURED_DEFAULT, ANTIGRAVITY_TUI_ID, LEGACY_GEMINI_CLI_ID, LEGACY_GEMINI_TUI_ID } from './antigravity.js';
import { unifyProviderModes } from './providerModes.js';
import { modelContextWindowPatch } from './modelCatalog.js';
import { normalizeModelAccess } from './modelAccess.js';

const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
const CODEX_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
const CODEX_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
];
const CODEX_MODEL_DEFAULTS = {
  defaultModel: 'gpt-5.6-terra',
  lightModel: 'gpt-5.6-luna',
  mediumModel: 'gpt-5.6-terra',
  heavyModel: 'gpt-5.6-sol',
};
const PRIOR_CODEX_MODEL_CATALOGS = [
  ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.3-codex-spark'],
];
const ANTIGRAVITY_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
const ANTIGRAVITY_MODELS = [
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
  'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
  'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6',
  'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
];
const ANTIGRAVITY_MODEL_CATALOG = [ANTIGRAVITY_CONFIGURED_DEFAULT, ...ANTIGRAVITY_MODELS];
const PRIOR_ANTIGRAVITY_MODEL_CATALOGS = [
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
  const command = String(provider?.command || '').toLowerCase();
  if (id === 'codex' || id === 'codex-tui' || command === 'codex') return CODEX_CONTEXT_WINDOW;
  if (id === ANTIGRAVITY_CLI_ID || id === ANTIGRAVITY_TUI_ID || command === 'agy') return GEMINI_CONTEXT_WINDOW;
  return null;
}

function migrateCodexProvider(data) {
  if (!data?.providers) return false;
  let changed = false;
  for (const provider of Object.values(data.providers)) {
    const isCodexProcessProvider = (provider?.id === 'codex' || provider?.id === 'codex-tui')
      && (provider?.type === 'cli' || provider?.type === 'tui');
    if (!isCodexProcessProvider) continue;
    const isSentinelOnly = Array.isArray(provider.models)
      && provider.models.length === 1
      && provider.models[0] === CODEX_CONFIGURED_DEFAULT
      && CODEX_MODEL_KEYS.every(key => provider[key] === CODEX_CONFIGURED_DEFAULT);
    const isPriorSeededList = matchesAnyExactCatalog(provider.models, PRIOR_CODEX_MODEL_CATALOGS);
    if (!isSentinelOnly && !isPriorSeededList) continue;
    provider.models = [...CODEX_MODELS];
    if (isSentinelOnly) Object.assign(provider, CODEX_MODEL_DEFAULTS);
    changed = true;
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
  let providersLoadInFlight = null;
  let cacheGeneration = 0;

  function refreshProvidersCache(data) {
    if (data?.providers && Object.getPrototypeOf(data.providers) !== null) {
      data.providers = Object.assign(Object.create(null), data.providers);
    }
    providersCache = data;
    providersCacheAt = Date.now();
    cacheGeneration += 1;
    return data;
  }

  function invalidateProvidersCache() {
    providersCache = null;
    providersCacheAt = -Infinity;
    cacheGeneration += 1;
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
        await atomicWrite(providersPath, parsed);
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
      await atomicWrite(providersPath, data);
      if (migratedCodex) console.log('🔧 Migrated Codex providers to the selectable model catalog');
      if (migratedAntigravity) console.log('🔧 Migrated Gemini provider config to Antigravity CLI (agy)');
      if (migratedAntigravityModels) console.log('🔧 Migrated Antigravity providers to the selectable agy model catalog');
      if (migratedContextWindows) console.log('🔧 Migrated provider context windows to current canonical values');
    }
    return data;
  }

  async function loadProviders() {
    if (providersCache && (Date.now() - providersCacheAt) < providersCacheTtlMs) return providersCache;
    if (providersLoadInFlight) return providersLoadInFlight;
    const generation = cacheGeneration;
    providersLoadInFlight = readProvidersFromDisk()
      .then(data => {
        if (cacheGeneration === generation) return refreshProvidersCache(data);
        return providersCache ?? data;
      })
      .finally(() => { providersLoadInFlight = null; });
    return providersLoadInFlight;
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
    invalidateProvidersCache();
    await atomicWrite(providersPath, data);
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
      lightModel: providerData.lightModel || null,
      mediumModel: providerData.mediumModel || null,
      heavyModel: providerData.heavyModel || null,
      ultraModel: providerData.ultraModel || null,
      fallbackProvider: providerData.fallbackProvider || null,
      fallbackModel: providerData.fallbackModel || null,
      numCtx: providerData.numCtx || null,
      temperature: providerData.temperature,
      topP: providerData.topP,
      thinking: providerData.thinking,
      contextWindow: providerData.contextWindow || null,
      ...modelContextWindowPatch(providerData.modelContextWindows),
      timeout: providerData.timeout || 300000,
      enabled: providerData.enabled !== false,
      ...(typeof providerData.textTransport === 'string' && providerData.textTransport ? { textTransport: providerData.textTransport } : {}),
      ...(providerData.textTransportEnabled === true ? { textTransportEnabled: true } : {}),
      ...(providerData.textTransportReadRiskAcknowledged === true ? { textTransportReadRiskAcknowledged: true } : {}),
      ...(providerData.ollamaBacked === true ? { ollamaBacked: true } : {}),
      ...(providerData.lmstudioBacked === true ? { lmstudioBacked: true } : {}),
      ...(providerData.mtplxBacked === true ? { mtplxBacked: true } : {}),
      ...(providerData.llamaBacked === true ? { llamaBacked: true } : {}),
      ...(providerData.vllmBacked === true ? { vllmBacked: true } : {}),
      ...(providerData.sglangBacked === true ? { sglangBacked: true } : {}),
      ...(typeof providerData.gatewayBacked === 'string' && providerData.gatewayBacked ? { gatewayBacked: providerData.gatewayBacked } : {}),
      ...(providerData.orcarouterBacked === true ? { orcarouterBacked: true } : {}),
      ...(modelAccess ? { modelAccess } : {}),
      ...(providerData.allowCustomEndpoint === true ? { allowCustomEndpoint: true } : {}),
      ...(providerData.ignoreUserConfig === true ? { ignoreUserConfig: true } : {}),
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
    saveProviders,
    buildProviderRecord,
    storeProviderRecords,
    sampleFile,
    cachedModelIds,
    resolveCompositeProvider,
  };
}
