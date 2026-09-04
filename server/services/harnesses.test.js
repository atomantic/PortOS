import { beforeEach, describe, expect, it, vi } from 'vitest';

// The npm-prefix probe shells out; PATH adoption is covered by lib/npmGlobalBin.test.js.
const npmGlobalBin = vi.hoisted(() => ({ adoptNpmGlobalBinDir: vi.fn(async () => null) }));
vi.mock('../lib/npmGlobalBin.js', () => npmGlobalBin);

// `opencode models` reads a cache file this module primes over the network.
// Unmocked, the suite would fetch a multi-megabyte catalog and overwrite the
// developer's real `~/.cache/opencode/models.json`.
const opencodeCatalog = vi.hoisted(() => ({
  primeOpencodeCatalogCache: vi.fn(async () => ({ primed: true, reason: 'stubbed' })),
}));
vi.mock('../lib/opencodeCatalogCache.js', () => opencodeCatalog);

const providerService = vi.hoisted(() => ({
  // `listProviders()` resolves the records as an ARRAY — the envelope
  // (`{ activeProvider, providers: [...] }`) is `getAllProviders`'s shape, and
  // mocking the wrong one is exactly how a caller's `Array.isArray` guard
  // silently yields an empty list.
  listProviders: vi.fn(),
  updateProvider: vi.fn(async () => ({})),
}));
vi.mock('./providers.js', () => providerService);

import { prepareCliSpawn } from '../lib/bufferedSpawn.js';
import {
  __resetLatestVersionCache,
  getLatestPublishedVersion,
  listHarnesses,
  refreshHarnessModels,
  usesHarnessCatalog,
} from './harnesses.js';
import { __resetRuntimeStatusCache, PROVIDER_RUNTIMES } from './providerRuntimeInstaller.js';
import { providerRuntimeKey } from '../lib/providerPrerequisites.js';

const OPENCODE_MODELS = 'opencode/big-pickle\nopencode/mimo-v2.5-free\n';

// PATH resolution is injected too, so these never depend on what is actually
// installed on the machine running the suite.
const found = { findCommand: async (command) => `/example/${command}` };

// A plain wrapper (harness catalog), a gateway-backed one, and a local-runtime
// one — the three classes the refresh has to tell apart.
const providers = {
  'opencode-zen-cli': { id: 'opencode-zen-cli', name: 'OpenCode Zen CLI', type: 'cli', command: 'opencode', enabled: true, models: ['opencode/stale'], defaultModel: 'opencode/stale' },
  'opencode-zen-tui': { id: 'opencode-zen-tui', name: 'OpenCode Zen TUI', type: 'tui', command: 'opencode', enabled: false, models: [], defaultModel: null },
  'opencode-openrouter': { id: 'opencode-openrouter', name: 'OpenCode OpenRouter', type: 'cli', command: 'opencode', enabled: true, gatewayBacked: 'openrouter', models: ['openrouter/auto'], defaultModel: 'openrouter/auto' },
  'opencode-ollama': { id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', enabled: false, ollamaBacked: true, models: ['ollama/qwen'], defaultModel: 'ollama/qwen' },
  'claude-code': { id: 'claude-code', name: 'Claude Code CLI', type: 'cli', command: 'claude', enabled: true, models: [] },
};

beforeEach(() => {
  __resetRuntimeStatusCache();
  __resetLatestVersionCache();
  providerService.listProviders.mockResolvedValue(Object.values(providers));
  providerService.updateProvider.mockClear();
  opencodeCatalog.primeOpencodeCatalogCache.mockClear();
});

// `usesHarnessCatalog` keys on the ABSENCE of a backend marker, so the class it
// names grows whenever an un-marked provider is seeded. This is the gate that
// makes that growth deliberate: it walks the shipped catalog and states exactly
// which records a "Refresh models" click may rewrite. Adding a provider here is
// a decision; arriving here by accident is the bug — a refresh would replace a
// working `models` list with ids that record's own backend cannot resolve.
describe('the shipped records a harness refresh may rewrite', () => {
  it('is exactly this list', async () => {
    const seed = JSON.parse(
      await import('node:fs').then(({ readFileSync }) => readFileSync(
        new URL('../../data.reference/providers.json', import.meta.url), 'utf8',
      )),
    );
    const rewritable = Object.values(seed.providers)
      .filter((provider) => {
        const runtime = PROVIDER_RUNTIMES.find((row) => [row.id, ...row.aliases].includes(providerRuntimeKey(provider)));
        return Boolean(runtime?.modelsArgs) && usesHarnessCatalog(provider);
      })
      .map((provider) => provider.id)
      .sort();

    expect(rewritable).toEqual([
      // The three harnesses that can enumerate their own models, crossed with
      // the wrappers that run those models natively. Every OpenCode wrapper
      // pointed at a local daemon or a hosted gateway is correctly absent.
      'antigravity-cli', 'antigravity-tui',
      'cursor-cli', 'cursor-tui',
      'grok-cli', 'grok-tui',
      'opencode-zen-cli', 'opencode-zen-tui',
    ]);
  });
});

describe('usesHarnessCatalog', () => {
  it('is true only for a wrapper with no local runtime and no gateway', () => {
    expect(usesHarnessCatalog(providers['opencode-zen-cli'])).toBe(true);
    // A gateway wrapper serves `openrouter/*`; a local one serves `ollama/*`.
    // Neither id ever appears in `opencode models`, so overwriting their lists
    // would point them at models their own config cannot resolve.
    expect(usesHarnessCatalog(providers['opencode-openrouter'])).toBe(false);
    expect(usesHarnessCatalog(providers['opencode-ollama'])).toBe(false);
  });

  it('reads the legacy per-gateway boolean, so old records need no migration', () => {
    expect(usesHarnessCatalog({ command: 'opencode', orcarouterBacked: true })).toBe(false);
  });

  // The `*Backed` markers are only ever written by PortOS's own editor, so a
  // hand-written config declaring its own provider entry is invisible to them —
  // and a refresh would replace its curated list with ids that config cannot
  // resolve. A declared provider entry IS the backend marker for those records.
  it('is false for a record that hand-declares its own OpenCode provider entry', () => {
    expect(usesHarnessCatalog({
      command: 'opencode',
      envVars: { OPENCODE_CONFIG_CONTENT: '{"provider":{"myco":{"npm":"@ai-sdk/openai-compatible"}}}' },
    })).toBe(false);
  });

  it('stays true for the seeded Zen shape and for an unparseable config', () => {
    // The seeds ship a posture and nothing else.
    expect(usesHarnessCatalog({
      command: 'opencode',
      envVars: { OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}' },
    })).toBe(true);
    // OpenCode cannot read a broken config either, so it declares nothing.
    expect(usesHarnessCatalog({ command: 'opencode', envVars: { OPENCODE_CONFIG_CONTENT: '{not json' } })).toBe(true);
  });
});

describe('getLatestPublishedVersion', () => {
  // `npm` is a `.cmd` shim on Windows and `execFile` under `shell: false`
  // targets the literal string with no PATHEXT search, so a bare 'npm' never
  // runs there — `latestVersion` would be permanently null and the staleness
  // detection this page exists for silently dead.
  it('spawns npm through the Windows-safe launcher', async () => {
    const run = vi.fn(async () => '1.19.0');

    expect(await getLatestPublishedVersion('opencode-ai', { run })).toBe('1.19.0');

    const [command, args] = run.mock.calls[0];
    expect(prepareCliSpawn('npm', ['view', 'opencode-ai', 'version'])).toEqual({ command, args });
  });

  // `null` is NOT-KNOWN. Caching it would freeze a transient network blip in
  // for the full TTL and paint every harness as version-unknown.
  it('answers null without caching when the registry could not be read', async () => {
    const run = vi.fn(async () => null);

    expect(await getLatestPublishedVersion('opencode-ai', { run })).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('listHarnesses', () => {
  // Every child-process and registry boundary is injected: nothing here spawns
  // a real CLI or reaches npm.
  const deps = () => ({
    findCommand: async (command) => (command === 'opencode' || command === 'npm' ? `/example/${command}` : null),
    probeCommand: async () => '1.18.27',
    run: async () => '9.9.9',
  });

  it('links each harness to the providers that launch it', async () => {
    const rows = await listHarnesses(deps());
    const opencode = rows.find((row) => row.id === 'opencode');

    expect(opencode.providers.map((provider) => provider.id).sort()).toEqual([
      'opencode-ollama', 'opencode-openrouter', 'opencode-zen-cli', 'opencode-zen-tui',
    ]);
    // The Claude wrapper launches `claude`, so it must not appear here.
    expect(opencode.providers.some((provider) => provider.id === 'claude-code')).toBe(false);
    expect(opencode.providers.find((p) => p.id === 'opencode-zen-cli').usesHarnessCatalog).toBe(true);
    expect(opencode.providers.find((p) => p.id === 'opencode-ollama').usesHarnessCatalog).toBe(false);
  });

  it('never publishes a resolved executable path', async () => {
    // A global bin directory embeds the host account name.
    expect(JSON.stringify(await listHarnesses(deps()))).not.toContain('/example/');
  });

  // `providerRuntimeKey` answers "does the BARE binary resolve on PortOS's
  // PATH?" — which is not the question for a record that pins its own path or
  // its own PATH. Attributing those here would inflate the removal warning and
  // let a refresh rewrite them from a catalog a different binary printed.
  it('does not claim a provider that pins its own path or PATH', async () => {
    providerService.listProviders.mockResolvedValue(Object.values({
      pathed: { id: 'pathed', type: 'cli', command: '/opt/tools/opencode', name: 'Pathed' },
      envd: { id: 'envd', type: 'cli', command: 'opencode', name: 'Own PATH', envVars: { PATH: '/opt/tools' } },
      plain: { id: 'plain', type: 'cli', command: 'opencode', name: 'Plain' },
    }));

    const opencode = (await listHarnesses(deps())).find((row) => row.id === 'opencode');

    expect(opencode.providers.map((provider) => provider.id)).toEqual(['plain']);
  });
});

describe('refreshHarnessModels', () => {
  // An npm-installed harness is a `.cmd` shim on Windows, which `execFile`
  // under `shell: false` refuses outright — probing the bare name would answer
  // nothing and tell a signed-in user to go sign in.
  it('probes the RESOLVED executable, the way the version probe does', async () => {
    const run = vi.fn(async (command, args) => (args[0] === 'models' ? OPENCODE_MODELS : '1.18.27'));

    await refreshHarnessModels('opencode', { run, ...found });

    expect(run).toHaveBeenCalledWith('/example/opencode', ['models'], expect.anything());
  });

  // `opencode models` prints from an on-disk catalog OpenCode refreshes on its
  // own, silently and — on a host whose IPv6 default route goes nowhere — not at
  // all. Without this step the button re-reads a catalog frozen weeks ago and
  // still reports success, so a model another machine already lists never
  // appears here.
  it('primes the OpenCode catalog before probing, and only for OpenCode', async () => {
    const run = vi.fn(async (command, args) => (args[0] === 'models' ? OPENCODE_MODELS : '1.18.27'));

    await refreshHarnessModels('opencode', { run, ...found });
    expect(opencodeCatalog.primeOpencodeCatalogCache).toHaveBeenCalledTimes(1);

    // Every other harness enumerates its models live; there is no file to prime,
    // and reaching for OpenCode's would be writing a cache nothing here reads.
    await refreshHarnessModels('grok', {
      run: async (command, args) => (args[0] === 'models' ? 'Available models:\n  - grok-4.5\n' : 'grok 1.0.13'),
      ...found,
    });
    expect(opencodeCatalog.primeOpencodeCatalogCache).toHaveBeenCalledTimes(1);
  });

  it('writes the harness catalog only to providers that draw from it', async () => {
    const run = vi.fn(async (command, args) => (args[0] === 'models' ? OPENCODE_MODELS : '1.18.27'));

    const result = await refreshHarnessModels('opencode', { run, ...found });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['opencode/big-pickle', 'opencode/mimo-v2.5-free']);
    expect(result.updated.sort()).toEqual(['opencode-zen-cli', 'opencode-zen-tui']);
    expect(providerService.updateProvider).toHaveBeenCalledTimes(2);
    for (const [, patch] of providerService.updateProvider.mock.calls) {
      expect(patch.models).toEqual(['opencode/big-pickle', 'opencode/mimo-v2.5-free']);
    }
  });

  it('repoints a default model the harness no longer lists, and keeps one it does', async () => {
    const run = vi.fn(async (command, args) => (args[0] === 'models' ? OPENCODE_MODELS : '1.18.27'));
    providerService.listProviders.mockResolvedValue(Object.values({
      stale: { id: 'stale', type: 'cli', command: 'opencode', models: [], defaultModel: 'opencode/gone' },
      kept: { id: 'kept', type: 'cli', command: 'opencode', models: [], defaultModel: 'opencode/mimo-v2.5-free' },
    }));

    await refreshHarnessModels('opencode', { run, ...found });

    const patches = Object.fromEntries(providerService.updateProvider.mock.calls);
    // A pin the refresh orphaned would leave the record requesting a model its
    // own picker no longer shows.
    expect(patches.stale.defaultModel).toBe('opencode/big-pickle');
    expect(patches.kept.defaultModel).toBe('opencode/mimo-v2.5-free');
  });

  // A `*-configured-default` is the "send no --model" marker, not a model the
  // vendor will ever print. Dropping it silently repins the wrapper onto a
  // concrete model AND removes the option from the editor's picker, which is
  // rendered from this same list — so the refresh would be unrecoverable in the UI.
  it('preserves a configured-default sentinel the harness will never list', async () => {
    const run = vi.fn(async (command, args) => (args[0] === 'models'
      ? 'Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n'
      : 'grok 1.0.13'));
    providerService.listProviders.mockResolvedValue([{
      id: 'grok-cli',
      type: 'cli',
      command: 'grok',
      models: ['grok-configured-default'],
      defaultModel: 'grok-configured-default',
    }]);

    const result = await refreshHarnessModels('grok', { run, ...found });

    expect(result.ok).toBe(true);
    const [, patch] = providerService.updateProvider.mock.calls[0];
    expect(patch.models).toEqual(['grok-configured-default', 'grok-4.6', 'grok-4.5']);
    // The pin survives, so the provider keeps sending no `--model` at all.
    expect(patch.defaultModel).toBe('grok-configured-default');
  });

  // `opencode models` prints every namespace the local OpenCode is signed into,
  // not just `opencode/*`. Writing an `anthropic/*` id into a record named
  // "OpenCode Zen CLI" whose key field is OPENCODE_API_KEY would offer the user
  // a model that bills a different account.
  it('holds a record to its own namespace scope', async () => {
    const run = vi.fn(async (command, args) => (args[0] === 'models'
      ? 'opencode/big-pickle\nanthropic/claude-opus-5\nopencode/mimo-v2.5-free\n'
      : '1.18.27'));
    providerService.listProviders.mockResolvedValue([
      { id: 'opencode-zen-cli', type: 'cli', command: 'opencode', models: ['opencode/stale'], defaultModel: 'opencode/stale' },
    ]);

    await refreshHarnessModels('opencode', { run, ...found });

    const [, patch] = providerService.updateProvider.mock.calls[0];
    expect(patch.models).toEqual(['opencode/big-pickle', 'opencode/mimo-v2.5-free']);
  });

  it('leaves a record alone when nothing in its namespace came back', async () => {
    // Blanking a working list on "the harness stopped listing your vendor" is
    // the same bad trade as blanking it on an empty probe.
    const run = vi.fn(async (command, args) => (args[0] === 'models' ? 'anthropic/claude-opus-5\n' : '1.18.27'));
    providerService.listProviders.mockResolvedValue([
      { id: 'opencode-zen-cli', type: 'cli', command: 'opencode', models: ['opencode/stale'], defaultModel: 'opencode/stale' },
    ]);

    const result = await refreshHarnessModels('opencode', { run, ...found });

    expect(result.ok).toBe(true);
    expect(result.updated).toEqual([]);
    expect(providerService.updateProvider).not.toHaveBeenCalled();
  });

  // A harness whose ids are bare (agy, grok, cursor) has no namespace to hold.
  it('applies no scope filter to a harness with bare model ids', async () => {
    const run = vi.fn(async (command, args) => (args[0] === 'models'
      ? 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      : '1.1.25'));
    providerService.listProviders.mockResolvedValue([
      { id: 'antigravity-cli', type: 'cli', command: 'agy', models: ['gemini-3.7-flash-high'], defaultModel: 'gemini-3.7-flash-high' },
    ]);

    await refreshHarnessModels('agy', { run, ...found });

    const [, patch] = providerService.updateProvider.mock.calls[0];
    expect(patch.models).toEqual(['gemini-3.8-flash-high']);
  });

  it('refuses an empty probe rather than blanking every picker', async () => {
    // A signed-out CLI or a changed output shape both parse to nothing. Writing
    // that through would erase working model lists on a guess.
    const run = vi.fn(async (command, args) => (args[0] === 'models' ? '' : '1.18.27'));

    const result = await refreshHarnessModels('opencode', { run, ...found });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no models/i);
    expect(providerService.updateProvider).not.toHaveBeenCalled();
  });

  it('refuses a harness that cannot list models, without spawning it', async () => {
    const run = vi.fn(async () => '2.1.259 (Claude Code)');

    const result = await refreshHarnessModels('claude', { run, ...found });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no command for listing/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an uninstalled harness and an unknown id', async () => {
    // The version probe answering `null` is "cannot run this binary".
    const missing = await refreshHarnessModels('opencode', { run: vi.fn(async () => null), ...found });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/not installed/i);

    expect((await refreshHarnessModels('not-a-harness')).ok).toBe(false);
  });
});
