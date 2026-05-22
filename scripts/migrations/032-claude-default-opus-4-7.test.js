/**
 * Test for migration 032 — flip Claude CLI/TUI providers to the current
 * undated trio with `claude-opus-4-7` as defaultModel. Picked up by
 * server/vitest.config.js's `../scripts/migrations/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './032-claude-default-opus-4-7.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const NEW_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];

const dataSampleLegacy = (overrides = {}) => ({
  id: 'claude-code',
  models: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6',
  ],
  defaultModel: 'claude-opus-4-6',
  lightModel: 'claude-haiku-4-5-20251001',
  mediumModel: 'claude-sonnet-4-5-20250929',
  heavyModel: 'claude-opus-4-6',
  ...overrides,
});

const scaffoldLegacy = (overrides = {}) => ({
  id: 'claude-code',
  models: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
  ],
  defaultModel: 'claude-sonnet-4-5-20250929',
  lightModel: 'claude-haiku-4-5-20251001',
  mediumModel: 'claude-sonnet-4-5-20250929',
  heavyModel: 'claude-opus-4-5-20251101',
  ...overrides,
});

const aiToolkitSeeded = (overrides = {}) => ({
  id: 'claude-code',
  models: [...NEW_MODELS],
  defaultModel: 'claude-sonnet-4-6',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-4-6',
  heavyModel: 'claude-opus-4-7',
  ...overrides,
});

describe('migration 032 — Claude CLI/TUI default to opus-4-7', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-032-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('upgrades the data.sample 4-item legacy shape to the new trio + opus-4-7 default', async () => {
    writeJson(providersPath, { providers: { 'claude-code': dataSampleLegacy() } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-opus-4-7');
    expect(after.lightModel).toBe('claude-haiku-4-5');
    expect(after.mediumModel).toBe('claude-sonnet-4-6');
    expect(after.heavyModel).toBe('claude-opus-4-7');
  });

  it('upgrades the scaffold-route 3-item legacy shape to the new trio + opus-4-7 default', async () => {
    writeJson(providersPath, { providers: { 'claude-code-tui': scaffoldLegacy({ id: 'claude-code-tui' }) } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code-tui'];
    expect(after.models).toEqual(NEW_MODELS);
    // Scaffold-seeded default (claude-sonnet-4-5-20250929) → policy default opus-4-7
    expect(after.defaultModel).toBe('claude-opus-4-7');
    expect(after.lightModel).toBe('claude-haiku-4-5');
    expect(after.mediumModel).toBe('claude-sonnet-4-6');
    expect(after.heavyModel).toBe('claude-opus-4-7');
  });

  it('upgrades the aiToolkit-seeded shape (new-trio models, stale sonnet-4-6 default) → opus-4-7 default', async () => {
    writeJson(providersPath, { providers: { 'claude-code': aiToolkitSeeded() } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-opus-4-7');
    // Tier pointers were already current; nothing else changes.
    expect(after.lightModel).toBe('claude-haiku-4-5');
    expect(after.mediumModel).toBe('claude-sonnet-4-6');
    expect(after.heavyModel).toBe('claude-opus-4-7');
  });

  it('is a no-op when models AND defaultModel are already opus-4-7', async () => {
    const current = {
      id: 'claude-code',
      models: [...NEW_MODELS],
      defaultModel: 'claude-opus-4-7',
      lightModel: 'claude-haiku-4-5',
      mediumModel: 'claude-sonnet-4-6',
      heavyModel: 'claude-opus-4-7',
    };
    const before = JSON.stringify({ providers: { 'claude-code': current } });
    writeJson(providersPath, JSON.parse(before));

    await migration.up({ rootDir });

    expect(readJson(providersPath)).toEqual(JSON.parse(before));
  });

  it('skips a customized models list (user dropped sonnet, etc.)', async () => {
    const customized = {
      id: 'claude-code',
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'],
      defaultModel: 'claude-sonnet-4-5-20250929',
    };
    const before = JSON.stringify({ providers: { 'claude-code': customized } });
    writeJson(providersPath, JSON.parse(before));

    await migration.up({ rootDir });

    // No write should have happened — file content stays byte-for-byte (modulo whitespace).
    expect(readJson(providersPath)).toEqual(JSON.parse(before));
  });

  it('treats reordered legacy lists as customization (skip)', async () => {
    const reordered = {
      id: 'claude-code',
      models: ['claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101'],
      defaultModel: 'claude-opus-4-6',
    };
    const before = JSON.stringify({ providers: { 'claude-code': reordered } });
    writeJson(providersPath, JSON.parse(before));

    await migration.up({ rootDir });

    expect(readJson(providersPath)).toEqual(JSON.parse(before));
  });

  it('preserves a user-pin to a still-current model (claude-sonnet-4-6) with a non-aiToolkit fingerprint', async () => {
    // Models already current, but tier pointers don't match the aiToolkit
    // fingerprint — e.g. a user hand-picked sonnet-4-6 with a custom medium tier.
    const userPinned = {
      id: 'claude-code',
      models: [...NEW_MODELS],
      defaultModel: 'claude-sonnet-4-6',
      lightModel: 'claude-haiku-4-5',
      mediumModel: 'claude-opus-4-7', // not the aiToolkit fingerprint (would be sonnet-4-6)
      heavyModel: 'claude-opus-4-7',
    };
    const before = JSON.stringify({ providers: { 'claude-code': userPinned } });
    writeJson(providersPath, JSON.parse(before));

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.defaultModel).toBe('claude-sonnet-4-6');
    expect(after.mediumModel).toBe('claude-opus-4-7');
  });

  it('preserves user-pin to claude-sonnet-4-6 when models still match the legacy 4-item shape', async () => {
    // Legacy models list + user-pin to a still-current default. The migration
    // rewrites models, but defaultModel is preserved because it's not in the
    // retired-id map and not a seeded default.
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ defaultModel: 'claude-sonnet-4-6' }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-sonnet-4-6'); // user pin survives
    expect(after.lightModel).toBe('claude-haiku-4-5');
    expect(after.heavyModel).toBe('claude-opus-4-7');
  });

  it('preserves a user-pinned retired haiku as defaultModel via per-model successor (tier intent kept)', async () => {
    // User actively pinned haiku-dated as their default — not a seeded
    // default — so it follows the per-model successor: stays small/fast.
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ defaultModel: 'claude-haiku-4-5-20251001' }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-haiku-4-5');
  });

  it('upgrades a user-pinned retired opus-4-5 as defaultModel via per-model successor (no orphan)', async () => {
    // Retired but not a seeded default → per-model successor (opus-4-7).
    // Ensures no orphan pointer (model id absent from provider.models).
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ defaultModel: 'claude-opus-4-5-20251101' }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-opus-4-7');
    expect(after.models).toContain(after.defaultModel);
  });

  it('handles missing claude-code / claude-code-tui (skip silently, no write)', async () => {
    const before = JSON.stringify({ providers: { 'codex': { id: 'codex', models: [] } } });
    writeJson(providersPath, JSON.parse(before));

    await migration.up({ rootDir });

    expect(readJson(providersPath)).toEqual(JSON.parse(before));
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });

    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON (logs a warning and skips)', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('does not modify the file when providers map is absent (logs a warning and skips)', async () => {
    const before = JSON.stringify({ activeProvider: 'claude-code' });
    writeJson(providersPath, JSON.parse(before));

    await migration.up({ rootDir });

    expect(readJson(providersPath)).toEqual(JSON.parse(before));
  });

  it('processes claude-code and claude-code-tui together in one pass', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy(),
        'claude-code-tui': scaffoldLegacy({ id: 'claude-code-tui' }),
        'codex': { id: 'codex', models: ['codex-configured-default'] }, // untouched
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out['claude-code'].defaultModel).toBe('claude-opus-4-7');
    expect(out['claude-code-tui'].defaultModel).toBe('claude-opus-4-7');
    expect(out['codex'].models).toEqual(['codex-configured-default']);
  });
});
