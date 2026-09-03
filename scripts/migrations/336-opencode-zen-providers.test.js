import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './336-opencode-zen-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 336 — OpenCode Zen providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-336-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds the three disabled presets without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers['opencode-zen']).toMatchObject({
      type: 'api',
      endpoint: 'https://opencode.ai/zen/v1',
      apiKey: '',
      enabled: false,
    });
    expect(out.providers['opencode-zen-cli']).toMatchObject({ type: 'cli', command: 'opencode', enabled: false });
    expect(out.providers['opencode-zen-tui']).toMatchObject({ type: 'tui', command: 'opencode', enabled: false });
    expect(out.activeProvider).toBe('claude-code');
  });

  it('carries no backend marker, so the harness catalog owns these records', async () => {
    // The absence is load-bearing: a `*Backed` / `gatewayBacked` marker would
    // make OpenCode declare a custom provider entry and would exclude the
    // record from the Harnesses page's model refresh.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of ['opencode-zen-cli', 'opencode-zen-tui']) {
      const record = out.providers[id];
      expect(record.gatewayBacked).toBeUndefined();
      expect(record.ollamaBacked).toBeUndefined();
      expect(record.orcarouterBacked).toBeUndefined();
      // No `endpoint` either: these declare no OpenCode provider entry, so
      // nothing would read one — matching every other harness-native record.
      expect(record.endpoint).toBeUndefined();
      // The only thing the config declares is the unattended posture — no
      // provider entry, no key.
      expect(JSON.parse(record.envVars.OPENCODE_CONFIG_CONTENT)).toEqual({ permission: 'allow' });
    }
  });

  it('stores CLI models namespaced and API models bare', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    // Nothing prefixes the id at spawn time for a namespace-less record, so the
    // stored spelling has to be the one `opencode --model` accepts.
    for (const id of out.providers['opencode-zen-cli'].models) expect(id.startsWith('opencode/')).toBe(true);
    expect(out.providers['opencode-zen-cli'].defaultModel).toBe('opencode/big-pickle');
    // The HTTP endpoint has no namespace on the wire.
    for (const id of out.providers['opencode-zen'].models) expect(id).not.toContain('/');
    expect(out.providers['opencode-zen'].models).toContain(out.providers['opencode-zen'].defaultModel);
  });

  it('preserves an existing OpenCode Zen record and its key', async () => {
    const existing = { id: 'opencode-zen', name: 'My Zen', type: 'api', apiKey: 'sk-zen-example', enabled: true };
    writeJson(providersPath, { providers: { 'opencode-zen': existing } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers['opencode-zen']).toEqual(existing);
  });

  it('is a no-op on re-run', async () => {
    writeJson(providersPath, { activeProvider: 'claude-code', providers: {} });

    await migration.up({ rootDir });
    const first = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(first);
  });
});
