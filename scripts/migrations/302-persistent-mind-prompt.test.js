import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './302-persistent-mind-prompt.js';

let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe('migration 302', () => {
  it('adds defaults without overwriting an existing prompt', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-prompt-'));
    const cosDir = join(rootDir, 'data', 'cos');
    await mkdir(cosDir, { recursive: true });
    const statePath = join(cosDir, 'state.json');
    await writeFile(statePath, JSON.stringify({ config: { autoStart: false } }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.config.persistentMindPrompt.identity).toContain('Chief of Staff');

    state.config.persistentMindPrompt.identity = 'Custom identity';
    await writeFile(statePath, JSON.stringify(state));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(JSON.parse(await readFile(statePath, 'utf8')).config.persistentMindPrompt.identity).toBe('Custom identity');
  });
});
