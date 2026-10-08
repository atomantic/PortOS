import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { execFileSync } from '../lib/childProcess.js';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const controls = vi.hoisted(() => ({ open: null, tar: null, id: null, tarArgs: [] }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: () => root });
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: (...args) => controls.open ? controls.open(...args) : actual.open(...args),
  };
});
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, randomUUID: () => controls.id ?? actual.randomUUID() };
});
vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (command, args, options, callback) => {
    controls.tarArgs.push(args);
    return controls.tar ? controls.tar(command, args, options, callback) : actual.execFile(command, args, options, callback);
  } };
});

const root = createTempDataRoot('portos-data-manager-archive-');
const { archiveCategory, getBackups, deleteBackup } = await import('./dataManager.js');
const health = join(root, 'health');
const backup = join(root, 'backup');
const archiveBytes = (result, file) => execFileSync('tar', ['-xOzf', resolve(result.archivePath), file], { encoding: 'utf8' });
const seedHealth = async () => {
  await mkdir(health, { recursive: true });
  await writeFile(join(health, '2024-01-01.json'), '{"example":"older"}');
  await writeFile(join(health, '2026-10-01.json'), '{"example":"recent"}');
};

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  Object.assign(controls, { open: null, tar: null, id: null, tarArgs: [] });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('Data Manager recovery archives (#10697)', () => {
  it('keeps both same-second health selections recoverable and supports new and legacy archive names', async () => {
    await seedHealth();
    const first = await archiveCategory('health', { daysToKeep: 365 });
    const second = await archiveCategory('health', { daysToKeep: 1 });
    expect(first.archivePath).not.toBe(second.archivePath);
    expect(await archiveBytes(first, '2024-01-01.json')).toBe('{"example":"older"}');
    expect(await archiveBytes(second, '2026-10-01.json')).toBe('{"example":"recent"}');
    expect(await readdir(health)).toEqual([]);
    const legacy = 'health-2026-01-01T00-00-00.tar.gz';
    await writeFile(join(backup, legacy), 'legacy fixture');
    expect((await getBackups()).map(row => row.name).sort()).toEqual([basename(first.archivePath), basename(second.archivePath), legacy].sort());
    for (const name of [basename(first.archivePath), basename(second.archivePath), legacy]) await deleteBackup(name);
    expect(await readdir(backup)).toEqual([]);
  });

  it('reserves separate input lists and staging archives for concurrent health requests', async () => {
    await seedHealth();
    const actual = await vi.importActual('../lib/childProcess.js');
    const completions = [];
    // Hold successful tar callbacks until both have read their selected inputs:
    // source-import/deletion coordination is a separate lifecycle issue.
    controls.tar = (command, args, options, callback) => actual.execFile(command, args, options, (error, ...output) => {
      completions.push(() => callback(error, ...output));
      if (completions.length === 2) completions.forEach(finish => finish());
    });
    const results = await Promise.all([archiveCategory('health'), archiveCategory('health', { daysToKeep: 1 })]);
    expect(new Set(controls.tarArgs.map(args => dirname(args[1]))).size).toBe(2);
    expect(new Set(controls.tarArgs.map(args => args[args.indexOf('-T') + 1])).size).toBe(2);
    expect(await archiveBytes(results[0], '2024-01-01.json')).toBe('{"example":"older"}');
    expect(await archiveBytes(results[1], '2026-10-01.json')).toBe('{"example":"recent"}');
    expect((await getBackups()).map(row => row.name).sort()).toEqual(results.map(result => basename(result.archivePath)).sort());
    expect((await readdir(backup)).every(name => name.endsWith('.tar.gz'))).toBe(true);
  });

  it('also preserves successive generic category archives in the same second', async () => {
    await mkdir(join(root, 'calendar'));
    await writeFile(join(root, 'calendar', 'example.json'), 'first example');
    const first = await archiveCategory('calendar');
    await writeFile(join(root, 'calendar', 'example.json'), 'second example');
    const second = await archiveCategory('calendar');
    expect(await archiveBytes(first, 'calendar/example.json')).toBe('first example');
    expect(await archiveBytes(second, 'calendar/example.json')).toBe('second example');
  });

  it('cleans only its scratch and keeps health sources when tar fails', async () => {
    await seedHealth();
    await mkdir(backup);
    await writeFile(join(backup, 'earlier.tar.gz'), 'earlier bytes');
    controls.tar = (_command, _args, _options, callback) => callback(new Error('synthetic tar failure'));
    await expect(archiveCategory('health')).rejects.toThrow('synthetic tar failure');
    expect(await readdir(health)).toHaveLength(2);
    expect(await readdir(backup)).toEqual(['earlier.tar.gz']);
    expect(await readFile(join(backup, 'earlier.tar.gz'), 'utf8')).toBe('earlier bytes');
  });

  it('refuses even a UUID collision without replacing an earlier archive or removing sources', async () => {
    await seedHealth();
    controls.id = '00000000-0000-4000-8000-000000000000';
    const first = await archiveCategory('health');
    const original = await readFile(resolve(first.archivePath));
    await expect(archiveCategory('health', { daysToKeep: 1 })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(resolve(first.archivePath))).toEqual(original);
    expect(await readdir(health)).toEqual(['2026-10-01.json']);
    expect(await readdir(backup)).toEqual([basename(first.archivePath)]);
  });

  it('publishes recoverable health bytes when the filesystem requires writable handles for flushing', async () => {
    await seedHealth();
    const actual = await vi.importActual('fs/promises');
    controls.open = async (path, flags, ...args) => {
      const handle = await actual.open(path, flags, ...args);
      if (path.endsWith('.tar.gz')) {
        const sync = handle.sync.bind(handle);
        // Windows FlushFileBuffers rejects handles opened without write access.
        handle.sync = async () => {
          if (flags === 'r') throw Object.assign(new Error('synthetic writable-handle flush required'), { code: 'EACCES' });
          return sync();
        };
      }
      return handle;
    };
    const result = await archiveCategory('health');
    expect(await archiveBytes(result, '2024-01-01.json')).toBe('{"example":"older"}');
    expect(await readdir(health)).toEqual(['2026-10-01.json']);
    expect(await readdir(backup)).toEqual([basename(result.archivePath)]);
  });

  it('keeps health sources when syncing archive bytes fails', async () => {
    await seedHealth();
    const close = vi.fn();
    controls.open = async () => ({ sync: async () => { throw new Error('synthetic sync failure'); }, close });
    await expect(archiveCategory('health')).rejects.toThrow('synthetic sync failure');
    expect(close).toHaveBeenCalledOnce();
    expect(await readdir(health)).toHaveLength(2);
    expect(await readdir(backup)).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('keeps health sources if the published directory cannot be synced', async () => {
    await seedHealth();
    const actual = await vi.importActual('fs/promises');
    controls.open = async (path, ...args) => path === backup
      ? { sync: async () => { throw new Error('synthetic directory sync failure'); }, close: async () => {} }
      : actual.open(path, ...args);
    await expect(archiveCategory('health')).rejects.toThrow('synthetic directory sync failure');
    expect(await readdir(health)).toHaveLength(2);
    const archives = await getBackups();
    expect(archives).toHaveLength(1);
    expect(await archiveBytes({ archivePath: join(backup, archives[0].name) }, '2024-01-01.json')).toBe('{"example":"older"}');
  });

});
