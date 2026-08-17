import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), statErrorPath: null }));
const testDataRoot = mkdtempSync(join(tmpdir(), 'datamanager-strict-test-'));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
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
  imageCleanTmpBusy: vi.fn(async () => ({ busy: false })),
  trainingRunsBusy: vi.fn(async () => ({ busy: false })),
  updateDetachedBusy: vi.fn(async () => ({ busy: false })),
}));

const { getDataOverview } = await import('./dataManager.js');

afterAll(() => rmSync(testDataRoot, { recursive: true, force: true }));

beforeEach(() => {
  mocks.statErrorPath = null;
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
  });

  it('rejects the same failed category scan for fail-closed report callers', async () => {
    await expect(getDataOverview({ strict: true })).rejects.toThrow('permission denied');
  });

  it('preserves access failures during strict existence checks as unknown', async () => {
    mocks.statErrorPath = join(testDataRoot, 'runs');

    await expect(getDataOverview({ strict: true })).rejects.toThrow('stat access denied');
  });
});
