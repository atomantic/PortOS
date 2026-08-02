/**
 * The CATEGORY_BUSY gate on a whole-directory purge (issue #3342).
 *
 * Everything here runs against a throwaway temp root — `PATHS.data` is
 * redirected before `dataManager.js` captures it, so no case can reach the
 * install's real `data/`. The busy probes themselves are stubbed: this suite
 * covers the gate, not the probes (`dataManagerBusy.test.js` covers those).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'datamanager-busy-gate-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: TEST_DATA_ROOT });
});

const idle = () => Promise.resolve({ busy: false, reason: null });

vi.mock('./dataManagerBusy.js', () => ({
  imageCleanTmpBusy: vi.fn(idle),
  trainingRunsBusy: vi.fn(idle),
  updateDetachedBusy: vi.fn(idle),
}));

const { imageCleanTmpBusy, trainingRunsBusy, updateDetachedBusy } = await import('./dataManagerBusy.js');
const { purgeCategory, getDataOverview, getCategoryDetail, CATEGORIES } = await import('./dataManager.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const dataPath = (...parts) => join(TEST_DATA_ROOT, ...parts);

const seed = (category, file = 'work.tmp') => {
  mkdirSync(dataPath(category), { recursive: true });
  writeFileSync(dataPath(category, file), 'x');
};

beforeEach(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  seed('image-clean-tmp', 'init-0000.png');
  seed('training-runs', 'run-0001');
  seed('update-detached', 'pid');
  seed('messages', 'index.json');
  imageCleanTmpBusy.mockReset().mockImplementation(idle);
  trainingRunsBusy.mockReset().mockImplementation(idle);
  updateDetachedBusy.mockReset().mockImplementation(idle);
});

const busyWith = (reason) => () => Promise.resolve({ busy: true, reason });

describe('purgeCategory — CATEGORY_BUSY refusal', () => {
  const cases = [
    ['image-clean-tmp', () => imageCleanTmpBusy, 'init-0000.png', 'an image render is in flight'],
    ['training-runs', () => trainingRunsBusy, 'run-0001', 'a trainer is running'],
    ['update-detached', () => updateDetachedBusy, 'pid', 'an update is running'],
  ];

  it.each(cases)('refuses the whole-category purge for %s while its probe reports busy', async (key, probe, file, reason) => {
    probe().mockImplementation(busyWith(reason));
    await expect(purgeCategory(key)).rejects.toMatchObject({ status: 409, code: 'CATEGORY_BUSY', message: reason });
    expect(existsSync(dataPath(key, file))).toBe(true);
  });

  it.each(cases)('purges %s normally once its probe goes idle', async (key, _probe, file) => {
    const result = await purgeCategory(key);
    expect(result).toEqual({ category: key, subPath: null });
    expect(existsSync(dataPath(key, file))).toBe(false);
    expect(existsSync(dataPath(key))).toBe(true);
  });

  // A per-item purge names the one entry the user picked, so it stays available
  // while the category is busy — the refusal is about the all-at-once wipe.
  it('still allows a per-item purge while the category is busy', async () => {
    trainingRunsBusy.mockImplementation(busyWith('a trainer is running'));
    await purgeCategory('training-runs', { subPath: 'run-0001' });
    expect(existsSync(dataPath('training-runs', 'run-0001'))).toBe(false);
    expect(trainingRunsBusy).not.toHaveBeenCalled();
  });

  it('leaves a category with no busyCheck completely unaffected', async () => {
    expect(CATEGORIES.messages.busyCheck).toBeUndefined();
    await purgeCategory('messages');
    expect(existsSync(dataPath('messages', 'index.json'))).toBe(false);
  });

  // "Could not verify" and "nothing is running" must not collapse into the same
  // answer — the purge is irreversible.
  it('fails closed when the probe throws', async () => {
    trainingRunsBusy.mockImplementation(() => Promise.reject(new Error('queue unavailable')));
    await expect(purgeCategory('training-runs')).rejects.toMatchObject({ status: 409, code: 'CATEGORY_BUSY' });
    expect(existsSync(dataPath('training-runs', 'run-0001'))).toBe(true);
  });

  it('fails closed when the probe returns a shape it cannot read', async () => {
    trainingRunsBusy.mockImplementation(() => Promise.resolve({ reason: 'no busy flag' }));
    await expect(purgeCategory('training-runs')).rejects.toMatchObject({ code: 'CATEGORY_BUSY' });
    expect(existsSync(dataPath('training-runs', 'run-0001'))).toBe(true);
  });

  it('supplies a fallback reason when a busy probe names none', async () => {
    trainingRunsBusy.mockImplementation(() => Promise.resolve({ busy: true }));
    await expect(purgeCategory('training-runs')).rejects.toThrow(/Something is using data\/training-runs/);
  });
});

describe('busy state on the read paths', () => {
  it('ships busy + busyReason on the overview so the button can go before the click', async () => {
    trainingRunsBusy.mockImplementation(busyWith('2 LoRA training run(s) queued or running'));
    const { categories } = await getDataOverview();
    const training = categories.find(c => c.key === 'training-runs');
    expect(training).toMatchObject({ busy: true, busyReason: '2 LoRA training run(s) queued or running' });
    expect(categories.find(c => c.key === 'messages')).toMatchObject({ busy: false, busyReason: null });
  });

  it('never leaks the busyCheck function into the payload', async () => {
    const { categories } = await getDataOverview();
    expect(categories.every(c => !('busyCheck' in c))).toBe(true);
    const detail = await getCategoryDetail('training-runs');
    expect('busyCheck' in detail).toBe(false);
  });

  it('reports the same busy state on the category detail', async () => {
    updateDetachedBusy.mockImplementation(busyWith('a self-update is running'));
    const detail = await getCategoryDetail('update-detached');
    expect(detail).toMatchObject({ busy: true, busyReason: 'a self-update is running' });
  });
});
