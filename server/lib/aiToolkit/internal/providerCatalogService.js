import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { assertSecretEndpoint, evaluateSecretEndpoint } from '../endpointGuard.js';
import { composeBootstrapSpawn } from './credentialBootstrap.js';
import { ANTIGRAVITY_CONFIGURED_DEFAULT, parseAntigravityModelList } from './antigravity.js';
import { CURSOR_COMMAND, parseCursorModelList } from './cursor.js';
import { ollamaBaseFromProvider } from './ollamaBacked.js';
import { providerModeGroups } from './providerModes.js';
import { ollamaRefreshGroupKey, resolveModelFetcher } from './modelFetchers.js';
import { modelCatalogUpdate, parseModelCatalog, toModelCatalog } from './modelCatalog.js';
import { CLAUDE_CATALOG_SUBPATH, catalogAge, claudeConfigDir, selectCatalogModels } from './claudeCodeCatalog.js';

function resolveProbeSpawn(provider, defaultBin, args) {
  const spawned = composeBootstrapSpawn(provider, provider?.command || defaultBin, args);
  return { ...spawned, label: `'${spawned.command} ${spawned.args.join(' ')}'` };
}

const execFileAsync = (file, args, options) =>
  promisify(execFile)(file, args, { windowsHide: true, ...options });

const TOOL_USE_RE = new RegExp([
  'qwen',
  'llama-?3\\.[1-9]', 'llama-?4',
  'mistral', 'mixtral', 'ministral', 'codestral', 'devstral', 'magistral',
  'command-?r', 'command-?a', 'north-mini-code',
  'firefunction', 'functionary', 'watt-tool', 'hermes', 'functiongemma',
  'glm-?4',
  'granite-?[34]',
  '(?:^|[-_/:])gemma-?4',
  'gpt-oss',
  'nemotron',
  'olmo-?3',
  'lfm2', 'ornith', 'muse-glimmer', 'nex-n2',
  'smollm2',
  'dflash',
  'deepseek-v3', 'deepseek-r1', 'deepseek-v4',
].join('|'), 'i');

function ollamaModelSupportsTools(id, capabilities) {
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    return capabilities.some((c) => String(c).toLowerCase() === 'tools');
  }
  return TOOL_USE_RE.test(String(id || ''));
}

export function createProviderCatalogService({
  loadProviders,
  saveProviders,
  withGatewayApiKey,
  cachedModelIds = null,
  sampleFile = null,
  defaultSamplePath,
}) {
  return {
    async testProvider(id) {
      const data = await loadProviders();
      const provider = withGatewayApiKey(data.providers[id], data.providers);
      if (!provider) return { success: false, error: 'Provider not found' };

      if (provider.type === 'cli' || provider.type === 'tui') {
        const isWin32 = process.platform === 'win32';
        const lookup = isWin32 ? 'where' : 'which';
        const probeCommand = composeBootstrapSpawn(provider, provider.command, []).command;
        const { stdout } = await execFileAsync(lookup, [probeCommand], { windowsHide: true })
          .catch(() => ({ stdout: '', stderr: 'not found' }));
        const commandPath = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';

        if (!commandPath) return { success: false, error: `Command '${probeCommand}' not found in PATH` };

        const searchEnv = { ...process.env, ...provider.envVars };
        const { prepareWindowsSafeSpawn, resolveWindowsExecutable } = await import('./windowsSafeSpawn.js');
        const invokePath = (isWin32 && resolveWindowsExecutable(provider.command, isWin32, searchEnv)) || commandPath;
        let everSpawned = false;
        const tryVersion = async (flag) => {
          try {
            const { command: execCommand, args: execArgs } = prepareWindowsSafeSpawn(invokePath, [flag]);
            const out = await execFileAsync(execCommand, execArgs);
            everSpawned = true;
            return out?.stdout?.trim() || null;
          } catch (err) {
            if (typeof err?.code === 'number') everSpawned = true;
            return null;
          }
        };
        const versionOut = (await tryVersion('--version')) || (await tryVersion('-v'));
        if (!everSpawned) {
          return {
            success: false,
            error: `Resolved '${probeCommand}' to ${invokePath} but it could not be executed (a Windows .cmd/.bat npm shim is not directly spawnable by the agent runner)`,
          };
        }
        return { success: true, path: invokePath, version: versionOut || 'available' };
      }

      if (provider.type === 'api') {
        if (provider.apiKey) {
          const guard = evaluateSecretEndpoint(provider.endpoint, {
            allowCustomEndpoint: provider.allowCustomEndpoint === true,
          });
          if (!guard.allowed) return { success: false, error: `Endpoint blocked: ${guard.reason}` };
        }
        const modelsUrl = `${provider.endpoint}/models`;
        const response = await fetch(modelsUrl, {
          headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
          signal: AbortSignal.timeout(10000),
        }).catch(err => ({ ok: false, error: err.message }));

        if (!response.ok) return { success: false, error: `API not reachable: ${response.error || response.status}` };
        const models = await response.json().catch(() => ({ data: [] }));
        return {
          success: true,
          endpoint: provider.endpoint,
          models: models.data?.map(m => m.id) || [],
        };
      }

      return { success: false, error: 'Unknown provider type' };
    },

    async fetchProviderModelCatalog(id) {
      const data = await loadProviders();
      const provider = withGatewayApiKey(data.providers[id], data.providers);
      if (!provider) return null;

      let fetched = null;
      try {
        const tuiFetcher = provider.type === 'tui' ? resolveModelFetcher(provider) : null;
        const probe = provider.type === 'api'
          ? () => this._refreshAPIProviderModels(provider)
          : provider.type === 'cli'
            ? () => this._refreshCLIProviderModels(provider)
            : tuiFetcher
              ? () => this[tuiFetcher.fetch](provider)
              : null;

        if (!probe) {
          const unsupported = new Error(`Model refresh not supported for ${provider.type} provider '${provider.id}'`);
          unsupported.status = 400;
          throw unsupported;
        }
        fetched = await this._withCachedCheckpoints(provider, probe);
      } catch (error) {
        console.error(`Failed to refresh models for ${provider.name}:`, error.message);
        error.status = error.status || 502;
        throw error;
      }

      if (resolveModelFetcher(provider)?.key === 'pi' && Array.isArray(fetched)
        && fetched.length === 0 && provider.models?.length) {
        const error = new Error('Pi has no authenticated models. Use pi /login before refreshing the stored catalog.');
        error.status = 502;
        throw error;
      }
      const catalog = toModelCatalog(fetched);
      if (catalog === null) {
        const unsupported = new Error(`Model refresh returned nothing for provider '${provider.id}'`);
        unsupported.status = 400;
        throw unsupported;
      }
      return catalog;
    },

    async fetchProviderModels(id) {
      const catalog = await this.fetchProviderModelCatalog(id);
      return catalog === null ? null : catalog.models;
    },

    async refreshProviderModels(id) {
      const catalog = await this.fetchProviderModelCatalog(id);
      if (catalog === null) return null;
      const previous = (await this.getProviderById(id))?.modelContextWindows;
      return this.updateProvider(id, modelCatalogUpdate(catalog, previous));
    },

    async refreshProviderModelsBatch(ids) {
      const requested = [...new Set(Array.isArray(ids) ? ids : [])];
      if (requested.length === 0) return [];

      const data = await loadProviders();
      const groups = [];
      const byKey = new Map();
      for (const id of requested) {
        const provider = data.providers[id];
        if (!provider) {
          groups.push({ ids: [id], leadId: id, status: 'missing' });
          continue;
        }
        const key = ollamaRefreshGroupKey(provider);
        const existing = key ? byKey.get(key) : null;
        if (existing) {
          existing.ids.push(id);
          continue;
        }
        const group = { ids: [id], leadId: id, status: 'missing' };
        if (key) byKey.set(key, group);
        groups.push(group);
      }

      for (const group of groups) {
        if (!data.providers[group.leadId]) continue;
        const probed = await this.fetchProviderModelCatalog(group.leadId).then(
          (catalog) => ({ catalog }),
          (error) => ({ error })
        );
        if (probed.error) {
          group.status = 'failed';
          group.error = probed.error;
          continue;
        }
        if (!probed.catalog) continue;
        group.status = 'updated';
        group.catalog = probed.catalog;
      }

      const updated = groups.filter(group => group.status === 'updated');
      if (updated.length === 0) return groups;

      const fresh = await loadProviders();
      let changed = false;
      for (const group of updated) {
        for (const id of group.ids) {
          const provider = fresh.providers[id];
          if (!provider) continue;
          const modes = providerModeGroups(Object.values(fresh.providers)).find(entries => entries.some(entry => entry.id === id));
          for (const mode of modes || [provider]) {
            fresh.providers[mode.id] = {
              ...mode,
              ...modelCatalogUpdate(group.catalog, mode.modelContextWindows),
            };
          }
          changed = true;
        }
      }
      if (changed) await saveProviders(fresh);
      return groups;
    },

    async _refreshAPIProviderModels(provider) {
      if (provider.endpoint?.includes('ollama') || provider.endpoint?.includes(':11434')) {
        const ollamaUrl = `${provider.endpoint}/api/tags`;
        const response = await fetch(ollamaUrl, { signal: AbortSignal.timeout(8000) }).catch(() => null);
        if (response?.ok) {
          const data = await response.json().catch(() => null);
          if (data?.models) return data.models.map(m => m.name || m.model);
        }
      }

      assertSecretEndpoint(provider.endpoint, {
        hasSecret: Boolean(provider.apiKey),
        allowCustomEndpoint: provider.allowCustomEndpoint === true,
      });
      const modelsUrl = `${provider.endpoint}/models`;
      const headers = {};
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);

      const responseData = await response.json().catch(() => null);
      if (!responseData || typeof responseData !== 'object') {
        throw new Error('Model list response was not valid JSON');
      }
      if (Array.isArray(responseData.data)) return parseModelCatalog(responseData.data, 'data');
      if (Array.isArray(responseData.models)) return parseModelCatalog(responseData.models, 'models');
      throw new Error('Model list response had no recognizable "data" or "models" array');
    },

    async _fetchMtplxModels(provider) {
      return this._refreshAPIProviderModels(provider);
    },

    async _withCachedCheckpoints(provider, probeServed) {
      const [cached, probed] = await Promise.all([
        typeof cachedModelIds === 'function'
          ? Promise.resolve().then(() => cachedModelIds(provider)).catch(() => null)
          : null,
        probeServed().then((result) => ({ ok: true, result }), (error) => ({ ok: false, error })),
      ]);
      if (!Array.isArray(cached) || cached.length === 0) {
        if (!probed.ok) throw probed.error;
        return probed.result;
      }
      const catalog = toModelCatalog(probed.result) || { models: [], contextWindows: {} };
      const stale = !probed.ok && Array.isArray(provider?.models) ? provider.models : [];
      return {
        models: [...new Set([...catalog.models, ...stale, ...cached])],
        contextWindows: catalog.contextWindows,
      };
    },

    async _fetchLmstudioModels(provider) {
      return this._refreshAPIProviderModels(provider);
    },

    async _fetchLlamaModels(provider) {
      return this._refreshAPIProviderModels(provider);
    },

    async _fetchVllmModels(provider) {
      return this._refreshAPIProviderModels(provider);
    },

    async _fetchSglangModels(provider) {
      return this._refreshAPIProviderModels(provider);
    },

    async _fetchGatewayModels(provider) {
      return this._refreshAPIProviderModels(provider);
    },

    async _refreshCLIProviderModels(provider) {
      const fetcher = resolveModelFetcher(provider);
      if (fetcher) return await this[fetcher.fetch](provider);
      const unsupported = new Error('Model refresh not supported for this CLI provider');
      unsupported.status = 400;
      throw unsupported;
    },

    async _fetchAntigravityModels(provider) {
      const listed = await this._execCliModelList(provider, 'agy', parseAntigravityModelList);
      return [ANTIGRAVITY_CONFIGURED_DEFAULT, ...new Set(listed)];
    },

    async _execCliModelList(provider, defaultBin, parse, listArgs = ['models'], isEmptyCatalog = () => false) {
      const spawned = resolveProbeSpawn(provider, defaultBin, listArgs);
      const probe = spawned.label;
      const { prepareWindowsSafeSpawn } = await import('./windowsSafeSpawn.js');
      const { command, args } = prepareWindowsSafeSpawn(spawned.command, spawned.args);
      const pending = execFileAsync(command, args, {
        timeout: 15000,
        env: { ...process.env, ...provider?.envVars },
      });
      pending.child?.stdin?.end();
      const { stdout } = await pending.catch((err) => {
        const output = `${err.stdout || ''}\n${err.stderr || ''}`;
        if (!err.killed && isEmptyCatalog(output)) return { stdout: output };
        throw new Error(`${probe} failed: ${err?.message || 'could not run the binary'}`);
      });
      const listed = parse(stdout);
      if (listed.length === 0 && !isEmptyCatalog(stdout)) {
        throw new Error(`${probe} returned no model ids`);
      }
      return listed;
    },

    async _fetchPiModels(provider) {
      const { PI_COMMAND, parsePiModelList } = await import('./pi.js');
      return this._execCliModelList(provider, PI_COMMAND, parsePiModelList, ['--list-models'],
        (stdout) => /No models available/i.test(stdout) && /\/login/.test(stdout));
    },

    async _fetchCursorModels(provider) {
      return await this._execCliModelList(provider, CURSOR_COMMAND, parseCursorModelList);
    },

    async _fetchCodexModels(provider) {
      const [{ prepareWindowsSafeSpawn, resolveWindowsExecutable }, { probeCodexModelsViaAppServer }] = await Promise.all([
        import('./windowsSafeSpawn.js'),
        import('./codexModelListProbe.js'),
      ]);
      const spawned = resolveProbeSpawn(provider, 'codex', ['app-server']);
      // Only needed here for the Windows shim search — `probeCodexModelsViaAppServer`
      // rebuilds the same merge itself from `provider.envVars` before spawning.
      const childEnv = { ...process.env, ...provider?.envVars };
      const resolvedBin = resolveWindowsExecutable(spawned.command, process.platform === 'win32', childEnv) || spawned.command;
      const { command, args } = prepareWindowsSafeSpawn(resolvedBin, spawned.args);
      // `probeCodexModelsViaAppServer` is the shared leaf (`codexModelListProbe.js`)
      // — the Harnesses page refresh (`services/harnesses.js`) drives the same
      // probe from a resolved command/args with no toolkit `provider` shape (#8497).
      return probeCodexModelsViaAppServer(command, args, provider, { label: spawned.label });
    },

    async _fetchOllamaToolCapableModels(provider) {
      const base = ollamaBaseFromProvider(provider);
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!res?.ok) throw new Error(`Ollama unreachable at ${base} (HTTP ${res?.status || 'error'})`);
      const data = await res.json().catch(() => null);
      const names = (data?.models || []).map(m => m.name || m.model).filter(Boolean);
      const checked = await Promise.all(names.map(async (name) => {
        const showRes = await fetch(`${base}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name, name }),
          signal: AbortSignal.timeout(8000),
        }).catch(() => null);
        const showData = showRes?.ok ? await showRes.json().catch(() => null) : null;
        const capabilities = Array.isArray(showData?.capabilities) ? showData.capabilities : null;
        return ollamaModelSupportsTools(name, capabilities) ? name : null;
      }));
      return checked.filter(Boolean);
    },

    async _fetchAnthropicModels(provider) {
      const env = { ...process.env, ...provider?.envVars };
      const configDir = claudeConfigDir(env, homedir());
      if (!configDir) throw new Error('Cannot locate the Claude Code config directory (no HOME and no CLAUDE_CONFIG_DIR)');
      const catalogDir = join(configDir, ...CLAUDE_CATALOG_SUBPATH);
      const files = await readdir(catalogDir).catch(() => null);
      if (!files) throw new Error(`Claude Code has not cached a model catalog yet (${catalogDir} is missing) — run \`claude\` once, then refresh`);

      const entries = (await Promise.all(
        files.filter(name => name.endsWith('.json')).map(async (name) => {
          const raw = await readFile(join(catalogDir, name), 'utf8').catch(() => null);
          if (raw === null) return null;
          try { return JSON.parse(raw); } catch { return null; }
        }),
      )).filter(Boolean);

      const cliVersion = await this._claudeCliVersion(provider);
      const models = selectCatalogModels(entries, { cliVersion });
      if (models.length === 0) {
        const present = selectCatalogModels(entries, { applyVersionFloor: false });
        if (present.length > 0) {
          throw new Error(`Claude Code ${cliVersion || 'unknown'} cannot select any model in the cached catalog — upgrade \`claude\`, then refresh`);
        }
        throw new Error(`No usable Claude Code model catalog in ${catalogDir} — run \`claude\` once, then refresh`);
      }

      const age = catalogAge(entries);
      const stamp = age ? new Date(age) : null;
      const cached = stamp && !Number.isNaN(stamp.getTime()) ? stamp.toISOString() : 'unknown';
      console.log(`📋 Claude Code catalog: ${models.length} models (cached ${cached})`);
      return models;
    },

    async _claudeCliVersion(provider) {
      const spawned = resolveProbeSpawn(provider, 'claude', ['--version']);
      const { prepareWindowsSafeSpawn } = await import('./windowsSafeSpawn.js');
      const { command, args } = prepareWindowsSafeSpawn(spawned.command, spawned.args);
      const pending = execFileAsync(command, args, {
        timeout: 10000,
        env: { ...process.env, ...provider?.envVars },
      });
      pending.child?.stdin?.end();
      const { stdout } = await pending.catch(() => ({ stdout: '' }));
      return (/(\d+\.\d+\.\d+)/.exec(stdout || '') || [])[1] || '';
    },

    async _fetchGeminiModels(provider) {
      const apiKey = provider.apiKey || process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        const missingKey = new Error('Google API key required for model refresh');
        missingKey.status = 400;
        throw missingKey;
      }
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { signal: AbortSignal.timeout(8000) }
      ).catch(() => null);
      if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
      const data = await response.json().catch(() => ({ models: [] }));
      return (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
    },

    async getSampleProviders() {
      const data = await loadProviders();
      const existingIds = new Set(Object.keys(data.providers));
      let sampleProviders = {};
      if (existsSync(defaultSamplePath)) {
        const content = await readFile(defaultSamplePath, 'utf-8');
        const parsed = JSON.parse(content);
        sampleProviders = { ...parsed.providers };
      }
      if (sampleFile && existsSync(sampleFile)) {
        const content = await readFile(sampleFile, 'utf-8');
        const parsed = JSON.parse(content);
        sampleProviders = { ...sampleProviders, ...parsed.providers };
      }
      return Object.values(sampleProviders).filter(p => !existingIds.has(p.id));
    },
  };
}
