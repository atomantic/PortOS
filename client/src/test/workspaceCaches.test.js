// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkDevCacheIsolation, checkWorkspaceCacheIsolation } from '../../../scripts/lib/workspaceCacheFixture.js';

describe('checkout-owned client Vite caches with shared dependencies', () => {
  it('client vitest.config.js keeps concurrent publications separate and reuses its owned cache', async () => {
    await checkWorkspaceCacheIsolation('client', 'vitest.config.js', 'vitest', expect);
  });

  it.each(['npm', 'PM2'])('%s resolves real dev configs relative to each checkout without config-bundle scratch', async source => {
    await checkDevCacheIsolation(source, expect);
  });
});
