import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MODEL_FETCHERS, canRefreshModels, ollamaRefreshGroupKey, resolveModelFetcher, withRefreshCapability, withRefreshCapabilityList } from './modelFetchers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIPPED = JSON.parse(readFileSync(resolve(__dirname, '../../../../data.reference/providers.json'), 'utf8'));

// The shipped ids whose "Refresh Models" button is visible TODAY, transcribed
// from the pre-table `refreshProviderModels` + `_refreshCLIProviderModels`
// chains before they collapsed into MODEL_FETCHERS (#3620). This is the
// regression gate for the refactor: the table may reorganize how a vendor is
// matched, but it must not change WHICH shipped provider can refresh — the
// failure mode is silent in both directions (a button that 404s, or a feature
// that vanishes with no error at all).
const SHIPPED_REFRESHABLE = [
  'antigravity-cli', 'antigravity-tui', 'cerebras', 'claude-code',
  'claude-code-bedrock', 'claude-ollama', 'claude-ollama-tui', 'cursor-cli',
  'cursor-tui', 'grok', 'lmstudio', 'nvidia-kimi', 'ollama', 'opencode-ollama',
  'opencode-ollama-tui',
];
const SHIPPED_NOT_REFRESHABLE = [
  'claude-code-tui', 'claude-code-tui-bedrock', 'codex', 'codex-tui',
  'grok-cli', 'grok-tui', 'kimi-cli', 'kimi-tui',
];

describe('MODEL_FETCHERS — shipped catalog visibility is unchanged', () => {
  it('every shipped provider is classified, and the two lists cover the catalog', () => {
    const ids = Object.keys(SHIPPED.providers).sort();
    expect(ids.length).toBeGreaterThan(20);
    expect([...SHIPPED_REFRESHABLE, ...SHIPPED_NOT_REFRESHABLE].sort()).toEqual(ids);
  });

  it('answers exactly as the pre-table dispatch chains did', () => {
    for (const provider of Object.values(SHIPPED.providers)) {
      expect(
        canRefreshModels(provider),
        `${provider.id}: model-refresh visibility changed`,
      ).toBe(SHIPPED_REFRESHABLE.includes(provider.id));
    }
  });
});

describe('ollamaRefreshGroupKey — one probe per daemon, not one per provider', () => {
  it('collapses every shipped CLI/TUI Ollama provider onto ONE key', () => {
    // The shipped catalog ships four of them (claude-ollama, claude-ollama-tui,
    // opencode-ollama, opencode-ollama-tui) all pointed at the same default
    // daemon — the exact fan-out this key exists to dedup. If a future seed adds
    // a fifth on the same daemon it must land in this same bucket.
    const shared = Object.values(SHIPPED.providers)
      .filter((p) => (p.type === 'cli' || p.type === 'tui') && p.ollamaBacked === true);
    expect(shared.length).toBeGreaterThanOrEqual(4);
    const keys = new Set(shared.map((p) => ollamaRefreshGroupKey(p)));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('tools:http://localhost:11434');
  });

  it('keeps the api-type ollama provider OUT of the tool-filtered bucket', () => {
    // `_refreshAPIProviderModels` persists the unfiltered tag list; the CLI/TUI
    // probe persists a tool-use-only subset. Same daemon, different answers.
    const api = SHIPPED.providers.ollama;
    expect(api.type).toBe('api');
    expect(ollamaRefreshGroupKey(api)).toBe('api:http://localhost:11434/v1');
    expect(ollamaRefreshGroupKey(api)).not.toBe(ollamaRefreshGroupKey(SHIPPED.providers['claude-ollama']));
  });

  it('separates providers on DIFFERENT daemons', () => {
    const local = { id: 'a', type: 'cli', ollamaBacked: true, envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } };
    const remote = { id: 'b', type: 'cli', ollamaBacked: true, envVars: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:11434' } };
    expect(ollamaRefreshGroupKey(local)).not.toBe(ollamaRefreshGroupKey(remote));
  });

  it('normalizes trailing slashes and an OpenAI-compat /v1 to the same daemon key', () => {
    const bare = { id: 'a', type: 'tui', ollamaBacked: true, envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } };
    const suffixed = { id: 'b', type: 'tui', ollamaBacked: true, envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434/v1/' } };
    expect(ollamaRefreshGroupKey(suffixed)).toBe(ollamaRefreshGroupKey(bare));
  });

  it('returns null — never a shared bucket — for anything that is not an Ollama probe', () => {
    // A null key means "refresh me individually". Treating it as a group would
    // persist one vendor's catalog onto every other provider.
    expect(ollamaRefreshGroupKey(null)).toBeNull();
    expect(ollamaRefreshGroupKey({ id: 'anthropic', type: 'api', endpoint: 'https://api.anthropic.com' })).toBeNull();
    expect(ollamaRefreshGroupKey({ id: 'cursor-cli', type: 'cli', command: 'cursor-agent' })).toBeNull();
    expect(ollamaRefreshGroupKey({ id: 'codex-tui', type: 'tui', command: 'codex' })).toBeNull();
    // An api provider with no endpoint at all has nothing to key on.
    expect(ollamaRefreshGroupKey({ id: 'x', type: 'api' })).toBeNull();
  });

  it('never groups two API providers that would attach DIFFERENT keys to the same probe', () => {
    // `_refreshAPIProviderModels` falls through from its `/api/tags`
    // short-circuit to a generic `/models` fetch carrying `provider.apiKey`, so
    // a keyed provider is ungroupable even on an Ollama-shaped endpoint.
    const paid = { id: 'x', type: 'api', endpoint: 'https://api.example.com/v1', apiKey: 'k1' };
    expect(ollamaRefreshGroupKey(paid)).toBeNull();
    const keyed = { id: 'y', type: 'api', endpoint: 'http://localhost:11434/v1', apiKey: 'k2' };
    const alsoKeyed = { id: 'z', type: 'api', endpoint: 'http://localhost:11434/v1', apiKey: 'k3' };
    expect(ollamaRefreshGroupKey(keyed)).toBeNull();
    expect(ollamaRefreshGroupKey(alsoKeyed)).toBeNull();
  });
});

describe('resolveModelFetcher — the ordering the old chains encoded in prose', () => {
  it('routes an Ollama-backed claude CLI to Ollama, not the static Anthropic list', () => {
    // The one load-bearing row order: ollama first.
    const p = { id: 'claude-ollama', type: 'cli', command: 'claude', name: 'Claude Ollama', ollamaBacked: true };
    expect(resolveModelFetcher(p).fetch).toBe('_fetchOllamaToolCapableModels');
  });

  it('lets a command beat a display name — a renamed cursor still reaches cursor-agent', () => {
    // Renaming a cursor provider "Cursor Claude Opus" must not persist
    // Anthropic ids that cursor-agent will reject.
    const p = { id: 'x', type: 'cli', command: 'cursor-agent', name: 'Cursor Claude Opus' };
    expect(resolveModelFetcher(p).fetch).toBe('_fetchCursorModels');
  });

  it('lets an agy command beat a claude name — "Antigravity Claude Sonnet" stays on agy', () => {
    const p = { id: 'x', type: 'cli', command: '/opt/homebrew/bin/agy', name: 'Antigravity Claude Sonnet 4.6' };
    expect(resolveModelFetcher(p).fetch).toBe('_fetchAntigravityModels');
  });

  it('lets a claude command beat an antigravity name — the right answer for a claude binary', () => {
    const p = { id: 'x', type: 'cli', command: 'claude', name: 'Claude via Antigravity' };
    expect(resolveModelFetcher(p).fetch).toBe('_fetchAnthropicModels');
  });

  it('falls through to the display name only when no command claims the provider', () => {
    expect(resolveModelFetcher({ id: 'x', type: 'cli', command: '/usr/bin/weird', name: 'Antigravity Nightly' }).fetch)
      .toBe('_fetchAntigravityModels');
    expect(resolveModelFetcher({ id: 'x', type: 'cli', command: '/usr/bin/weird', name: 'Gemini Preview' }).fetch)
      .toBe('_fetchGeminiModels');
    expect(resolveModelFetcher({ id: 'x', type: 'cli', command: '/opt/homebrew/bin/claude', name: 'Claude Code CLI' }).fetch)
      .toBe('_fetchAnthropicModels');
  });

  it('never lets an ordinary English name claim cursor', () => {
    // "cursor" is a DB cursor / a text cursor — there is deliberately no
    // cliNameMatch column on that row.
    expect(resolveModelFetcher({ id: 'x', type: 'cli', command: 'some-binary', name: 'Cursor Notes' })).toBeNull();
    // A bare `cursor` is the GUI editor launcher, not the agent binary.
    expect(resolveModelFetcher({ id: 'x', type: 'cli', command: 'cursor', name: 'Cursor' })).toBeNull();
  });

  it('returns null for a CLI no vendor claims — the caller throws its own 400', () => {
    for (const command of ['codex', 'kimi', 'grok']) {
      expect(resolveModelFetcher({ id: command, type: 'cli', command, name: `${command} CLI` })).toBeNull();
    }
  });
});

describe('resolveModelFetcher — the TUI arm never consults the display name', () => {
  it('serves the three vendors whose --model applies to the interactive session', () => {
    expect(resolveModelFetcher({ id: 'claude-ollama-tui', type: 'tui', ollamaBacked: true }).fetch)
      .toBe('_fetchOllamaToolCapableModels');
    expect(resolveModelFetcher({ id: 'x', type: 'tui', command: '/opt/bin/agy' }).fetch)
      .toBe('_fetchAntigravityModels');
    expect(resolveModelFetcher({ id: 'x', type: 'tui', command: 'cursor-agent' }).fetch)
      .toBe('_fetchCursorModels');
  });

  it('admits a shipped TUI id repointed at a wrapper script', () => {
    // An EXACT shipped-id match, never a name substring: it can only admit the
    // provider PortOS itself seeds, and probing the user's wrapper is right.
    expect(resolveModelFetcher({ id: 'cursor-tui', type: 'tui', command: '/opt/bin/cursor-wrap' }).fetch)
      .toBe('_fetchCursorModels');
    expect(resolveModelFetcher({ id: 'antigravity-tui', type: 'tui', command: '/opt/bin/agy-wrap' }).fetch)
      .toBe('_fetchAntigravityModels');
    expect(resolveModelFetcher({ id: 'custom-tui', type: 'tui', command: '/opt/bin/cursor-wrap' })).toBeNull();
  });

  it('ignores a vendor name on a TUI — the asymmetry with the CLI arm is deliberate', () => {
    expect(resolveModelFetcher({ id: 'x', type: 'tui', command: '/usr/bin/weird', name: 'Antigravity Nightly' })).toBeNull();
    expect(resolveModelFetcher({ id: 'x', type: 'tui', command: 'claude', name: 'Claude Code TUI' })).toBeNull();
  });
});

describe('canRefreshModels', () => {
  it('is true for every API provider — they route to the generic fetcher', () => {
    expect(canRefreshModels({ id: 'cerebras', type: 'api', name: 'Cerebras' })).toBe(true);
    expect(canRefreshModels({ id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1' })).toBe(true);
  });

  it('is false for a nullish provider and for an unknown type', () => {
    expect(canRefreshModels(null)).toBe(false);
    expect(canRefreshModels(undefined)).toBe(false);
    expect(canRefreshModels({ id: 'x', type: 'mystery', command: 'claude', name: 'Claude' })).toBe(false);
  });
});

describe('withRefreshCapability', () => {
  it('returns a copy — the caller\'s (possibly cached, about-to-be-saved) record is untouched', () => {
    const provider = { id: 'codex', type: 'cli', command: 'codex', name: 'Codex CLI' };
    const decorated = withRefreshCapability(provider);
    expect(decorated).not.toBe(provider);
    expect(decorated.canRefreshModels).toBe(false);
    expect(provider.canRefreshModels).toBeUndefined();
  });

  it('passes a nullish provider straight through (GET /active with none set)', () => {
    expect(withRefreshCapability(null)).toBeNull();
    expect(withRefreshCapabilityList(undefined)).toBeUndefined();
  });

  it('decorates every entry of a list', () => {
    const list = withRefreshCapabilityList([
      { id: 'a', type: 'api' },
      { id: 'b', type: 'cli', command: 'codex', name: 'Codex' },
    ]);
    expect(list.map((p) => p.canRefreshModels)).toEqual([true, false]);
  });
});

describe('adding a vendor is exactly ONE table row', () => {
  // Drives the TABLE, not the chain: the whole point of #3620 is that a new
  // vendor cannot half-land (server CLI arm but not TUI arm, or server but not
  // client). Injecting a single row must light up every arm at once.
  const acmeRow = {
    key: 'acme',
    cliMatch: (p) => p?.command === 'acme-agent',
    cliNameMatch: (p) => String(p?.name || '').toLowerCase().includes('acme'),
    tuiMatch: (p) => p?.id === 'acme-tui' || p?.command === 'acme-agent',
    fetch: '_fetchAcmeModels',
  };
  const withAcme = [...MODEL_FETCHERS, acmeRow];
  const acmeCli = { id: 'acme-cli', type: 'cli', command: 'acme-agent', name: 'Acme CLI' };
  const acmeTui = { id: 'acme-tui', type: 'tui', command: '/opt/bin/acme-wrap', name: 'Acme TUI' };

  it('is invisible to every arm before the row exists', () => {
    expect(canRefreshModels(acmeCli)).toBe(false);
    expect(canRefreshModels(acmeTui)).toBe(false);
    expect(resolveModelFetcher(acmeCli)).toBeNull();
  });

  it('lights up the CLI arm, the TUI arm, and the payload flag from that one row', () => {
    expect(resolveModelFetcher(acmeCli, withAcme).fetch).toBe('_fetchAcmeModels');
    expect(resolveModelFetcher(acmeTui, withAcme).fetch).toBe('_fetchAcmeModels');
    expect(canRefreshModels(acmeCli, withAcme)).toBe(true);
    expect(canRefreshModels(acmeTui, withAcme)).toBe(true);
    // …and its display-name column works without touching any other vendor.
    expect(resolveModelFetcher({ id: 'x', type: 'cli', command: '/usr/bin/weird', name: 'Acme Nightly' }, withAcme).fetch)
      .toBe('_fetchAcmeModels');
  });

  it('leaves every shipped provider\'s answer untouched', () => {
    for (const provider of Object.values(SHIPPED.providers)) {
      expect(canRefreshModels(provider, withAcme)).toBe(canRefreshModels(provider));
    }
  });
});

describe('MODEL_FETCHERS shape', () => {
  it('every row names a fetcher method and carries at least one match column', () => {
    for (const row of MODEL_FETCHERS) {
      expect(typeof row.key, 'row is missing a key').toBe('string');
      expect(typeof row.fetch, `${row.key}: fetch must be a method NAME (string)`).toBe('string');
      expect(
        Boolean(row.cliMatch || row.cliNameMatch || row.tuiMatch),
        `${row.key}: a row that matches nothing is dead weight`,
      ).toBe(true);
    }
  });

  it('has unique keys', () => {
    const keys = MODEL_FETCHERS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every `fetch` names a real method on the provider service', async () => {
    // The table holds method NAMES so it can stay a pure data module; that
    // indirection would otherwise fail only at refresh time, as a TypeError
    // surfaced to the user as a 502.
    const { createProviderService } = await import('../providers.js');
    const service = createProviderService({ dataDir: './data' });
    for (const row of MODEL_FETCHERS) {
      expect(typeof service[row.fetch], `${row.key}: no such method ${row.fetch}`).toBe('function');
    }
  });
});
