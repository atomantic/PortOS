import { afterAll, expect, it as vitestIt } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownTestBodies } from '../server/lib/mockPathsDataRoot.js';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from './lib/vitestTempRootFixture.js';

const RUN_CEILING_MS = 120000;
const owned = ownTestBodies(vitestIt);
const it = owned.it;
afterAll(() => owned.drain());

// Pin the real peer pull's final write against sibling bail. A green Vitest file
// can still own a cancelled async body which recreates its already-removed root.
for (const drainBodies of [false, true]) {
  it(`Bible sync sibling bail: ${drainBodies ? 'drains before removal' : 'detects missing drain'}`, async ({ signal }) => {
    const host = mkdtempSync(join(tmpdir(), 'wr-bible-cancel-'));
    let closeConfirmed = true;
    try {
      const fixture = join(host, 'fixture');
      const ready = join(fixture, 'ready');
      const events = join(fixture, 'events');
      const fixtureRun = createVitestTempFixture(host, 'server', '');
      const sourcePath = fileURLToPath(new URL('../server/services/writersRoom/bibleSync.test.js', import.meta.url));
      const input = readFileSync(sourcePath, 'utf8');
      expect(input).toContain('await owned.drain();');
      const mock = "makePathsProxy(await original(), { dataRoot: () => root })";
      expect(input).toContain(mock);
      const header = "it('ships only authored sibling files, pulls missing files, and preserves full cast fields for readers', async () => {";
      expect(input).toContain(header);
      const source = (drainBodies ? input : input.replaceAll('await owned.drain();', '/* negative control: no body settlement */'))
        .replace('rmSync,', 'rmSync as realRmSync,')
        .replace('const root =', `
          const { appendFileSync, existsSync } = await import('node:fs');
          const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');
          let cancellation;
          let pending = false;
          let settled;
          const bodySettled = new Promise(resolve => { settled = resolve; });
          // Vitest runs afterAll hooks in reverse order: observe AFTER the real cleanup.
          afterAll(async () => { await bodySettled; record('observer-complete'); });
          function rmSync(path, options) {
            if (path === root) record('remove-start:pending=' + pending);
            realRmSync(path, options);
            if (path === root) record('remove-complete:exists=' + existsSync(root));
          }
          const root =`)
        .replace("vi.mock('../../lib/fileUtils.js'", "record('allocated');\nvi.mock('../../lib/fileUtils.js'")
        .replace(mock, `(() => {
          return original().then(actual => makePathsProxy(actual, { dataRoot: () => root, overrides: {
            atomicWrite: async (...args) => {
              if (!args[0].endsWith('characters.json')) return actual.atomicWrite(...args);
              pending = true;
              record('write-ready');
              writeFileSync(${JSON.stringify(ready)}, 'ready');
              await cancellation;
              record('write-resume:exists=' + existsSync(root));
              await actual.atomicWrite(...args);
              pending = false;
              record('write-complete:exists=' + existsSync(root));
            }
          } }));
        })()`)
        .replace(header, `${header.replace('async () =>', 'async ({ signal }) =>')}
          cancellation = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
          try {`)
        .replace('expect(await diffWorkBibleManifest(manifest)).toEqual([]);', `expect(await diffWorkBibleManifest(manifest)).toEqual([]);
          } finally { record('body-settled'); settled(); }`)
        .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)));
      writeFileSync(join(fixture, 'lifecycle.test.js'), source + `
        record('hooks-registered');
      `);
      writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
      fixtureRun.args[fixtureRun.args.indexOf('--maxWorkers') + 1] = '2';
      fixtureRun.args.push('--bail=1', '--testNamePattern', 'ships only authored sibling files|controlled sibling failure');
      closeConfirmed = false;
      const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS, { signal });
      closeConfirmed = result.closeConfirmed;
      if (signal.aborted && closeConfirmed) return;
      const observed = existsSync(events) ? readFileSync(events, 'utf8') : '';
      const output = `${result.stdout}\n${result.stderr}\nlifecycle: ${observed}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(output).toContain('controlled sibling failure');
      expect(observed, output).toBe(drainBodies
        ? 'allocated\nhooks-registered\nwrite-ready\nwrite-resume:exists=true\nwrite-complete:exists=true\nbody-settled\nremove-start:pending=false\nremove-complete:exists=false\nobserver-complete\n'
        : 'allocated\nhooks-registered\nwrite-ready\nremove-start:pending=true\nremove-complete:exists=false\nwrite-resume:exists=false\nwrite-complete:exists=true\nbody-settled\nobserver-complete\n');
      if (drainBodies) expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
      else expect(output).toContain('test temp leak: wr-bible-sync- ×1');
    } finally {
      // A killed process is not proof its handles closed. Retain an unconfirmed
      // host for the run's leak guard instead of deleting underneath its writer.
      if (closeConfirmed) rmSync(host, { recursive: true, force: true });
    }
  }, RUN_CEILING_MS + 15000);
}
