/**
 * Behavioral cover for the Data Manager's per-item purge (issue #3327).
 *
 * Every case here runs against a throwaway temp root — `PATHS.data` is
 * redirected before `dataManager.js` captures it, so nothing in this file can
 * reach the install's real `data/` directory, which holds the only copy of the
 * media these categories hold.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'datamanager-purge-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: TEST_DATA_ROOT });
});

const { purgeCategory } = await import('./dataManager.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const dataPath = (...parts) => join(TEST_DATA_ROOT, ...parts);

beforeEach(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  // `images` is item-scoped: a flat directory of assets plus one scratch dir.
  mkdirSync(dataPath('images', '.scratch'), { recursive: true });
  writeFileSync(dataPath('images', 'render-0001.png'), 'png');
  writeFileSync(dataPath('images', 'render-0002.png'), 'png');
  writeFileSync(dataPath('images', '.scratch', 'work.tmp'), 'tmp');
  // `messages` stays category-scoped.
  mkdirSync(dataPath('messages', 'account'), { recursive: true });
  writeFileSync(dataPath('messages', 'index.json'), '{}');
});

describe('purgeCategory — item-scoped categories (#3327)', () => {
  it('removes exactly the named file and leaves the rest of the category', async () => {
    const result = await purgeCategory('images', { subPath: 'render-0001.png' });
    expect(result).toEqual({ category: 'images', subPath: 'render-0001.png' });
    expect(existsSync(dataPath('images', 'render-0001.png'))).toBe(false);
    expect(existsSync(dataPath('images', 'render-0002.png'))).toBe(true);
  });

  it('refuses a directory entry — those hold other features working state', async () => {
    await expect(purgeCategory('images', { subPath: '.scratch' })).rejects.toThrow(/only removes files/);
    expect(existsSync(dataPath('images', '.scratch', 'work.tmp'))).toBe(true);
  });

  it('404s a subPath that does not exist instead of silently reporting success', async () => {
    await expect(purgeCategory('images', { subPath: 'never-existed.png' })).rejects.toThrow(/Item not found/);
  });

  it('refuses a nested subPath, so only listed entries are reachable', async () => {
    await expect(purgeCategory('images', { subPath: '.scratch/work.tmp' })).rejects.toThrow(/single entry/);
    expect(existsSync(dataPath('images', '.scratch', 'work.tmp'))).toBe(true);
  });

  it('cannot follow an intermediate symlink out of the category', async () => {
    mkdirSync(dataPath('elsewhere'), { recursive: true });
    writeFileSync(dataPath('elsewhere', 'keepsake.png'), 'png');
    symlinkSync(dataPath('elsewhere'), dataPath('images', 'link'));

    // The lexical resolve/relative containment check alone would pass this —
    // it never touches the filesystem, so it cannot see the symlink hop.
    await expect(purgeCategory('images', { subPath: 'link/keepsake.png' })).rejects.toThrow(/single entry/);
    expect(existsSync(dataPath('elsewhere', 'keepsake.png'))).toBe(true);
  });

  it('unlinks a symlinked entry itself without touching what it points at', async () => {
    mkdirSync(dataPath('elsewhere'), { recursive: true });
    writeFileSync(dataPath('elsewhere', 'keepsake.png'), 'png');
    symlinkSync(dataPath('elsewhere', 'keepsake.png'), dataPath('images', 'alias.png'));

    await purgeCategory('images', { subPath: 'alias.png' });
    expect(existsSync(dataPath('images', 'alias.png'))).toBe(false);
    expect(existsSync(dataPath('elsewhere', 'keepsake.png'))).toBe(true);
  });

  it('still refuses the whole-category form even though the directory exists', async () => {
    await expect(purgeCategory('images')).rejects.toThrow(/only supports per-item purge/);
    expect(existsSync(dataPath('images', 'render-0001.png'))).toBe(true);
  });
});

describe('purgeCategory — category-scoped categories keep their behavior', () => {
  it('empties the directory when no subPath is given', async () => {
    const result = await purgeCategory('messages');
    expect(result).toEqual({ category: 'messages', subPath: null });
    expect(existsSync(dataPath('messages', 'index.json'))).toBe(false);
    expect(existsSync(dataPath('messages', 'account'))).toBe(false);
    expect(existsSync(dataPath('messages'))).toBe(true);
  });

  it('removes a named subdirectory recursively', async () => {
    writeFileSync(dataPath('messages', 'account', 'inbox.json'), '{}');
    await purgeCategory('messages', { subPath: 'account' });
    expect(existsSync(dataPath('messages', 'account'))).toBe(false);
    expect(existsSync(dataPath('messages', 'index.json'))).toBe(true);
  });

  // A caller that meant to name an entry and produced an empty string must not
  // land in the branch that empties the whole directory.
  it('400s an empty subPath instead of widening it into a whole-category wipe', async () => {
    await expect(purgeCategory('messages', { subPath: '' })).rejects.toThrow(/single entry/);
    expect(existsSync(dataPath('messages', 'index.json'))).toBe(true);
  });

  it('still refuses a nested subPath', async () => {
    await expect(purgeCategory('messages', { subPath: '../images/render-0001.png' })).rejects.toThrow(/single entry/);
    expect(existsSync(dataPath('images', 'render-0001.png'))).toBe(true);
  });
});
