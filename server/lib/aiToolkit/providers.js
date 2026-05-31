import { readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { atomicWrite } from './internal/atomicWrite.js';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ANTIGRAVITY_CLI_ID,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  ANTIGRAVITY_TUI_ID,
  ensureAntigravityPrintArgs,
  ensureAntigravityTuiArgs,
  LEGACY_GEMINI_CLI_ID,
  LEGACY_GEMINI_TUI_ID,
} from '../antigravity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE_PATH = join(__dirname, 'defaults/providers.sample.json');

const execFileAsync = promisify(execFile);

const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
const CODEX_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
const ANTIGRAVITY_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];

// Auto-migrate legacy codex provider configs that pin a real model id
// (e.g. "gpt-5.2") to the sentinel "codex-configured-default" so the Codex
// CLI uses whatever model is configured in ~/.codex/config.toml. Idempotent.
function migrateCodexProvider(data) {
  if (!data?.providers) return false;
  let changed = false;
  for (const provider of Object.values(data.providers)) {
    if (provider?.id !== 'codex' || provider?.type !== 'cli') continue;

    const modelsAlreadyMigrated = Array.isArray(provider.models)
      && provider.models.length === 1
      && provider.models[0] === CODEX_CONFIGURED_DEFAULT;
    if (!modelsAlreadyMigrated) {
      provider.models = [CODEX_CONFIGURED_DEFAULT];
      changed = true;
    }

    for (const key of CODEX_MODEL_KEYS) {
      if (provider[key] !== CODEX_CONFIGURED_DEFAULT) {
        provider[key] = CODEX_CONFIGURED_DEFAULT;
        changed = true;
      }
    }
  }
  return changed;
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
      const migrated = {
        ...legacy,
        id: mapping.targetId,
        name: mapping.name,
        type: mapping.type,
        command: 'agy',
        args: mapping.type === 'cli'
          ? ensureAntigravityPrintArgs(legacy.args || [])
          : ensureAntigravityTuiArgs(legacy.args || []),
        models: [ANTIGRAVITY_CONFIGURED_DEFAULT],
        timeout: legacy.timeout || mapping.timeout,
        envVars,
      };
      for (const key of ANTIGRAVITY_MODEL_KEYS) {
        migrated[key] = ANTIGRAVITY_CONFIGURED_DEFAULT;
      }
      data.providers[mapping.targetId] = migrated;
    }

    if (data.activeProvider === mapping.legacyId) {
      data.activeProvider = mapping.targetId;
    }

    // Rewrite fallbackProvider references on all other providers so
    // user-defined fallback chains aren't silently broken after the
    // legacy id is removed from the map.
    for (const p of Object.values(data.providers)) {
      if (p.fallbackProvider === mapping.legacyId) {
        p.fallbackProvider = mapping.targetId;
      }
    }

    delete data.providers[mapping.legacyId];
    changed = true;
  }

  return changed;
}

export function createProviderService(config = {}) {
  const {
    dataDir = './data',
    providersFile = 'providers.json',
    sampleFile = null
  } = config;

  const PROVIDERS_PATH = join(dataDir, providersFile);

  // JSON.parse with a corrupt-file rescue. A garbled providers.json (truncated
  // write, hand-edit typo, disk corruption) would otherwise crash server boot.
  // Rename the bad file to <path>.corrupt + start from empty so the CLI can
  // reseed from the sample on next save.
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

  async function loadProviders() {
    if (!existsSync(PROVIDERS_PATH)) {
      if (sampleFile && existsSync(sampleFile)) {
        const sample = await readFile(sampleFile, 'utf-8');
        // Parse BEFORE persisting — if the shipped sample is malformed we
        // don't want to seed user-side providers.json with garbage, and
        // parseOrRescue's rename target must be the user file, not the
        // shared sample (which would silently move it aside on every boot).
        let parsed;
        try {
          parsed = JSON.parse(sample);
        } catch (err) {
          console.error(`❌ sample providers file ${sampleFile} parse failed (${err.message}); starting from empty`);
          return { activeProvider: null, providers: {} };
        }
        await atomicWrite(PROVIDERS_PATH, sample);
        return parsed;
      }
      return { activeProvider: null, providers: {} };
    }

    const content = await readFile(PROVIDERS_PATH, 'utf-8');
    const data = await parseOrRescue(content, PROVIDERS_PATH);

    const migratedCodex = migrateCodexProvider(data);
    const migratedAntigravity = migrateAntigravityProviders(data);
    if (migratedCodex || migratedAntigravity) {
      await atomicWrite(PROVIDERS_PATH, data);
      if (migratedCodex) console.log('🔧 Migrated codex provider config to codex-configured-default sentinel');
      if (migratedAntigravity) console.log('🔧 Migrated Gemini provider config to Antigravity CLI (agy)');
    }

    return data;
  }

  async function saveProviders(data) {
    await atomicWrite(PROVIDERS_PATH, data);
  }

  return {
    async getAllProviders() {
      const data = await loadProviders();
      return {
        activeProvider: data.activeProvider,
        providers: Object.values(data.providers)
      };
    },

    async getProviderById(id) {
      const data = await loadProviders();
      return data.providers[id] || null;
    },

    async getActiveProvider() {
      const data = await loadProviders();
      if (!data.activeProvider) return null;
      return data.providers[data.activeProvider] || null;
    },

    async setActiveProvider(id) {
      const data = await loadProviders();
      if (!data.providers[id]) {
        return null;
      }
      data.activeProvider = id;
      await saveProviders(data);
      return data.providers[id];
    },

    async createProvider(providerData) {
      const data = await loadProviders();
      const id = providerData.id || providerData.name.toLowerCase().replace(/[^a-z0-9]/g, '-');

      if (data.providers[id]) {
        throw new Error('Provider with this ID already exists');
      }

      const provider = {
        id,
        name: providerData.name,
        type: providerData.type || 'cli',
        command: providerData.command || null,
        args: providerData.args || [],
        endpoint: providerData.endpoint || null,
        apiKey: providerData.apiKey || '',
        models: providerData.models || [],
        defaultModel: providerData.defaultModel || null,
        lightModel: providerData.lightModel || null,
        mediumModel: providerData.mediumModel || null,
        heavyModel: providerData.heavyModel || null,
        fallbackProvider: providerData.fallbackProvider || null,
        timeout: providerData.timeout || 300000,
        enabled: providerData.enabled !== false,
        envVars: providerData.envVars || {},
        secretEnvVars: providerData.secretEnvVars || [],
        headlessArgs: providerData.headlessArgs || [],
        tuiPromptDelayMs: providerData.tuiPromptDelayMs || 2500,
        tuiIdleTimeoutMs: providerData.tuiIdleTimeoutMs || 180000
      };

      data.providers[id] = provider;

      if (!data.activeProvider) {
        data.activeProvider = id;
      }

      await saveProviders(data);
      return provider;
    },

    async updateProvider(id, updates) {
      const data = await loadProviders();

      if (!data.providers[id]) {
        return null;
      }

      const provider = {
        ...data.providers[id],
        ...updates,
        id
      };

      data.providers[id] = provider;
      await saveProviders(data);
      return provider;
    },

    async deleteProvider(id) {
      const data = await loadProviders();

      if (!data.providers[id]) {
        return false;
      }

      delete data.providers[id];

      if (data.activeProvider === id) {
        const remaining = Object.keys(data.providers);
        data.activeProvider = remaining.length > 0 ? remaining[0] : null;
      }

      await saveProviders(data);
      return true;
    },

    async testProvider(id) {
      const data = await loadProviders();
      const provider = data.providers[id];

      if (!provider) {
        return { success: false, error: 'Provider not found' };
      }

      if (provider.type === 'cli' || provider.type === 'tui') {
        // Use execFile (no shell) so user-configured `provider.command` cannot
        // inject extra shell commands via metacharacters.
        const { stdout } = await execFileAsync('which', [provider.command])
          .catch(() => ({ stdout: '', stderr: 'not found' }));

        if (!stdout.trim()) {
          return { success: false, error: `Command '${provider.command}' not found in PATH` };
        }

        const tryVersion = async (flag) => {
          const out = await execFileAsync(provider.command, [flag]).catch(() => null);
          return out?.stdout?.trim() || null;
        };
        const versionOut = (await tryVersion('--version')) || (await tryVersion('-v')) || 'available';

        return {
          success: true,
          path: stdout.trim(),
          version: versionOut
        };
      }

      if (provider.type === 'api') {
        const modelsUrl = `${provider.endpoint}/models`;
        const response = await fetch(modelsUrl, {
          headers: provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {}
        }).catch(err => ({ ok: false, error: err.message }));

        if (!response.ok) {
          return { success: false, error: `API not reachable: ${response.error || response.status}` };
        }

        const models = await response.json().catch(() => ({ data: [] }));
        return {
          success: true,
          endpoint: provider.endpoint,
          models: models.data?.map(m => m.id) || []
        };
      }

      return { success: false, error: 'Unknown provider type' };
    },

    async refreshProviderModels(id) {
      const data = await loadProviders();
      const provider = data.providers[id];

      if (!provider) {
        return null;
      }

      let models = [];

      try {
        if (provider.type === 'api') {
          models = await this._refreshAPIProviderModels(provider);
        } else if (provider.type === 'cli') {
          models = await this._refreshCLIProviderModels(provider);
        }
      } catch (error) {
        console.error(`Failed to refresh models for ${provider.name}:`, error.message);
        return null;
      }

      if (!models || models.length === 0) {
        return null;
      }

      const updatedProvider = {
        ...data.providers[id],
        models
      };

      data.providers[id] = updatedProvider;
      await saveProviders(data);
      return updatedProvider;
    },

    async _refreshAPIProviderModels(provider) {
      if (provider.endpoint?.includes('ollama') || provider.endpoint?.includes(':11434')) {
        const ollamaUrl = `${provider.endpoint}/api/tags`;
        const response = await fetch(ollamaUrl).catch(() => null);

        if (response?.ok) {
          const data = await response.json().catch(() => null);
          if (data?.models) {
            return data.models.map(m => m.name || m.model);
          }
        }
      }

      const modelsUrl = `${provider.endpoint}/models`;
      const headers = {};

      if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const response = await fetch(modelsUrl, { headers }).catch(() => null);

      if (!response?.ok) {
        throw new Error(`HTTP ${response?.status || 'error'}`);
      }

      const responseData = await response.json().catch(() => ({ data: [] }));

      if (responseData.data && Array.isArray(responseData.data)) {
        return responseData.data.map(m => m.id);
      }

      if (responseData.models && Array.isArray(responseData.models)) {
        return responseData.models;
      }

      return [];
    },

    async _refreshCLIProviderModels(provider) {
      const providerName = provider.name.toLowerCase();

      if (providerName.includes('claude') || provider.command === 'claude') {
        return await this._fetchAnthropicModels(provider);
      }

      if (providerName.includes('antigravity') || provider.command === 'agy') {
        return [ANTIGRAVITY_CONFIGURED_DEFAULT];
      }

      if (providerName.includes('gemini') || provider.command === 'gemini') {
        return await this._fetchGeminiModels(provider);
      }

      throw new Error('Model refresh not supported for this CLI provider');
    },

    async _fetchAnthropicModels(_provider) {
      return [
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5-20250929',
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5-20251001',
        'claude-3-5-haiku-latest',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-sonnet-20240620',
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307'
      ];
    },

    async _fetchGeminiModels(provider) {
      const apiKey = provider.apiKey || process.env.GOOGLE_API_KEY;

      if (!apiKey) {
        throw new Error('Google API key required for model refresh');
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
      ).catch(() => null);

      if (!response?.ok) {
        throw new Error(`HTTP ${response?.status || 'error'}`);
      }

      const data = await response.json().catch(() => ({ models: [] }));

      return (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
    },

    async getSampleProviders() {
      const data = await loadProviders();
      const existingIds = new Set(Object.keys(data.providers));

      let sampleProviders = {};
      if (existsSync(DEFAULT_SAMPLE_PATH)) {
        const content = await readFile(DEFAULT_SAMPLE_PATH, 'utf-8');
        const parsed = JSON.parse(content);
        sampleProviders = { ...parsed.providers };
      }

      if (sampleFile && existsSync(sampleFile)) {
        const content = await readFile(sampleFile, 'utf-8');
        const parsed = JSON.parse(content);
        sampleProviders = { ...sampleProviders, ...parsed.providers };
      }

      return Object.values(sampleProviders).filter(p => !existingIds.has(p.id));
    }
  };
}
