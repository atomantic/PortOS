import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './464-antigravity-neon-tiers.js';

const SENTINEL = 'antigravity-configured-default';
const NEON_CATALOG = [
  SENTINEL,
  'gemini-4-neon-high',
  'gemini-4-neon-xhigh',
  'gemini-4-neon-medium',
  'gemini-4-neon-low',
  'gemini-4-argon-medium',
  'gemini-3.8-flash-medium',
];

let rootDir;
afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

describe('464-antigravity-neon-tiers', () => {
  it('upgrades sentinel tier pins and populates ultraModel on refreshed Antigravity presets without overwriting custom pins', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-agy-neon-'));
    await mkdir(join(rootDir, 'data'));
    const path = join(rootDir, 'data/providers.json');

    const providers = {
      'antigravity-cli': {
        id: 'antigravity-cli',
        models: [...NEON_CATALOG],
        defaultModel: 'gemini-4-neon-medium',
        lightModel: SENTINEL,
        mediumModel: SENTINEL,
        heavyModel: SENTINEL,
      },
      'antigravity-tui': {
        id: 'antigravity-tui',
        models: [...NEON_CATALOG],
        defaultModel: SENTINEL,
        lightModel: 'gemini-4-argon-medium',
        mediumModel: SENTINEL,
        heavyModel: 'claude-opus-5-5-high',
        ultraModel: null,
      },
      codex: {
        id: 'codex',
        models: ['gpt-5.6-terra'],
        defaultModel: 'gpt-5.6-terra',
      },
    };
    await writeFile(path, JSON.stringify({ activeProvider: 'antigravity-cli', providers }));

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, reason: 'updated', updated: 2 });
    const updated = JSON.parse(await readFile(path, 'utf8'));

    expect(updated.providers['antigravity-cli']).toMatchObject({
      models: NEON_CATALOG,
      defaultModel: 'gemini-4-neon-medium',
      lightModel: 'gemini-3.8-flash-medium',
      mediumModel: 'gemini-4-neon-medium',
      heavyModel: 'gemini-4-neon-high',
      ultraModel: 'gemini-4-neon-xhigh',
    });
    expect(updated.providers['antigravity-tui']).toMatchObject({
      models: NEON_CATALOG,
      defaultModel: 'gemini-4-neon-medium',
      lightModel: 'gemini-4-argon-medium',
      mediumModel: 'gemini-4-neon-medium',
      heavyModel: 'claude-opus-5-5-high',
      ultraModel: 'gemini-4-neon-xhigh',
    });
    expect(updated.providers.codex).toEqual(providers.codex);

    // Second run is an idempotent no-op.
    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, reason: 'already-current', updated: 0 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated);
  });

  it('preserves a customized ultraModel and skips tiers whose target model is absent from the catalog', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-agy-neon-'));
    await mkdir(join(rootDir, 'data'));
    const path = join(rootDir, 'data/providers.json');

    const providers = {
      'antigravity-cli': {
        id: 'antigravity-cli',
        models: [SENTINEL, 'gemini-4-argon-medium', 'gemini-3.8-flash-medium'],
        defaultModel: SENTINEL,
        lightModel: SENTINEL,
        mediumModel: SENTINEL,
        heavyModel: SENTINEL,
        ultraModel: 'gemini-4-argon-medium',
      },
    };
    await writeFile(path, JSON.stringify({ activeProvider: 'antigravity-cli', providers }));

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, reason: 'updated', updated: 1 });
    const updated = JSON.parse(await readFile(path, 'utf8'));
    expect(updated.providers['antigravity-cli']).toMatchObject({
      defaultModel: SENTINEL,
      lightModel: 'gemini-3.8-flash-medium',
      mediumModel: SENTINEL,
      heavyModel: SENTINEL,
      ultraModel: 'gemini-4-argon-medium',
    });
  });

  it('handles missing, corrupt, and bad-shape provider files safely', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-agy-neon-'));
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'no-file', updated: 0 });

    await mkdir(join(rootDir, 'data'));
    const path = join(rootDir, 'data/providers.json');
    await writeFile(path, '{bad json');
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'unreadable', updated: 0 });
    expect(await readFile(path, 'utf8')).toBe('{bad json');

    await writeFile(path, JSON.stringify({ activeProvider: null }));
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'bad-shape', updated: 0 });
  });
});
