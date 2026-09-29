/**
 * Test for migration 419 — Claude Code CLI/TUI model list refresh.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { SHIPPED_NEW, SHIPPED_PREVIOUS } from './419-claude-model-catalog-refresh.js';

const claude = (overrides = {}) => ({
  models: [...SHIPPED_PREVIOUS[0]],
  defaultModel: 'claude-opus-5-5',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-5',
  heavyModel: 'claude-opus-5-5',
  ultraModel: 'claude-fable-5-1',
  ...overrides,
});

describe('migration 419 — Claude model catalog refresh', () => {
  let rootDir;
  const path = () => join(rootDir, 'data/providers.json');
  const write = (providers) => writeFileSync(path(), `${JSON.stringify({ providers }, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(path(), 'utf-8')).providers;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'mig419-'));
    mkdirSync(join(rootDir, 'data'));
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('moves previously shipped CLI and TUI records to the refreshed 11-model catalog', async () => {
    write({ 'claude-code': claude(), 'claude-code-tui': claude() });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);
    for (const id of ['claude-code', 'claude-code-tui']) {
      const p = read()[id];
      expect(p.models).toEqual(SHIPPED_NEW);
      expect(p.lightModel).toBe('claude-haiku-4-5-20251001');
      expect(p.defaultModel).toBe('claude-opus-5-5');
      expect(p.heavyModel).toBe('claude-opus-5-5');
      expect(p.mediumModel).toBe('claude-sonnet-5');
      expect(p.ultraModel).toBe('claude-fable-5-1');
    }
  });

  it('moves pre-410 shipped lists to the refreshed catalog', async () => {
    write({ 'claude-code': claude({ models: [...SHIPPED_PREVIOUS[1]] }) });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(read()['claude-code'].models).toEqual(SHIPPED_NEW);
  });

  it('offers claude-sonnet-5-5 on a curated list without moving the user\'s pins', async () => {
    write({
      'claude-code': claude({
        models: ['claude-sonnet-5', 'claude-opus-5-5'],
        defaultModel: 'claude-sonnet-5',
        lightModel: 'custom-light',
      }),
    });
    await migration.up({ rootDir });
    const p = read()['claude-code'];
    expect(p.models).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5']);
    expect(p.defaultModel).toBe('claude-sonnet-5');
    expect(p.lightModel).toBe('custom-light');
  });

  it('does not touch Bedrock records', async () => {
    const bedrock = {
      models: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-5', 'global.anthropic.claude-opus-5[1m]'],
      defaultModel: 'global.anthropic.claude-opus-5[1m]',
      heavyModel: 'global.anthropic.claude-opus-5[1m]',
    };
    write({ 'claude-code-bedrock': bedrock });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-current');
    expect(read()['claude-code-bedrock']).toEqual(bedrock);
  });

  it('is idempotent and a no-op on a fresh seed', async () => {
    write({ 'claude-code': claude({ models: [...SHIPPED_NEW], lightModel: 'claude-haiku-4-5-20251001' }) });
    const before = readFileSync(path(), 'utf-8');
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-current');
    expect(readFileSync(path(), 'utf-8')).toBe(before);
  });

  it('skips cleanly when providers.json is absent', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: false, reason: 'no-file' });
  });
});
