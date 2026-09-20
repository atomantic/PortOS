import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-review-queue-triage-') });
});

const {
  listReviewQueueTriage,
  removeReviewQueueTriage,
  resetReviewQueueTriageStore,
  upsertReviewQueueTriage,
} = await import('./reviewQueueTriageStore.js');

const dataRoot = lazyTempDataRoot('portos-review-queue-triage-');
const triageFile = join(dataRoot, 'review-queue-triage.json');
const previousBackend = process.env.MEMORY_BACKEND;

beforeEach(async () => {
  process.env.MEMORY_BACKEND = 'file';
  resetReviewQueueTriageStore();
  await rm(triageFile, { force: true });
});

afterAll(async () => {
  resetReviewQueueTriageStore();
  if (previousBackend === undefined) delete process.env.MEMORY_BACKEND;
  else process.env.MEMORY_BACKEND = previousBackend;
  cleanupTempDataRoots();
});

describe('reviewQueueTriageStore', () => {
  it('persists only keyed presentation markers across a backend restart', async () => {
    const marker = {
      actionKey: 'brain.classify:example',
      occurrence: 'morning',
      revision: 'revision-1',
      snoozedUntil: '2099-01-01T00:00:00.000Z',
      dismissed: false,
      deliveryGeneration: 0,
    };

    await upsertReviewQueueTriage(marker);
    resetReviewQueueTriageStore();

    await expect(listReviewQueueTriage()).resolves.toEqual([marker]);
  });

  it('keeps rollover occurrences distinct and removes a cleared marker', async () => {
    const first = { actionKey: 'ask.promote:example', occurrence: '1', revision: 'r1', dismissed: true };
    const second = { actionKey: 'ask.promote:example', occurrence: '2', revision: 'r1', dismissed: true };
    await upsertReviewQueueTriage(first);
    await upsertReviewQueueTriage(second);

    await expect(listReviewQueueTriage()).resolves.toHaveLength(2);
    await removeReviewQueueTriage(first);
    await expect(listReviewQueueTriage()).resolves.toEqual([{
      actionKey: second.actionKey,
      occurrence: second.occurrence,
      revision: second.revision,
      snoozedUntil: null,
      dismissed: true,
      deliveryGeneration: 0,
    }]);
  });
});
