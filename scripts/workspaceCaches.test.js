import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  for (const [configName, cacheName] of [['vitest.config.js', 'vitest'], ['vitest.config.db.js', 'vitest-db']]) {
    it(`server ${configName} keeps concurrent publications separate and reuses its owned cache`, async ({ signal }) => {
      await checkWorkspaceCacheIsolation('server', configName, cacheName, expect, signal);
    });
  }

  it('settles cancelled concurrent cache publishers before removing their shared host', async () => {
    const before = readdirSync(tmpdir()).filter(name => name.startsWith('workspace-cache-'));
    const controller = new AbortController();
    const pending = checkWorkspaceCacheIsolation('server', 'vitest.config.js', 'vitest', expect, controller.signal);
    // Both launches have started synchronously, before the first await.
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('workspace-cache-'))).toEqual(before);
  }, 15000);
});
