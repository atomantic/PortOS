import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-dcp-sweep-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const { sweepAbandonedDcpBuilds } = await import('./dcp.js');

afterAll(() => cleanupTempDataRoots());

describe('sweepAbandonedDcpBuilds', () => {
  it('deletes only dcp-* dirs still carrying the building marker', async () => {
    await expect(sweepAbandonedDcpBuilds()).resolves.toBeUndefined();
    const abandoned = join(PATHS.videos, 'dcp-abandoned');
    const published = join(PATHS.videos, 'dcp-published');
    const unrelated = join(PATHS.videos, 'other-dir');
    for (const dir of [abandoned, published, unrelated]) await mkdir(join(dir, 'package'), { recursive: true });
    await writeFile(join(abandoned, '.dcp-building'), '');
    await writeFile(join(unrelated, '.dcp-building'), '');

    await sweepAbandonedDcpBuilds();

    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(published)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});
