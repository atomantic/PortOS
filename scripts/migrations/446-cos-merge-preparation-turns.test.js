import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './446-cos-merge-preparation-turns.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'merge-preparation-migration-'));
  roots.push(rootDir);
  await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  return { rootDir, path: join(rootDir, 'data', 'cos', 'state.json') };
};

describe('merge preparation upgrade compatibility', () => {
  it('initializes an existing install without replacing its live lease or subsequently persisted turn', async () => {
    const { rootDir, path } = await fixture();
    const existing = { mergeAdmissions: { repo: { token: 'live-lease' } }, unrelated: { retained: true } };
    await writeFile(path, JSON.stringify(existing));
    expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
    const state = JSON.parse(await readFile(path, 'utf8'));
    expect(state).toEqual({ ...existing, mergePreparations: {} });
    state.mergePreparations.repo = [{ token: 'live-turn' }];
    await writeFile(path, JSON.stringify(state));
    expect(await migration.up({ rootDir })).toMatchObject({ updated: 0 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(state);
  });

  it('preserves missing and malformed state rather than fabricating empty ownership', async () => {
    const { rootDir, path } = await fixture();
    expect(await migration.up({ rootDir })).toMatchObject({ updated: 0, reason: 'no-readable-state' });
    await writeFile(path, 'broken');
    expect(await migration.up({ rootDir })).toMatchObject({ updated: 0, reason: 'no-readable-state' });
    expect(await readFile(path, 'utf8')).toBe('broken');
    await writeFile(path, '{"mergePreparations":null}');
    expect(await migration.up({ rootDir })).toMatchObject({ updated: 0 });
    expect(await readFile(path, 'utf8')).toBe('{"mergePreparations":null}');
  });
});
