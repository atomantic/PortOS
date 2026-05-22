/**
 * Test for migration 032 — flip Claude CLI/TUI providers to the current
 * undated trio with `claude-opus-4-7` as defaultModel. Picked up by
 * server/vitest.config.js's `../scripts/**\/*.test.js` glob.
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
    writeJson(providersPath, { providers: { 'claude-code': current } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('skips a customized models list (user dropped sonnet, etc.)', async () => {
    const customized = {
      id: 'claude-code',
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'],
      defaultModel: 'claude-sonnet-4-5-20250929',
    };
    writeJson(providersPath, { providers: { 'claude-code': customized } });
    // Capture the on-disk bytes (after writeJson's pretty-print + trailing \n)
    // so we can assert no write happened — stronger than a parsed-JSON compare,
    // which would let an accidental reformat slip through.
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('treats reordered legacy lists as customization (skip)', async () => {
    const reordered = {
      id: 'claude-code',
      models: ['claude-opus-4-6', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101'],
      defaultModel: 'claude-opus-4-6',
    };
    writeJson(providersPath, { providers: { 'claude-code': reordered } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
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

  it('resets an orphan defaultModel (custom id not in any map) to the per-tier fallback (opus-4-7)', async () => {
    // User pinned a hand-typed / future / foreign id as defaultModel while
    // leaving the legacy models list intact. The pointer isn't a retired id,
    // isn't a seeded default, isn't in the new trio — without the orphan
    // safety net it would be left dangling. defaultModel's tier fallback is
    // opus-4-7 (POLICY_DEFAULT).
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ defaultModel: 'claude-some-future-model' }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-opus-4-7');
    expect(after.models).toContain(after.defaultModel);
  });

  it('resets an orphan tier pointer (lightModel pinned to a foreign id) to the per-tier fallback (haiku)', async () => {
    // Orphan tier pointers reset to their per-tier fallback so the slot's
    // intent is preserved — a "light" slot stays small/fast as haiku-4-5
    // rather than collapsing to opus-4-7.
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ lightModel: 'gpt-4o-mini' }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toContain(after.lightModel);
    expect(after.lightModel).toBe('claude-haiku-4-5');
  });

  it('resets an orphan mediumModel pointer to the per-tier fallback (sonnet-4-6)', async () => {
    // Symmetric coverage for the medium-tier branch of TIER_FALLBACK.
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ mediumModel: 'gpt-4o' }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toContain(after.mediumModel);
    expect(after.mediumModel).toBe('claude-sonnet-4-6');
  });

  it('resets a null defaultModel to the per-tier fallback (opus-4-7)', async () => {
    // null defaultModel would render as an empty UI selection and break
    // server callers that read provider.defaultModel — same broken state
    // as a foreign-id orphan, so the safety net treats it identically.
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ defaultModel: null }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.defaultModel).toBe('claude-opus-4-7');
    expect(after.models).toContain(after.defaultModel);
  });

  it('resets an empty-string lightModel to the per-tier fallback (haiku-4-5)', async () => {
    // Same broken-state class as null/foreign — empty string renders as
    // nothing in dropdowns.
    writeJson(providersPath, {
      providers: {
        'claude-code': dataSampleLegacy({ lightModel: '' }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.lightModel).toBe('claude-haiku-4-5');
    expect(after.models).toContain(after.lightModel);
  });

  it('fixes orphan defaultModel even when models are already the new trio', async () => {
    // models = NEW_MODELS but defaultModel still pinned to a retired id —
    // not the aiToolkit fingerprint (which requires sonnet-4-6), so the
    // previous code would have skipped this provider as "already current"
    // and left the orphan in place. The orphan-safety branch now runs in
    // both the legacy-rewrite and already-current paths.
    writeJson(providersPath, {
      providers: {
        'claude-code': {
          id: 'claude-code',
          models: [...NEW_MODELS],
          defaultModel: 'claude-opus-4-6', // retired, not in NEW_MODELS
          lightModel: 'claude-haiku-4-5',
          mediumModel: 'claude-sonnet-4-6',
          heavyModel: 'claude-opus-4-7',
        },
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.defaultModel).toBe('claude-opus-4-7');
    expect(after.models).toContain(after.defaultModel);
  });

  it('fixes orphan tier pointer on a current-models provider', async () => {
    // models = NEW_MODELS but heavyModel pinned to a foreign id. The
    // already-current branch now invokes the same orphan-safety net.
    writeJson(providersPath, {
      providers: {
        'claude-code': {
          id: 'claude-code',
          models: [...NEW_MODELS],
          defaultModel: 'claude-opus-4-7',
          lightModel: 'claude-haiku-4-5',
          mediumModel: 'claude-sonnet-4-6',
          heavyModel: 'gpt-4o',
        },
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.heavyModel).toBe('claude-opus-4-7');
    expect(after.models).toContain(after.heavyModel);
  });

  it('resets a missing (undefined) heavyModel to the per-tier fallback (opus-4-7)', async () => {
    // Provider had a legacy 4-item models list but the user actively
    // removed the heavyModel pointer — leaving the key undefined after
    // the JSON roundtrip. The safety net coerces it to opus-4-7 so the
    // provider has a usable heavy tier after the rewrite.
    const legacy = dataSampleLegacy();
    delete legacy.heavyModel;
    writeJson(providersPath, { providers: { 'claude-code': legacy } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.heavyModel).toBe('claude-opus-4-7');
    expect(after.models).toContain(after.heavyModel);
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
    writeJson(providersPath, { providers: { 'codex': { id: 'codex', models: [] } } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
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
    writeJson(providersPath, { activeProvider: 'claude-code' });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
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
