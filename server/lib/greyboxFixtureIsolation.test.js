import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTempDataRoot } from './mockPathsDataRoot.js';

const install = createTempDataRoot('portos-greybox-install-');
const gallery = join(install, 'data', 'images');
const files = ['layout.png', 'old-layout.png', 'plate.png', 'edit.png'];
afterAll(() => rmSync(install, { recursive: true, force: true }));

describe('greybox fixture isolation', () => {
  it('leaves an independent install gallery untouched when the three suites run', () => {
    mkdirSync(gallery, { recursive: true });
    for (const file of files) writeFileSync(join(gallery, file), 'gallery canary');
    const env = { ...process.env, PORTOS_DATA_ROOT: install };
    delete env.PORTOS_TEST_TEMP_ROOT;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    execFileSync(process.execPath, [
      'node_modules/vitest/vitest.mjs', 'run', '--configLoader', 'runner', '--maxWorkers=2',
      'services/imageGen/prepareParams.test.js', 'services/videoGen/submitJob.test.js',
      'services/musicVideo/productionDispatch.test.js',
    ], { cwd: join(import.meta.dirname, '..'), env, timeout: 60000, stdio: 'pipe' });
    for (const file of files) expect(readFileSync(join(gallery, file), 'utf8')).toBe('gallery canary');
  }, 70000);
});
