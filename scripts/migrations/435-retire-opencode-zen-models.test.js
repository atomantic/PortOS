import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './435-retire-opencode-zen-models.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 435 — retire OpenCode Zen model ids the CLI no longer lists', () => {
  let rootDir;
  let providersPath;
  let jobsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-435-opencode-'));
    mkdirSync(join(rootDir, 'data/cos'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
    jobsPath = join(rootDir, 'data/cos/autonomous-jobs.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('rewrites provider lists and pointers, and job model overrides, then is a no-op', async () => {
    const shipped = [
      'opencode/big-pickle', 'opencode/ling-3.0-flash-fin-free', 'opencode/mimo-v2.5-free',
      'opencode/muse-spark-1.2-contributor-free', 'opencode/muse-spark-1.3-contributor-free',
      'opencode/nemotron-3-ultra-free', 'opencode/nemotron-3.5-lightning-free',
    ];
    writeJson(providersPath, {
      activeProvider: 'opencode-zen-cli',
      providers: {
        'opencode-zen-cli': { id: 'opencode-zen-cli', models: shipped, defaultModel: 'opencode/muse-spark-1.3-contributor-free', heavyModel: 'opencode/space-bunny-free' },
        // Curated list that already holds a replacement: deduped, user entries kept.
        'opencode-zen-tui': { id: 'opencode-zen-tui', models: ['opencode/mimo-v2.5-free', 'opencode/mimo-v2.6-flash-free', 'opencode/custom'], defaultModel: 'opencode/custom' },
        'opencode-zen': { id: 'opencode-zen', models: ['opencode/mimo-v2.5-free'] },
      },
    });
    writeJson(jobsPath, {
      version: 1,
      jobs: [
        { id: 'job-a', providerId: 'opencode-zen-tui', model: 'opencode/muse-spark-1.2-contributor-free' },
        { id: 'job-c', providerId: 'opencode-zen', model: 'opencode/mimo-v2.5-free' },
        { id: 'job-b', providerId: 'opencode-zen-tui', model: 'opencode/big-pickle' },
      ],
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, providers: ['opencode-zen-cli', 'opencode-zen-tui'], jobs: ['job-a'] });

    const { providers } = readJson(providersPath);
    expect(providers['opencode-zen-cli'].models).toEqual([
      'opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free', 'opencode/mimo-v2.6-flash-free',
      'opencode/glm-5.3-flash-free', 'opencode/minimax-m3.1-flash-free',
      'opencode/nemotron-3-ultra-free', 'opencode/nemotron-3.5-lightning-free',
    ]);
    expect(providers['opencode-zen-cli'].defaultModel).toBe('opencode/minimax-m3.1-flash-free');
    expect(providers['opencode-zen-cli'].heavyModel).toBe('opencode/big-pickle');
    expect(providers['opencode-zen-tui'].models).toEqual(['opencode/mimo-v2.6-flash-free', 'opencode/custom']);
    expect(providers['opencode-zen'].models).toEqual(['opencode/mimo-v2.5-free']);
    expect(readJson(jobsPath).jobs.map((j) => j.model)).toEqual(['opencode/glm-5.3-flash-free', 'opencode/mimo-v2.5-free', 'opencode/big-pickle']);

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, providers: [], jobs: [] });
  });

  it('skips cleanly when neither store exists', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, providers: [], jobs: [] });
  });
});
