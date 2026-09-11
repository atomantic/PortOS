/**
 * Durable quota-burn store safety. A failed read must stop each read-modify-
 * write path before it can replace the original plan, cooldowns, or run feed.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'quota-burn-store-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

const {
  getQuotaBurnConfig,
  getQuotaBurnInFlight,
  getQuotaBurnRuns,
  recordQuotaBurnInFlight,
  recordQuotaBurnRun,
  saveQuotaBurnConfig,
  settleQuotaBurnRun,
} = await import('./quotaBurnStore.js');

const cosDir = join(TEST_DATA_ROOT, 'cos');
const paths = {
  config: join(cosDir, 'quota-burn.json'),
  inFlight: join(cosDir, 'quota-burn-inflight.json'),
  runs: join(cosDir, 'quota-burn-runs.json'),
};

beforeEach(async () => {
  rmSync(cosDir, { recursive: true, force: true });
  await mkdir(cosDir, { recursive: true });
});

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const writeUnreadable = (path) => {
  writeFileSync(path, '{"truncated":');
  return readFileSync(path);
};

const expectPreserved = async (path, before, operation) => {
  await expect(operation()).rejects.toMatchObject({ code: 'UNREADABLE_STORE', status: 500 });
  expect(readFileSync(path)).toEqual(before);
};

describe('quotaBurnStore unreadable files', () => {
  it('preserves the plan when a settings save follows a failed read', async () => {
    const before = writeUnreadable(paths.config);

    await expectPreserved(paths.config, before, () => saveQuotaBurnConfig({ enabled: true }));
    await expect(getQuotaBurnConfig()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  });

  it('preserves cooldowns when a scheduler stamp follows a failed read', async () => {
    const before = writeUnreadable(paths.inFlight);

    await expectPreserved(paths.inFlight, before, () => recordQuotaBurnInFlight(['series:s1']));
    await expect(getQuotaBurnInFlight()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  });

  it('preserves the run feed for append and settlement writes', async () => {
    const before = writeUnreadable(paths.runs);

    await expectPreserved(paths.runs, before, () => recordQuotaBurnRun({ requestId: 'r1' }));
    await expectPreserved(paths.runs, before, () => settleQuotaBurnRun('r1', { accepted: true }));
    await expect(getQuotaBurnRuns()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
  });
});

describe('quotaBurnStore absent files', () => {
  it('initializes each mutable store from a trustworthy empty state', async () => {
    await saveQuotaBurnConfig({ enabled: true });
    await recordQuotaBurnInFlight(['series:s1'], { now: 1000 });
    await recordQuotaBurnRun({ requestId: 'r1' });

    expect(await getQuotaBurnConfig()).toMatchObject({ enabled: true });
    expect(await getQuotaBurnInFlight({ now: 1000 })).toEqual(new Set(['series:s1']));
    expect(await getQuotaBurnRuns()).toHaveLength(1);
  });
});
