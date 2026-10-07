/**
 * Test for migration 424 — add Claude Haiku 5.5 to Claude Code providers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './424-claude-haiku-5-5.js';

const claude = (overrides = {}) => ({
  models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5'],
  lightModel: 'claude-haiku-4-5-20251001',
  ...overrides,
});

describe('migration 424 — Claude Haiku 5.5', () => {
  let rootDir;
  const path = () => join(rootDir, 'data/providers.json');
  const write = (providers) => writeFileSync(path(), `${JSON.stringify({ providers }, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(path(), 'utf-8')).providers;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'mig424-'));
    mkdirSync(join(rootDir, 'data'));
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('inserts Haiku 5.5 after Sonnet 5.5 and moves the shipped light model, idempotently', async () => {
    write({ 'claude-code': claude(), 'claude-code-tui': claude() });
    expect((await migration.up({ rootDir })).updated).toBe(2);
    const p = read()['claude-code'];
    expect(p.models.slice(2, 4)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(p.lightModel).toBe('claude-haiku-5-5');
    expect((await migration.up({ rootDir })).reason).toBe('already-current');
  });

  it('keeps a user-pinned light model', async () => {
    write({ 'claude-code': claude({ lightModel: 'claude-sonnet-5' }) });
    await migration.up({ rootDir });
    expect(read()['claude-code'].lightModel).toBe('claude-sonnet-5');
  });
});
