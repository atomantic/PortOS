/**
 * Test for migration 460 — add Claude Fable 5.2 to Claude Code providers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './460-claude-fable-5-2.js';

const claude = (overrides = {}) => ({
  models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  ultraModel: 'claude-fable-5-1',
  ...overrides,
});

describe('migration 460 — Claude Fable 5.2', () => {
  let rootDir;
  const path = () => join(rootDir, 'data/providers.json');
  const write = (providers) => writeFileSync(path(), `${JSON.stringify({ providers }, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(path(), 'utf-8')).providers;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'mig460-'));
    mkdirSync(join(rootDir, 'data'));
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('inserts Fable 5.2 ahead of 5.1 and moves the shipped ultra model, idempotently', async () => {
    write({ 'claude-code': claude(), 'claude-code-tui': claude() });
    expect((await migration.up({ rootDir })).updated).toBe(2);
    const p = read()['claude-code'];
    expect(p.models.slice(0, 3)).toEqual(['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1']);
    expect(p.ultraModel).toBe('claude-fable-5-2');
    expect((await migration.up({ rootDir })).reason).toBe('already-current');
  });

  it('keeps a user-pinned ultra model and falls back to after Opus 5.5 when 5.1 is absent', async () => {
    write({ 'claude-code': claude({ models: ['claude-opus-5-5', 'claude-sonnet-5-5'], ultraModel: 'claude-opus-5-5' }) });
    await migration.up({ rootDir });
    const p = read()['claude-code'];
    expect(p.models).toEqual(['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5']);
    expect(p.ultraModel).toBe('claude-opus-5-5');
  });
});
