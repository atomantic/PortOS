/**
 * Test for migration 340 — add the Slotstream provider preset to existing
 * installs. The shared idempotent write shell is asserted in _lib.test.js;
 * this test pins migration 340's frozen payload and its disabled-by-default,
 * text-only contract (no CLI/TUI variant — see migration 272 for why MTPLX
 * gets one and Slotstream does not).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './340-slotstream-provider.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 340 — Slotstream provider', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-340-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds a disabled API preset without touching existing state', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const api = out.providers.slotstream;

    expect(api).toMatchObject({
      id: 'slotstream',
      type: 'api',
      endpoint: 'http://127.0.0.1:5564/v1',
      models: ['qwen3-235b-a22b-4bit', 'gpt-oss-120b-mxfp4', 'qwen3-30b-a3b-4bit'],
      defaultModel: 'qwen3-235b-a22b-4bit',
      enabled: false,
    });

    // Text-only: no opencode-slotstream CLI/TUI wrapper, unlike MTPLX.
    expect(out.providers['opencode-slotstream']).toBeUndefined();
    expect(out.providers['opencode-slotstream-tui']).toBeUndefined();

    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('preserves an existing Slotstream provider instead of replacing its local edits', async () => {
    const existing = {
      id: 'slotstream', name: 'My Slotstream', type: 'api', endpoint: 'http://127.0.0.1:5564/v1', enabled: true,
    };
    writeJson(providersPath, { providers: { slotstream: existing } });

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers.slotstream).toEqual(existing);
  });
});
