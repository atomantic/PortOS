// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkDevCacheIsolation, checkWorkspaceCacheIsolation } from '../../../scripts/lib/workspaceCacheFixture.js';

describe('checkout-owned client Vite caches with shared dependencies', () => {
  it('client vitest.config.js keeps concurrent publications separate and reuses its owned cache', async ({ signal, task }) => {
    expect(task.file.projectName).toBe('capture');
    await checkWorkspaceCacheIsolation('client', 'vitest.config.js', 'vitest', expect, signal);
  });

  it('npm and PM2 resolve real dev configs relative to each checkout without config-bundle scratch', async ({ signal }) => {
    await checkDevCacheIsolation(expect, signal);
  });
});
