import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './292-mtplx-served-model.js';

const NEW_MODEL = 'mtplx-qwen38-27b-optimized-speed';
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 292 — MTPLX served model', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-292-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('updates untouched API and TUI sentinels together', async () => {
    writeJson(providersPath, {
      providers: {
        mtplx: { models: ['mtplx'], defaultModel: 'mtplx' },
        'opencode-mtplx': { models: ['mtplx'], defaultModel: 'mtplx' },
        'opencode-mtplx-tui': { models: ['mtplx'], defaultModel: 'mtplx' },
      },
    });

    const result = await migration.up({ rootDir });
    const providers = readJson(providersPath).providers;

    expect(result.updated).toBe(3);
    expect(providers.mtplx).toMatchObject({ models: [NEW_MODEL], defaultModel: NEW_MODEL });
    expect(providers['opencode-mtplx-tui']).toMatchObject({ models: [NEW_MODEL], defaultModel: NEW_MODEL });
  });

  it('preserves a customized checkpoint selection', async () => {
    writeJson(providersPath, {
      providers: {
        mtplx: { models: ['custom-checkpoint'], defaultModel: 'custom-checkpoint' },
        'opencode-mtplx-tui': { models: ['mtplx', 'custom-checkpoint'], defaultModel: 'custom-checkpoint' },
      },
    });

    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(readJson(providersPath).providers).toEqual(expect.objectContaining({
      mtplx: { models: ['custom-checkpoint'], defaultModel: 'custom-checkpoint' },
      'opencode-mtplx-tui': { models: ['mtplx', 'custom-checkpoint'], defaultModel: 'custom-checkpoint' },
    }));
  });
});
