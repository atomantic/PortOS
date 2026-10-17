import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkWorkspaceCacheIsolation } from './lib/workspaceCacheFixture.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));

describe('checkout-owned server Vite caches with shared dependencies', () => {
  it('keeps CI artifact-cache restores pointed at the owned test cache roots', () => {
    const workflow = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    const caches = workflow.split('- name: Cache Vitest transform artifacts').slice(1)
      .map(block => block.split('\n      - name:')[0]);
    expect(caches).toHaveLength(5);
    for (const cache of caches) {
      expect(cache).not.toContain('node_modules/.vite');
      if (cache.includes('key: vitest-server-')) {
        expect(cache).toContain('server/.cache/vitest\n');
        expect(cache).toContain('server/.cache/vitest-db\n');
      } else expect(cache).toContain('client/.cache/vitest\n');
    }
  });

  it.each([
    ['vitest.config.js', 'vitest'],
    ['vitest.config.db.js', 'vitest-db'],
  ])('server %s keeps concurrent publications separate and reuses its owned cache', async (configName, cacheName) => {
    await checkWorkspaceCacheIsolation('server', configName, cacheName, expect);
  });
});
