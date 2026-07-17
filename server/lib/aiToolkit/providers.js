import { readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, delimiter, isAbsolute } from 'path';
import { atomicWrite } from './internal/atomicWrite.js';
import { assertSecretEndpoint, evaluateSecretEndpoint } from './internal/endpointGuard.js';
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
} from './internal/antigravity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE_PATH = join(__dirname, 'defaults/providers.sample.json');

// Extensions Windows can launch directly, checked in cmd.exe's own resolution
// preference. Deliberately excludes an extension-less match — npm ships a
// POSIX shell-script stub alongside a package's `.cmd`/`.bat`/`.ps1` Windows
// wrappers (for Git Bash/WSL); that stub is not natively launchable here, and
// is exactly what `where` can return as its first match (see #1865 — the
// issue's literal error text was produced by this function resolving that
// stub as `commandPath`, not by a missing shell).
const WIN_EXECUTABLE_EXTS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Resolve a bare command name to its full path WITH extension on Windows —
 * mirrors `resolveWindowsExecutable` in `server/lib/bufferedSpawn.js`
 * (duplicated here for this directory's self-containment; see ./CLAUDE.md).
 * Filesystem-only (no subprocess), so it can't reorder/misselect the way a
 * raw `where` first-line read can.
 */
function resolveWindowsExecutable(command, isWin32 = process.platform === 'win32', searchEnv = process.env) {
  if (!isWin32 || !command || isAbsolute(command) || /[\\/]/.test(command)) return null;
  const pathDirs = (searchEnv.PATH || searchEnv.Path || '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of WIN_EXECUTABLE_EXTS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const WIN_BATCH_EXT_RE = /\.(cmd|bat)$/i;

/**
 * Return the `{ command, args }` pair that's actually safe to hand to
 * `execFile()` under `shell:false` — mirrors `prepareWindowsSafeSpawn` in
 * `server/lib/bufferedSpawn.js` (duplicated here for self-containment).
 * `.bat`/`.cmd` files cannot be launched directly under `shell:false` even
 * with the explicit extension (Node's CVE-2024-27980 patch makes
 * spawn/execFile refuse them outright); the documented safe alternative is
 * to invoke `cmd.exe /c <path> <args>` directly.
 */
function prepareWindowsSafeSpawn(command, args, isWin32 = process.platform === 'win32') {
  if (isWin32 && WIN_BATCH_EXT_RE.test(command)) {
    return {
      command: 'cmd.exe',
      args: ['/c', escapeCmdMetacharsIfUnquoted(command), ...args.map(escapeCmdMetacharsIfUnquoted)],
    };
  }
  return { command, args };
}

// cmd.exe metacharacters that act as command separators / redirection /
// grouping on its raw command line.
const CMD_METACHAR_RE = /[&|<>^()]/g;
// Node's argv→command-line quoting wraps an argument in literal double
// quotes only when it contains whitespace or a `"`; characters inside that
// quoted span are not re-interpreted by cmd.exe.
const NEEDS_NODE_QUOTING_RE = /[\s"]/;

/**
 * Caret-escape cmd.exe metacharacters, but ONLY when Node's own quoting
 * would otherwise leave the argument unquoted on cmd.exe's raw command line.
 * Mirrors server/lib/bufferedSpawn.js for self-containment.
 */
function escapeCmdMetacharsIfUnquoted(value) {
  const str = String(value);
  if (NEEDS_NODE_QUOTING_RE.test(str)) return str;
  return str.replace(CMD_METACHAR_RE, '^$&');
}

const execFileAsync = promisify(execFile);

// Tool-use (function-calling) capable model families. Inlined here because the
// aiToolkit is self-contained (no imports out to server/lib). MIRROR of
// TOOL_USE_RE in server/lib/localModelHeuristics.js and isToolUseModel in
// client/src/utils/providers.js — keep all three in lockstep.
const TOOL_USE_RE = new RegExp([
  'qwen',
  'llama-?3\\.[1-9]', 'llama-?4',
  'mistral', 'mixtral', 'ministral', 'codestral', 'devstral', 'magistral',
  'command-?r', 'command-?a',
  'firefunction', 'functionary', 'watt-tool', 'hermes',
  'glm-?4',
  'granite-?3',
  'gpt-oss',
  'nemotron',
  'smollm2',
  'deepseek-v3', 'deepseek-r1',
].join('|'), 'i');

/**
 * A `claude` CLI/TUI provider is "Ollama-backed" — the Claude Ollama
 * pattern — when it carries the `ollamaBacked` marker or its ANTHROPIC_BASE_URL
 * points at an Ollama daemon. Such a provider runs the full Claude Code harness
 * but generates tokens from a local model, so its model list must come from
 * Ollama (filtered to tool-use-capable models) rather than the static Anthropic list.
 */
function isOllamaBackedProvider(provider) {
  if (provider?.ollamaBacked === true) return true;
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || '');
  return /:11434\b/.test(base) || /ollama/i.test(base);
}

/** Normalize an Ollama base URL (strip trailing slash + an OpenAI-compat `/v1`). */
function ollamaBaseFromProvider(provider) {
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || 'http://localhost:11434');
  return base.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Whether an Ollama model supports tool use. Prefers the authoritative `tools`
 * capability from /api/show (a non-empty capabilities array without `tools` is
 * an explicit negative); falls back to the id heuristic when capabilities are
 * unavailable (daemon hiccup / older Ollama).
 */
function ollamaModelSupportsTools(id, capabilities) {
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    return capabilities.some((c) => String(c).toLowerCase() === 'tools');
  }
  return TOOL_USE_RE.test(String(id || ''));
}

const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
const CODEX_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
// Codex 0.144+ exposes three selectable coding-model tiers. Keep the ids in
// provider config (rather than the old "use ~/.codex/config.toml" sentinel) so
// PortOS can pass the user's choice through as `codex --model <id>`.
const CODEX_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];
const CODEX_MODEL_DEFAULTS = {
  defaultModel: 'gpt-5.6-terra',
  lightModel: 'gpt-5.6-luna',
  mediumModel: 'gpt-5.6-terra',
  heavyModel: 'gpt-5.6-sol',
};
const ANTIGRAVITY_MODEL_KEYS = ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel'];
const CODEX_CONTEXT_WINDOW = 1_000_000;
const GEMINI_CONTEXT_WINDOW = 1_048_576;
const STALE_GENERIC_CONTEXT_WINDOW = 128_000;

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

// Replace only the old sentinel-only Codex setup with the current selectable
// Codex tier catalog. Real model choices are deliberately preserved: PortOS
// must never silently erase a model selected in AI Providers.
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
      && CODEX_MODEL_KEYS.every((key) => provider[key] === CODEX_CONFIGURED_DEFAULT);
    if (!isSentinelOnly) continue;

    provider.models = [...CODEX_MODELS];
    Object.assign(provider, CODEX_MODEL_DEFAULTS);
    changed = true;
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

export function createProviderService(config = {}) {
  const {
    dataDir = './data',
    providersFile = 'providers.json',
    sampleFile = null,
    // Short TTL cache on the parsed providers.json. The hot path is an
    // N-way provider-failure storm: each failing call runs
    // pickFallbackProvider → getAllProviders → loadProviders, which used
    // to re-read providers.json from disk every time. A ~1s TTL collapses
    // that storm to a single read without making config edits feel stale
    // (provider config changes are human-paced; saveProviders refreshes
    // the cache inline so a write is reflected immediately).
    providersCacheTtlMs = 1000
  } = config;

  const PROVIDERS_PATH = join(dataDir, providersFile);

  // Last successfully-loaded providers data + the wall-clock time it was
  // cached. `providersLoadInFlight` coalesces concurrent cold reads so a
  // simultaneous burst of callers shares one disk read instead of each
  // racing its own. Per-service-instance (the toolkit builds one), so the
  // cache is process-wide for the single-user server.
  //
  // `cacheGeneration` is bumped on every cache mutation (refresh or
  // invalidate). A cold read captures it before reading disk and only
  // adopts its result if the generation is unchanged on resolve — so a
  // slow stale read can't clobber a fresher snapshot a concurrent
  // `saveProviders` wrote while it was in flight.
  let providersCache = null;
  let providersCacheAt = -Infinity;
  let providersLoadInFlight = null;
  let cacheGeneration = 0;

  function refreshProvidersCache(data) {
    // Null-prototype the providers map so a keyed lookup (`data.providers[id]`)
    // in getProviderById / setActiveProvider / updateProvider / etc. can't
    // resolve an inherited Object.prototype member (`__proto__`, `constructor`,
    // `toString`, …) as a "provider that exists". Without this, a crafted id
    // like `constructor` walks the prototype chain, tests truthy, and gets
    // treated as a real provider (e.g. persisted as `activeProvider`). Own
    // enumerable keys still serialize/iterate normally (JSON.stringify,
    // Object.values, spread, delete all behave identically on a null-proto map).
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

  async function readProvidersFromDisk() {
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
    const migratedContextWindows = migrateProviderContextWindows(data);
    if (migratedCodex || migratedAntigravity || migratedContextWindows) {
      await atomicWrite(PROVIDERS_PATH, data);
      if (migratedCodex) console.log('🔧 Migrated Codex providers to the selectable GPT-5.6 model tiers');
      if (migratedAntigravity) console.log('🔧 Migrated Gemini provider config to Antigravity CLI (agy)');
      if (migratedContextWindows) console.log('🔧 Migrated provider context windows to current canonical values');
    }

    return data;
  }

  // Cache-fronted read. Returns the cached snapshot while it's within the
  // TTL; otherwise reads from disk, coalescing concurrent cold reads into
  // a single `readProvidersFromDisk` so an N-way failure storm triggers at
  // most one read per TTL window.
  async function loadProviders() {
    if (providersCache && (Date.now() - providersCacheAt) < providersCacheTtlMs) {
      return providersCache;
    }
    if (providersLoadInFlight) return providersLoadInFlight;
    const gen = cacheGeneration;
    providersLoadInFlight = readProvidersFromDisk()
      .then(data => {
        // Adopt this read only if no write/invalidate landed while it was
        // in flight; otherwise that newer snapshot is fresher — return it
        // rather than clobbering the cache with our stale parse.
        if (cacheGeneration === gen) return refreshProvidersCache(data);
        return providersCache ?? data;
      })
      .finally(() => { providersLoadInFlight = null; });
    return providersLoadInFlight;
  }

  async function saveProviders(data) {
    // Drop the cache BEFORE the write: mutators read → mutate the cached
    // object in place → save, so the warm cache already holds the unsaved
    // mutation. Invalidating first means a failed `atomicWrite` leaves no
    // cache to serve the un-persisted change (the next read re-reads disk),
    // and refreshing only after success keeps the cache consistent with
    // what actually landed on disk.
    invalidateProvidersCache();
    await atomicWrite(PROVIDERS_PATH, data);
    refreshProvidersCache(data);
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
        fallbackModel: providerData.fallbackModel || null,
        numCtx: providerData.numCtx || null,
        contextWindow: providerData.contextWindow || null,
        timeout: providerData.timeout || 300000,
        enabled: providerData.enabled !== false,
        // Claude Ollama marker — preserve so adopting the sample via POST drives
        // ollama-backed model refresh (see isOllamaBackedProvider).
        ...(providerData.ollamaBacked === true ? { ollamaBacked: true } : {}),
        // Explicit opt-in to send the API key to an arbitrary (non-local,
        // non-allowlisted) endpoint — see internal/endpointGuard.js. Only
        // persisted when true so existing keyless/local providers stay clean.
        ...(providerData.allowCustomEndpoint === true ? { allowCustomEndpoint: true } : {}),
        envVars: providerData.envVars || {},
        secretEnvVars: providerData.secretEnvVars || [],
        headlessArgs: providerData.headlessArgs || [],
        tuiPromptDelayMs: providerData.tuiPromptDelayMs || 2500,
        tuiIdleTimeoutMs: providerData.tuiIdleTimeoutMs || 180000,
        // Absolute wall-clock ceiling for long-running TUI agents (3h). The idle
        // reaper can't bound a busy-but-stuck agent whose working counter keeps
        // repainting; the consumer (agentTuiSpawning) enforces this backstop.
        tuiMaxRuntimeMs: providerData.tuiMaxRuntimeMs || 10800000
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
        // Read fresh per call (not hoisted to module scope) so tests can drive
        // both branches by stubbing process.platform per test.
        const isWin32 = process.platform === 'win32';

        // Resolve the command on PATH. Windows has no `which` — it ships `where`
        // instead — so a `which` lookup there always fails and falsely reports the
        // command "not found in PATH" even when it resolves fine from a shell.
        // Use execFile (no shell) so user-configured `provider.command` cannot
        // inject extra shell commands via metacharacters.
        const lookup = isWin32 ? 'where' : 'which';
        const { stdout } = await execFileAsync(lookup, [provider.command])
          .catch(() => ({ stdout: '', stderr: 'not found' }));

        // `where` lists every match (one per line); `which` prints one. Take the
        // first non-empty line as the resolved absolute path.
        const commandPath = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';

        if (!commandPath) {
          return { success: false, error: `Command '${provider.command}' not found in PATH` };
        }

        // On Windows, `where` can return the wrong file: npm ships an
        // extension-less POSIX shell-script stub (for Git Bash/WSL) alongside
        // the real `.cmd`/`.bat`/`.ps1` wrappers, and `where`'s first-line
        // match is not guaranteed to be a launchable one (this is exactly
        // what produced the literal error text in #1865). Re-resolve via the
        // same extension-aware filesystem search the agent runner uses
        // (server/lib/bufferedSpawn.js's resolveWindowsExecutable), searched
        // against the same provider-envVars-merged env the runner actually
        // spawns under (so a configured PATH override is honored here too),
        // and prefer it for both the actual invocation AND what we report
        // back — falling back to the `where` result only when that search
        // finds nothing.
        const searchEnv = { ...process.env, ...provider.envVars };
        const invokePath = (isWin32 && resolveWindowsExecutable(provider.command, isWin32, searchEnv)) || commandPath;

        // Track whether the resolved path could actually be spawned. Without
        // this, a non-spawnable shim falls through to `version: 'available'`
        // and the Test button reports a provider the runner can never
        // actually invoke as usable.
        let everSpawned = false;
        const tryVersion = async (flag) => {
          // Invoke the resolved path so Windows runs the exact `.exe`/`.cmd`
          // we found — execFile won't re-apply PATHEXT to a bare command
          // name. A `.cmd`/`.bat` target still can't be launched directly
          // under shell:false (Node refuses it outright, even with the
          // explicit extension — see prepareWindowsSafeSpawn above), so wrap
          // it through cmd.exe /c exactly like the runner does.
          try {
            const { command: execCommand, args: execArgs } = prepareWindowsSafeSpawn(invokePath, [flag]);
            const out = await execFileAsync(execCommand, execArgs);
            everSpawned = true;
            return out?.stdout?.trim() || null;
          } catch (err) {
            // A numeric `code` is a non-zero EXIT — the process DID run (it just
            // doesn't support this flag), so the path is spawnable. A string code
            // (ENOENT/EACCES) or a spawn error means it could not be launched.
            if (typeof err?.code === 'number') everSpawned = true;
            return null;
          }
        };
        const versionOut = (await tryVersion('--version')) || (await tryVersion('-v'));

        if (!everSpawned) {
          return {
            success: false,
            error: `Resolved '${provider.command}' to ${invokePath} but it could not be executed (a Windows .cmd/.bat npm shim is not directly spawnable by the agent runner)`,
          };
        }

        return {
          success: true,
          path: invokePath,
          version: versionOut || 'available'
        };
      }

      if (provider.type === 'api') {
        // Never send the API key to an arbitrary/metadata host (SSRF / key
        // exfiltration). Keyless local-LLM checks are unaffected.
        if (provider.apiKey) {
          const guard = evaluateSecretEndpoint(provider.endpoint, {
            allowCustomEndpoint: provider.allowCustomEndpoint === true,
          });
          if (!guard.allowed) {
            return { success: false, error: `Endpoint blocked: ${guard.reason}` };
          }
        }
        const modelsUrl = `${provider.endpoint}/models`;
        const response = await fetch(modelsUrl, {
          headers: provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {},
          signal: AbortSignal.timeout(10000),
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
        } else if (provider.type === 'tui' && isOllamaBackedProvider(provider)) {
          // TUI providers normally don't refresh (their model is fixed by the
          // CLI/config), but the Claude-Ollama TUI variant still needs its
          // tool-use-capable Ollama model list pulled live, same as the CLI one.
          models = await this._fetchOllamaToolCapableModels(provider);
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
        const response = await fetch(ollamaUrl, { signal: AbortSignal.timeout(8000) }).catch(() => null);

        if (response?.ok) {
          const data = await response.json().catch(() => null);
          if (data?.models) {
            return data.models.map(m => m.name || m.model);
          }
        }
      }

      // Guard before attaching the API key to a generic /models fetch so a
      // hostile/mistyped endpoint can't harvest a paid LLM key (SSRF).
      assertSecretEndpoint(provider.endpoint, {
        hasSecret: Boolean(provider.apiKey),
        allowCustomEndpoint: provider.allowCustomEndpoint === true,
      });

      const modelsUrl = `${provider.endpoint}/models`;
      const headers = {};

      if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);

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

      // Claude Ollama: a `claude` CLI pointed at a local Ollama daemon. Pull the
      // installed Ollama models (filtered to tool-use-capable ones — the agent
      // harness depends on reliable tool-calling) instead of the static Anthropic
      // list. Checked BEFORE the generic claude branch below.
      if (isOllamaBackedProvider(provider)) {
        return await this._fetchOllamaToolCapableModels(provider);
      }

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

    async _fetchOllamaToolCapableModels(provider) {
      const base = ollamaBaseFromProvider(provider);
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!res?.ok) {
        throw new Error(`Ollama unreachable at ${base} (HTTP ${res?.status || 'error'})`);
      }
      const data = await res.json().catch(() => null);
      const names = (data?.models || []).map(m => m.name || m.model).filter(Boolean);

      // Query /api/show per model for the authoritative `tools` capability; fall
      // back to the id heuristic when the daemon doesn't answer. Filter to
      // tool-use-capable models only — a Claude harness on a non-tool model
      // "runs" but silently fails to edit files.
      const checked = await Promise.all(names.map(async (name) => {
        const showRes = await fetch(`${base}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name, name }),
          signal: AbortSignal.timeout(8000)
        }).catch(() => null);
        const showData = showRes?.ok ? await showRes.json().catch(() => null) : null;
        const capabilities = Array.isArray(showData?.capabilities) ? showData.capabilities : null;
        return ollamaModelSupportsTools(name, capabilities) ? name : null;
      }));
      return checked.filter(Boolean);
    },

    async _fetchAnthropicModels(_provider) {
      return [
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-sonnet-5',
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
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { signal: AbortSignal.timeout(8000) }
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
