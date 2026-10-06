import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitForFixtureReady } from './vitestTempRootFixture.js';

describe('waitForFixtureReady', () => {
  it('resolves for a file that is already present and for one that appears later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-ready-'));
    try {
      const present = join(dir, 'present');
      writeFileSync(present, 'ready');
      await expect(waitForFixtureReady(present)).resolves.toBeUndefined();

      const later = join(dir, 'later');
      const pending = waitForFixtureReady(later);
      writeFileSync(later, 'ready');
      await expect(pending).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects on the caller signal and ignores a file created after that abort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-abort-'));
    try {
      const file = join(dir, 'ready');
      const controller = new AbortController();
      const pending = waitForFixtureReady(file, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      writeFileSync(file, 'late');
      await new Promise(resolve => setTimeout(resolve, 40));
      await expect(Promise.race([
        pending.then(() => 'resolved', () => 'rejected'),
        new Promise(resolve => setTimeout(() => resolve('quiet'), 20)),
      ])).resolves.toBe('rejected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
