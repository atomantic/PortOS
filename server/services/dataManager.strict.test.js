import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), statErrorPath: null, countErrorPath: null, virtualCount: 0 }));
const testDataRoot = mkdtempSync(join(tmpdir(), 'datamanager-strict-test-'));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    opendir: vi.fn(async (path, ...args) => {
      if (path === mocks.countErrorPath) throw Object.assign(new Error('enumeration denied'), { code: 'EACCES' });
      if (mocks.virtualCount && String(path).endsWith('cache')) return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < mocks.virtualCount; index++) yield {
            name: `example-${index}-${'x'.repeat(200)}`, isDirectory: () => false, isFile: () => true,
          };
        },
      };
      return actual.opendir(path, ...args);
    }),
    stat: vi.fn((path, ...args) => {
      if (path === mocks.statErrorPath) {
        return Promise.reject(Object.assign(new Error('stat access denied'), { code: 'EACCES' }));
      }
      return actual.stat(path, ...args);
    }),
  };
});
vi.mock('../lib/childProcess.js', () => ({ execFile: mocks.execFile }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: testDataRoot });
});
vi.mock('./dataManagerBusy.js', () => ({
  federatedMediaInboxBusy: vi.fn(async () => ({ busy: false })),
  imageCleanTmpBusy: vi.fn(async () => ({ busy: false })),
  trainingRunsBusy: vi.fn(async () => ({ busy: false })),
  updateDetachedBusy: vi.fn(async () => ({ busy: false })),
}));

const { getDataOverview, deleteBackup, invalidateOverviewScan } = await import('./dataManager.js');

afterAll(() => rmSync(testDataRoot, { recursive: true, force: true }));

beforeEach(async () => {
  // A strict scan rejects before its sibling category scans finish; let those settle so they don't spill into the next case's call log.
  await new Promise(resolve => setTimeout(resolve, 10));
  invalidateOverviewScan();
  mocks.statErrorPath = null; mocks.countErrorPath = null; mocks.virtualCount = 0;
  rmSync(testDataRoot, { recursive: true, force: true });
  mkdirSync(join(testDataRoot, 'cache'), { recursive: true });
  mkdirSync(join(testDataRoot, 'runs'), { recursive: true });
  mocks.execFile.mockReset().mockImplementation((command, args, _options, callback) => {
    const target = command === 'find' ? args[0] : args[args.length - 1];
    if (target === join(testDataRoot, 'runs')) {
      callback(new Error('permission denied'));
      return;
    }
    callback(null, {
      stdout: command === 'du' ? `1\t${target}\n` : `${join(target, 'example.json')}\n`,
      stderr: '',
    });
  });
});

describe('dataManager strict overview', () => {
  it('keeps the default endpoint forgiving when a category scan fails', async () => {
    const overview = await getDataOverview();

    expect(overview.categories.find((category) => category.key === 'runs')).toMatchObject({
      size: 0,
      fileCount: 0,
    });
    // The Data Manager's disk panel reads the volume capacity off the overview.
    expect(overview.disk.total).toBeGreaterThan(0);
    expect(overview.disk.free).toBeGreaterThanOrEqual(0);
    expect(overview.disk.free).toBeLessThanOrEqual(overview.disk.total);
  });

  it('rejects the same failed category scan for fail-closed report callers', async () => {
    await expect(getDataOverview({ strict: true })).rejects.toThrow('permission denied');
  });

  it('preserves access failures during strict existence checks as unknown', async () => {
    mocks.statErrorPath = join(testDataRoot, 'runs');

    await expect(getDataOverview({ strict: true })).rejects.toThrow('stat access denied');
  });
});

// Regression: an enumeration error is unknown even when size succeeds; a large
// listing never needs to fit in execFile's stdout buffer.
it('counts a large streamed listing and never invokes find', async () => {
  mocks.virtualCount = 10000;
  const overview = await getDataOverview();
  expect(overview.categories.find(c => c.key === 'cache')).toMatchObject({ size: 1024, fileCount: 10000 });
  expect(mocks.execFile.mock.calls.every(([command]) => command === 'du')).toBe(true);
});
it('keeps byte totals with unavailable counts, and rejects enumeration errors in strict mode', async () => {
  mocks.countErrorPath = join(testDataRoot, 'cache');
  mocks.execFile.mockImplementation((command, args, options, callback) => callback(null, { stdout: '1\tdata\n', stderr: '' }));
  const overview = await getDataOverview();
  expect(overview.categories.find(c => c.key === 'cache')).toMatchObject({ size: 1024, fileCount: null });
  expect(overview.totalFileCount).toBeNull();
  await expect(getDataOverview({ strict: true })).rejects.toThrow('enumeration denied');
});

describe('dataManager overview scan sharing (#12994)', () => {
  const duTargets = () => mocks.execFile.mock.calls.filter(([command]) => command === 'du').map(([, args]) => args[args.length - 1]);

  it('sums categories and top-level files without re-walking the data root', async () => {
    writeFileSync(join(testDataRoot, 'settings.json'), '{}');
    mocks.execFile.mockImplementation((command, args, _options, callback) => callback(null, { stdout: `4\t${args[args.length - 1]}\n`, stderr: '' }));

    const overview = await getDataOverview();

    expect(duTargets().sort()).toEqual([join(testDataRoot, 'cache'), join(testDataRoot, 'runs')]);
    expect(overview.totalFileCount).toBe(1);
    expect(overview.totalSize).toBeGreaterThanOrEqual(2 * 4 * 1024);
  });

  it('coalesces concurrent calls into one scan and drops it after a backup deletion', async () => {
    mocks.execFile.mockImplementation((command, args, _options, callback) => callback(null, { stdout: `1\t${args[args.length - 1]}\n`, stderr: '' }));
    mkdirSync(join(testDataRoot, 'backup'), { recursive: true });
    const archive = 'cache-2026-01-01T00-00-00.tar.gz';
    writeFileSync(join(testDataRoot, 'backup', archive), 'x');

    await Promise.all([getDataOverview(), getDataOverview()]);
    await getDataOverview();
    expect(duTargets()).toHaveLength(3);

    await deleteBackup(archive);
    await getDataOverview();
    expect(duTargets()).toHaveLength(6);
  });

  it('does not cache a rejected strict scan', async () => {
    await expect(getDataOverview({ strict: true })).rejects.toThrow('permission denied');
    mocks.execFile.mockImplementation((command, args, _options, callback) => callback(null, { stdout: `1\t${args[args.length - 1]}\n`, stderr: '' }));
    await expect(getDataOverview({ strict: true })).resolves.toMatchObject({ dataDir: 'data' });
  });
});
