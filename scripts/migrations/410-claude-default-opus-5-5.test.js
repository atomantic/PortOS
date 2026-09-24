/**
 * Test for migration 410 — Claude Code CLI/TUI default + heavy tier move to
 * `claude-opus-5-5`, only on the shipped model list; curated lists keep their
 * pins and Bedrock records are untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './410-claude-default-opus-5-5.js';

const SHIPPED = ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];
const SHIPPED_NEW = ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5'];

const claude = (overrides = {}) => ({
  models: [...SHIPPED],
  defaultModel: 'claude-opus-5',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-5',
  heavyModel: 'claude-opus-5',
  ultraModel: 'claude-fable-5-1',
  ...overrides,
});

describe('migration 410 — Claude Code default Opus 5.5', () => {
  let rootDir;
  const path = () => join(rootDir, 'data/providers.json');
  const write = (providers) => writeFileSync(path(), `${JSON.stringify({ providers }, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(path(), 'utf-8')).providers;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'mig410-'));
    mkdirSync(join(rootDir, 'data'));
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('moves the shipped CLI and TUI records to Opus 5.5 and keeps Opus 5 selectable', async () => {
    write({ 'claude-code': claude(), 'claude-code-tui': claude() });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(2);
    for (const id of ['claude-code', 'claude-code-tui']) {
      const p = read()[id];
      expect(p.models).toEqual(SHIPPED_NEW);
      expect(p.defaultModel).toBe('claude-opus-5-5');
      expect(p.heavyModel).toBe('claude-opus-5-5');
      expect(p.lightModel).toBe('claude-haiku-4-5');
      expect(p.mediumModel).toBe('claude-sonnet-5');
      expect(p.ultraModel).toBe('claude-fable-5-1');
    }
  });

  it('offers Opus 5.5 on a curated list without moving the user\'s pins', async () => {
    write({ 'claude-code': claude({ models: ['claude-sonnet-5', 'claude-opus-5'], defaultModel: 'claude-opus-5' }) });
    await migration.up({ rootDir });
    const p = read()['claude-code'];
    expect(p.models).toEqual(['claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5']);
    expect(p.defaultModel).toBe('claude-opus-5');
    expect(p.heavyModel).toBe('claude-opus-5');
  });

  it('leaves a shipped list whose default the user moved off Opus 5 alone', async () => {
    write({ 'claude-code': claude({ defaultModel: 'claude-sonnet-5' }) });
    await migration.up({ rootDir });
    const p = read()['claude-code'];
    expect(p.defaultModel).toBe('claude-sonnet-5');
    expect(p.heavyModel).toBe('claude-opus-5-5');
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
    write({ 'claude-code': claude({ models: [...SHIPPED_NEW], defaultModel: 'claude-opus-5-5', heavyModel: 'claude-opus-5-5' }) });
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
