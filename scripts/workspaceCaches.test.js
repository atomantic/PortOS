import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWorkspaceCacheIsolation } from './lib/workspaceCacheFixture.js';
import { readCiJobs } from './lib/ciWorkflowJobs.js';
import { createTestPhaseDiagnostics } from '../lib/testPhaseDiagnostics.js';

const vitestCacheSteps = body => body.split(/\n {6}- /).filter(step => step.startsWith('name: Cache Vitest transform artifacts'))
  .map(step => step.split(/\n {6}#/)[0]);

describe('checkout-owned server Vite caches with shared dependencies', () => {
  it('keeps CI artifact-cache restores pointed at the owned test cache roots', () => {
    const jobs = readCiJobs();
    const shardSuffix = '-${{ matrix.shard }}of${{ strategy.job-total }}';
    const serverKey = "vitest-server-${{ runner.os }}-${{ hashFiles('server/package-lock.json', 'server/vitest.config.js', 'server/vitest.config.db.js', 'scripts/vitestCiPool.js') }}";
    const fallbacks = [
      "vitest-server-${{ runner.os }}-${{ hashFiles('server/package-lock.json') }}-",
      'vitest-server-${{ runner.os }}-',
    ];
    for (const [id, suffix] of [
      ['server', shardSuffix], ['database', ''], ['browser', `-browser${shardSuffix}`],
      ['windows-server', shardSuffix], ['macos-native', '-macos-native'],
    ]) {
      const caches = vitestCacheSteps(jobs[id]);
      expect(caches, id).toHaveLength(2);
      for (const cache of caches) {
        expect(cache).not.toContain('node_modules/.vite');
        expect(cache).toContain('server/.cache/vitest\n');
        expect(cache).toContain('server/.cache/vitest-db\n');
        expect(cache).toContain(`key: ${serverKey}${suffix}\n`);
        expect(cache.split('restore-keys: |\n')[1].trim().split('\n').map(line => line.trim())).toEqual(fallbacks);
      }
    }
    const clientCaches = vitestCacheSteps(jobs.client);
    expect(clientCaches).toHaveLength(2);
    for (const cache of clientCaches) {
      expect(cache).not.toContain('node_modules/.vite');
      expect(cache).toContain('client/.cache/vitest\n');
    }
  });

  it('saves Vitest transform and APT caches only outside pull requests', () => {
    // A PR-saved entry is scoped to its merge ref, so nothing reads it again.
    const jobs = readCiJobs();
    const dbTools = readFileSync(new URL('../.github/actions/db-tools/action.yml', import.meta.url), 'utf8');
    const aptSteps = dbTools.split(/\n\s*- name: /).filter(step => step.startsWith('Cache APT package'));
    const cachePairs = [
      ...['client', 'server', 'database', 'browser', 'windows-server', 'macos-native'].map(id => vitestCacheSteps(jobs[id])),
      aptSteps,
    ];
    for (const steps of cachePairs) {
      expect(steps).toHaveLength(2);
      const restore = steps.find(step => step.includes('actions/cache/restore@'));
      const save = steps.find(step => step.includes('actions/cache@'));
      expect(restore).toContain("github.event_name == 'pull_request'");
      expect(save).toContain("github.event_name != 'pull_request'");
    }
  });

  for (const [configName, cacheName] of [['vitest.config.js', 'vitest'], ['vitest.config.db.js', 'vitest-db']]) {
    it.concurrent(`server ${configName} keeps concurrent publications separate and reuses its owned cache`, async ({ signal, onTestFailed }) => {
      const children = new Map();
      onTestFailed(({ task }) => {
        const evidence = `Cache children: ${JSON.stringify([...children.values()])}`;
        for (const error of task.result.errors) {
          error.message += `\n${evidence}`;
          if (error.stack) error.stack += `\n${evidence}`;
        }
      });
      await checkWorkspaceCacheIsolation('server', configName, cacheName, expect, signal, {
        phase: createTestPhaseDiagnostics(onTestFailed),
        onChild: row => children.set(row.name, row),
      });
    });
  }

  it('settles cancelled concurrent cache publishers before removing their shared host', async () => {
    let host;
    const controller = new AbortController();
    const pending = checkWorkspaceCacheIsolation('server', 'vitest.config.js', 'vitest', expect, controller.signal, { onHost: value => { host = value; } });
    // Both launches have started synchronously, before the first await.
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(host).toBeDefined();
    expect(existsSync(host)).toBe(false);
  }, 15000);
});
