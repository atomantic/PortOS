import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWorkspaceCacheIsolation } from './lib/workspaceCacheFixture.js';
import { readCiJobs } from './lib/ciWorkflowJobs.js';
import { createTestPhaseDiagnostics } from '../lib/testPhaseDiagnostics.js';


describe('checkout-owned server Vite caches with shared dependencies', () => {
  it('keeps CI artifact-cache restores pointed at the owned test cache roots', () => {
    // Every job that runs Vitest restores transform artifacts, the server
    // ones through the setup-server action.
    const jobs = readCiJobs();
    const runners = ['server', 'client', 'database', 'browser', 'windows-server', 'macos-native'];
    for (const id of runners) expect(jobs[id], id).toContain('- name: Cache Vitest transform artifacts');
    const caches = runners.map(id => jobs[id].split('- name: Cache Vitest transform artifacts')[1].split('\n      - name:')[0]);
    for (const cache of caches) {
      expect(cache).not.toContain('node_modules/.vite');
      if (cache.includes('key: vitest-server-')) {
        expect(cache).toContain('server/.cache/vitest\n');
        expect(cache).toContain('server/.cache/vitest-db\n');
      } else expect(cache).toContain('client/.cache/vitest\n');
    }
  });

  it('saves Vitest transform and APT caches only outside pull requests', () => {
    // A PR-saved entry is scoped to its merge ref, so nothing reads it again.
    const jobs = readCiJobs();
    const bodies = [...['client', 'server', 'database', 'browser', 'windows-server', 'macos-native'].map(id => jobs[id]), readFileSync('.github/actions/db-tools/action.yml', 'utf8')];
    for (const body of bodies) {
      const steps = body.split(/\n\s*- name: /).filter(step => /^Cache (Vitest transform|APT package)/.test(step));
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        if (step.includes('actions/cache/restore@')) expect(step).toContain("github.event_name == 'pull_request'");
        else {
          expect(step).toContain('actions/cache@');
          expect(step).toContain("github.event_name != 'pull_request'");
        }
      }
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
