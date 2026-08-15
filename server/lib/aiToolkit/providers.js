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
  parseAntigravityModelList,
} from './internal/antigravity.js';
import {
  CURSOR_COMMAND,
  parseCursorModelList,
} from './internal/cursor.js';
import { isOllamaBackedProvider, ollamaBaseFromProvider } from './internal/ollamaBacked.js';
import { canRefreshModels, ollamaRefreshGroupKey, resolveModelFetcher } from './internal/modelFetchers.js';

// Re-exported (rather than defined here) so the model-fetcher table can key its
// ollama row on the same predicate without importing back into this module.
export { isOllamaBackedProvider };
// Groups providers that share one daemon + one probe shape, so a host fanning a
// refresh across them can fetch once instead of once per provider. The base-URL
// normalizer it keys on stays internal — the group key IS the contract, and an
// exported normalizer only invites callers to re-derive the grouping rule.
export { ollamaRefreshGroupKey };
// The pure capability predicate that both refresh arms below dispatch through —
// exported so the providers route can decorate its payload with it and the
// client stops re-deriving refreshability from command/name string sniffing.
export { canRefreshModels };

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
  'deepseek-v3', 'deepseek-r1', 'deepseek-v4',
].join('|'), 'i');

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
// agy exposes a per-session `--model` flag and lists its catalog via
// `agy models`. This is the shipped fallback list (agy 2026-07) used to seed a
// fresh install and when the live `agy models` probe can't run; the AI Providers
// "Refresh models" button replaces it with whatever the installed binary
// reports, which is the authoritative list for that user's plan.
const ANTIGRAVITY_MODELS = [
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];
// The sentinel stays FIRST in the list and remains the value of every
// `*Model` key: an install that never picks a model keeps agy's own configured
// default (no `--model` flag), exactly as before. The real ids ride alongside so
// the task/schedule model pickers (which filter the sentinel out) can offer a
// per-run override.
const ANTIGRAVITY_MODEL_CATALOG = [ANTIGRAVITY_CONFIGURED_DEFAULT, ...ANTIGRAVITY_MODELS];
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

// Remove a `--model <id>` / `--model=<id>` pin (both spellings) from a legacy
// Gemini-CLI argv being converted to agy. Only the legacy migration wants this —
// on the spawn paths a long-form `--model` is a legitimate agy pin and is kept.
function stripLegacyModelPin(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model') {
      const next = args[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) i += 1; // skip its value
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
      // Drop any `--model` the legacy argv pinned BEFORE normalizing. The arg
      // builders deliberately preserve a long-form `--model` (agy accepts it,
      // so a pin is a real user selection) — but this argv came from the
      // *Gemini* CLI, so its pin is a Gemini id (`gemini-2.5-pro`) that agy
      // cannot resolve. Carrying it over would both break every run AND make
      // `hasModelFlag` permanently suppress PortOS's own injection, leaving the
      // user no way to fix it short of hand-editing the provider args.
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

// Installs that already migrated to `agy` carry the sentinel-only model list
// from before agy grew a `--model` flag. Widen it to the shipped catalog so the
// task/schedule pickers have something to offer. Guarded on "sentinel-only" so a
// user's own list (or one already refreshed from `agy models`) is never
// overwritten, and the `*Model` keys are left alone so run behavior is unchanged
// until the user actually picks a model.
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
    if (!isSentinelOnly) continue;

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
    const migratedAntigravityModels = migrateAntigravityModelCatalog(data);
    const migratedContextWindows = migrateProviderContextWindows(data);
    if (migratedCodex || migratedAntigravity || migratedAntigravityModels || migratedContextWindows) {
      await atomicWrite(PROVIDERS_PATH, data);
      if (migratedCodex) console.log('🔧 Migrated Codex providers to the selectable GPT-5.6 model tiers');
      if (migratedAntigravity) console.log('🔧 Migrated Gemini provider config to Antigravity CLI (agy)');
      if (migratedAntigravityModels) console.log('🔧 Migrated Antigravity providers to the selectable agy model catalog');
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

    /**
     * Probe a provider's model list WITHOUT persisting it — the compute half of
     * {@link refreshProviderModels}.
     *
     * Split out so a host fanning a refresh across several providers backed by
     * the SAME upstream (see {@link ollamaRefreshGroupKey}) can run the probe
     * once and apply the answer to each of them via `updateProvider`, instead of
     * re-issuing an identical `/api/tags` + per-model `/api/show` sweep per
     * provider.
     *
     * Same contract as `refreshProviderModels` minus the write: `null` means
     * ONLY "no such provider"; every other failure throws (with `.status`).
     *
     * @param {string} id
     * @returns {Promise<string[]|null>}
     */
    async fetchProviderModels(id) {
      const data = await loadProviders();
      const provider = data.providers[id];

      if (!provider) {
        return null;
      }

      // `null` = no refreshable branch matched below (provider type/shape isn't
      // refreshable — the pre-existing no-op case); an array = a completed
      // fetch, which may legitimately be empty (e.g. an Ollama-backed provider
      // whose only installed model was just deleted). Only the `null` sentinel
      // means "nothing to persist" — a `.length === 0` check here would also
      // swallow that legitimate empty result and leave a deleted model stuck
      // in the provider's persisted list.
      let models = null;

      try {
        // A TUI provider's model is normally fixed by its CLI/config, so only
        // the vendors whose `--model` flag also applies to the interactive
        // session carry a `tuiMatch` column in the table (ollama-backed,
        // antigravity, cursor today). One lookup replaces the per-vendor
        // `else if` chain this used to be — see internal/modelFetchers.js.
        const tuiFetcher = provider.type === 'tui' ? resolveModelFetcher(provider) : null;

        if (provider.type === 'api') {
          models = await this._refreshAPIProviderModels(provider);
        } else if (provider.type === 'cli') {
          models = await this._refreshCLIProviderModels(provider);
        } else if (tuiFetcher) {
          models = await this[tuiFetcher.fetch](provider);
        } else {
          // No branch matched — this provider type/shape has no fetcher. Say so,
          // the same 400 the CLI arm's own fall-through throws. Previously this
          // fell out as `models === null` and the route rendered it as
          // `404 Provider not found or not an API type`, which is exactly the
          // false message the rethrow above set out to stop showing: a plain
          // `codex-tui`/`grok-tui` provider exists and its type is fine, it just
          // has no catalog to fetch.
          const unsupported = new Error(`Model refresh not supported for ${provider.type} provider '${provider.id}'`);
          unsupported.status = 400;
          throw unsupported;
        }
      } catch (error) {
        console.error(`Failed to refresh models for ${provider.name}:`, error.message);
        // RETHROW rather than collapsing to null. `null` means one specific
        // thing here — "no refreshable branch matched" — and the route turns it
        // into `404 Provider not found or not an API type`. Folding a fetcher
        // failure into that same null made the user's toast read "Provider not
        // found or not an API type" when the provider exists and its type is
        // fine, burying the actual cause (`'cursor-agent models' failed: …
        // ENOENT`) in the server log. That defeats the whole point of the
        // throw-don't-fall-back posture in `_execCliModelList`: it goes to the
        // trouble of refusing to persist a plausible-looking default precisely
        // so the user learns WHY the refresh failed.
        // 502, not 500: the failure is an upstream/vendor probe, not a bug here.
        // The other caller (localLlm's post-install fan-out) already catches and
        // logs per provider, so it is unaffected.
        error.status = error.status || 502;
        throw error;
      }

      // Belt-and-braces: every branch above returns an array or throws, so this
      // is unreachable today — but a future fetcher that returns null must not
      // persist `models: null` over the user's list. Throws rather than
      // returning null so `null` keeps exactly ONE meaning out of this function:
      // the provider does not exist. That is what lets the route's 404 say
      // plainly "Provider not found" instead of guessing at a reason.
      if (models === null) {
        const unsupported = new Error(`Model refresh returned nothing for provider '${provider.id}'`);
        unsupported.status = 400;
        throw unsupported;
      }

      return models;
    },

    /**
     * Probe AND persist a provider's model list. Thin composition of
     * {@link fetchProviderModels} + `updateProvider` — keep it that way so the
     * two halves can't drift.
     */
    async refreshProviderModels(id) {
      const models = await this.fetchProviderModels(id);
      if (models === null) return null;
      return this.updateProvider(id, { models });
    },

    /**
     * Refresh MANY providers with ONE `providers.json` write.
     *
     * `refreshProviderModels` is a per-provider `loadProviders` → mutate →
     * `saveProviders` round-trip, and `saveProviders` invalidates the cache and
     * rewrites the whole file. A host fanning a refresh across every provider
     * backed by one local daemon (PortOS does this after an Ollama install or
     * delete) therefore paid N full-file writes — each superseded by the next —
     * plus N cache invalidate/repopulate cycles for any concurrent reader. This
     * does the same work as three phases: group, probe, then a single write.
     *
     * 1. **Group** by {@link ollamaRefreshGroupKey}, so providers sharing a
     *    daemon AND a probe shape are probed once rather than once each. A
     *    `null` key is the "not a shared Ollama probe" sentinel, NOT a bucket —
     *    those providers each become a group of one and keep their own probe.
     * 2. **Probe** one lead per group, sequentially. Nothing is persisted here,
     *    so a probe that fails or answers late cannot leave a half-written file.
     * 3. **Apply + save once.** The providers map is re-read after the probes
     *    (they are network-bound and outlive the read cache's TTL), every
     *    probed list is applied in one pass, and `saveProviders` runs exactly
     *    once — or not at all when nothing was probed successfully.
     *
     * Never throws for a per-provider failure: each group carries its own
     * outcome so the host can log group-level context (one line per group, not
     * one per member) and decide what a failure means.
     *
     * - `updated` — probed successfully; `models` was applied to every member
     *   still present at save time. `[]` is a real answer (the user deleted
     *   their last model) and IS persisted; only the two statuses below skip.
     * - `failed` — the probe threw; `error` carries it. The stored lists are
     *   left untouched.
     * - `missing` — no such provider, or the lead was deleted between the
     *   grouping read and its probe.
     *
     * @param {string[]} ids
     * @returns {Promise<Array<{ ids: string[], leadId: string, status: 'updated'|'failed'|'missing', models?: string[], error?: Error }>>}
     */
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
        // `missing` is the starting status for EVERY group, not just the ones
        // whose id is already unknown: the probe below either upgrades it or
        // leaves it, which is exactly the answer for a lead that vanished
        // between this read and its probe.
        const group = { ids: [id], leadId: id, status: 'missing' };
        if (key) byKey.set(key, group);
        groups.push(group);
      }

      // Sequential, not `Promise.all`: several groups commonly hit the same
      // local daemon, and this whole call is background work behind an
      // install/delete, so nothing is waiting on the wall clock.
      for (const group of groups) {
        if (!data.providers[group.leadId]) continue;
        const probed = await this.fetchProviderModels(group.leadId).then(
          (models) => ({ models }),
          (error) => ({ error })
        );
        if (probed.error) {
          group.status = 'failed';
          group.error = probed.error;
          continue;
        }
        // `null` here means the lead vanished mid-probe — the same `missing`
        // the group already carries, so leave the status alone. Validated as an
        // ARRAY rather than compared to `null`: `fetchProviderModels` promises
        // an array or a throw, but a future fetcher that leaks `undefined` must
        // land on `missing` too, not be persisted as an "updated" catalog (and
        // then crash the whole batch on the spread below). `[]` is an array, so
        // a legitimately empty catalog still passes.
        if (!Array.isArray(probed.models)) continue;
        group.status = 'updated';
        group.models = probed.models;
      }

      const updated = groups.filter((g) => g.status === 'updated');
      if (updated.length === 0) return groups;

      // Re-read rather than reusing the pre-probe snapshot: the probes above are
      // network-bound and outlast the read cache's TTL, so `data` may no longer
      // be the freshest view. Writing our stale copy would drop anything saved
      // while we were probing.
      const fresh = await loadProviders();
      let changed = false;
      for (const group of updated) {
        for (const id of group.ids) {
          const provider = fresh.providers[id];
          // Deleted between the grouping read and now — nothing to write, and
          // re-adding it here would resurrect a provider the user removed.
          if (!provider) continue;
          // Copy the list per provider so members of one group don't end up
          // sharing (and later mutating) a single array instance.
          fresh.providers[id] = { ...provider, models: [...group.models], id };
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

      // THROW rather than degrade to `[]` — same posture as `_execCliModelList`.
      // A 200 carrying a non-JSON body (an HTML login/captcha page, a proxy
      // error page) or a shape with neither `data` nor `models` means the probe
      // FAILED; returning an empty list makes that indistinguishable from a
      // provider whose catalog is legitimately empty. `refreshProviderModels`
      // persists whatever comes back and the UI toasts "Models refreshed", so
      // the degraded path silently empties the model dropdown with no reason
      // shown. Propagating the error leaves the stored list untouched and puts
      // the real cause in the toast. A body that parses to a genuinely empty
      // `data`/`models` array still returns `[]` — that distinction is the point.
      const responseData = await response.json().catch(() => null);

      if (!responseData || typeof responseData !== 'object') {
        throw new Error('Model list response was not valid JSON');
      }

      // Entries are usually `{ id }` under `data` and bare strings under
      // `models`, but servers mix all four shapes. Returning them unmapped (or
      // mapping `m.id` blindly) persisted raw objects / a list of `undefined` —
      // a plausible-looking, entirely unusable catalog. Anything that still
      // resolves to nothing means the shape isn't one we understand, so throw
      // rather than save it, same posture as the unparseable-body case above.
      const toModelIds = (entries, key) => {
        const ids = entries.map(m => (typeof m === 'string' ? m : (m?.id || m?.name || m?.model)));
        if (ids.some(id => typeof id !== 'string' || !id)) {
          throw new Error(`Model list response had "${key}" entries with no usable model id`);
        }
        return ids;
      };

      if (Array.isArray(responseData.data)) return toModelIds(responseData.data, 'data');
      if (Array.isArray(responseData.models)) return toModelIds(responseData.models, 'models');

      throw new Error('Model list response had no recognizable "data" or "models" array');
    },

    async _refreshCLIProviderModels(provider) {
      // One lookup, not a per-vendor `if` chain. The table
      // (internal/modelFetchers.js) also owns the ORDER this used to encode in
      // prose: the ollama row first (a `claude` CLI pointed at a local Ollama
      // daemon must pull the installed tool-use-capable models, not the static
      // Anthropic list), then every command/structural match, and only then the
      // weaker display-name matches — so a cursor provider a user renamed
      // "Cursor Claude Opus" reaches cursor-agent rather than having Anthropic's
      // catalog persisted onto it.
      const fetcher = resolveModelFetcher(provider);

      if (fetcher) {
        return await this[fetcher.fetch](provider);
      }

      // 400, not the rethrow's 502 default: nothing upstream failed — this CLI
      // simply has no fetcher, which is a bad request, not a bad gateway.
      const unsupported = new Error('Model refresh not supported for this CLI provider');
      unsupported.status = 400;
      throw unsupported;
    },

    /**
     * agy ships an `agy models` subcommand that prints one model id per line —
     * the authoritative catalog for this user's plan and binary version, which
     * a hardcoded list can only go stale against.
     *
     * Throws rather than falling back to `ANTIGRAVITY_MODEL_CATALOG` on a failed
     * or unparseable probe — see `_execCliModelList` for why that matters. The
     * shipped catalog is for *seeding and migration* only.
     *
     * The sentinel is always re-prepended: it is what keeps "use agy's own
     * configured default" selectable after a refresh.
     */
    async _fetchAntigravityModels(provider) {
      const listed = await this._execCliModelList(provider, 'agy', parseAntigravityModelList);
      return [ANTIGRAVITY_CONFIGURED_DEFAULT, ...new Set(listed)];
    },

    /**
     * Shared scaffolding for every "shell `<bin> models` and parse stdout"
     * fetcher. Owns the spawn conventions the vendors agree on — the Windows-safe
     * invocation, the 15s cap, the provider `envVars` merge, closing the child's
     * stdin, and the two failure messages — so a change to any of them (adding
     * stderr to the error, reacting to a spawn quirk) is one edit rather than one
     * per vendor. What differs per vendor is only the default binary and the
     * parser; a sentinel prepend, if any, belongs to the caller.
     *
     * THROWS on a probe that can't run (binary not installed, service PATH can't
     * resolve it, timeout, non-zero exit) AND on one that returns nothing
     * parseable — never returns an empty list. That is the load-bearing part:
     * every caller's alternative would be its shipped seed catalog, and
     * surfacing that from a refresh would make a failed probe indistinguishable
     * from a real fetch — `refreshProviderModels` would persist it and the UI
     * would toast "Models refreshed", so a user whose PATH can't see the binary
     * would pick a model their plan doesn't have and only find out when the run
     * dies. `refreshProviderModels` propagates the throw (as a 502) rather than
     * flattening it to null, so the toast names the actual cause instead of the
     * route's generic not-found text — and the stored list is left untouched
     * either way, since nothing is persisted. Same posture as
     * `_fetchOllamaToolCapableModels`, and the root CLAUDE.md rule that a
     * reachable-but-list-failed backend must surface an explicit error rather
     * than a plausible-looking empty/default result.
     *
     * @param {object} provider
     * @param {string} defaultBin - binary to use when the provider pins no command
     * @param {(stdout: string) => string[]} parse - vendor's stdout → ids parser
     * @returns {Promise<string[]>} a non-empty id list
     */
    async _execCliModelList(provider, defaultBin, parse) {
      const bin = provider?.command || defaultBin;
      const { command, args } = prepareWindowsSafeSpawn(bin, ['models']);
      const pending = execFileAsync(command, args, {
        timeout: 15000,
        env: { ...process.env, ...provider?.envVars },
      });
      // Close the child's stdin immediately. `agy models` blocks on an open
      // stdin and prints NOTHING until it closes — with execFile's default pipe
      // that's a full 15s hang ending in SIGTERM and an empty catalog. (execFile
      // ignores an `stdio` option, so ending the stream is the way to do it.)
      // Not every vendor needs it — cursor-agent 2026.08.04 answers in well
      // under a second either way (measured 848ms with stdin open vs 825ms
      // closed) — but it costs one FD close and makes the probe immune whether
      // or not a given binary has the behavior.
      pending.child?.stdin?.end();
      const { stdout } = await pending.catch((err) => {
        throw new Error(`'${bin} models' failed: ${err?.message || 'could not run the binary'}`);
      });

      const listed = parse(stdout);
      if (listed.length === 0) {
        throw new Error(`'${bin} models' returned no model ids`);
      }
      return listed;
    },

    /**
     * cursor-agent ships a `models` subcommand that prints the authoritative
     * catalog for THIS account and binary version — 177 ids at time of writing,
     * against the 27 hand-curated ones the provider seed ships. Unlike Grok/Kimi
     * (no catalog subcommand at all, hence their `*-configured-default`
     * sentinel), cursor can answer for itself, so a refresh asks it rather than
     * re-serving a list that can only go stale.
     *
     * Throws rather than falling back to the shipped 27-id seed on a failed or
     * unparseable probe — see `_execCliModelList` for why that matters.
     *
     * No sentinel is prepended (the one structural difference from the agy
     * fetcher): cursor exposes a real `auto` id — its own server-side router,
     * and the binary's default — and `models` lists it first, so "let cursor
     * choose" survives a refresh as an ordinary catalog entry.
     *
     * The full list is persisted as reported, `-fast` priority-compute twins
     * included. A refresh is an explicit user action and the account catalog is
     * the authoritative answer; any thinning belongs in the picker, not here, so
     * the stored list stays faithful to what the binary will actually accept.
     */
    async _fetchCursorModels(provider) {
      return await this._execCliModelList(provider, CURSOR_COMMAND, parseCursorModelList);
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
        'claude-opus-5',
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
        // 400 for the same reason as the endpoint guard: a missing key is the
        // user's to fix, not an upstream outage.
        const missingKey = new Error('Google API key required for model refresh');
        missingKey.status = 400;
        throw missingKey;
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
