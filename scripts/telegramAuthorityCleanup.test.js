import { afterAll, expect, it as vitestIt } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownTestBodies } from '../server/lib/mockPathsDataRoot.js';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from './lib/vitestTempRootFixture.js';

const RUN_CEILING_MS = 120000;
const owned = ownTestBodies(vitestIt);
afterAll(() => owned.drain());

for (const drainBodies of [false, true]) {
  owned.it(`Telegram session cancellation ${drainBodies ? 'drains' : 'exposes cleanup race'}`, async ({ signal }) => {
    const host = mkdtempSync(join(tmpdir(), 'telegram-cancel-'));
    let closeConfirmed = true;
    try {
      const fixture = join(host, 'fixture');
      const ready = join(fixture, 'ready');
      const events = join(fixture, 'events');
      const run = createVitestTempFixture(host, 'server', '');
      writeFileSync(join(fixture, 'vitest.setup.js'), `import ${JSON.stringify(new URL('../server/vitest.setup.js', import.meta.url).href)};\n`);
      const sourcePath = fileURLToPath(new URL('../server/routes/hostControlTelegram.test.js', import.meta.url));
      const input = readFileSync(sourcePath, 'utf8');
      const mock = "vi.mock('../lib/fileUtils.js', async (importOriginal) =>\n  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-telegram-authority-') }));";
      const body = 'const session = await createSession({ label: principal === \'delegated agent\' ? \'agent\' : \'operator\' });';
      const cleanup = 'try { await owned.drain(); } finally { cleanupTempDataRoots(); }';
      for (const marker of [mock, body, cleanup]) expect(input).toContain(marker);
      const source = input.replace(mock, `
        const control = vi.hoisted(() => ({ wait: null }));
        vi.mock('../lib/fileUtils.js', async (importOriginal) => {
          const actual = await importOriginal();
          return makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('portos-telegram-authority-'), overrides: {
            atomicWrite: async (...args) => { await control.wait(args[0]); return actual.atomicWrite(...args); },
          } });
        });`)
        .replace('const owned = ownTestBodies(vitestIt);', `
          const { appendFileSync, existsSync, writeFileSync, rmSync } = await import('node:fs');
          const { dirname } = await import('node:path');
          const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');
          let root;
          let done;
          const settled = new Promise(resolve => { done = resolve; });
          afterAll(async () => { await settled; record('observer:exists=' + existsSync(root)); rmSync(root, { recursive: true, force: true }); });
          const owned = ownTestBodies(vitestIt);`)
        .replace(cleanup, `${drainBodies ? 'await owned.drain();' : ''} record('cleanup:exists=' + existsSync(root)); cleanupTempDataRoots(); record('removed:exists=' + existsSync(root));`)
        .replace(']) it(`preserves ${principal} Telegram operations`, async () => {', ']) it(`preserves ${principal} Telegram operations`, async ({ signal }) => {')
        .replace(body, `control.wait = async file => {
            root = dirname(file);
            record('write-ready:exists=' + existsSync(root));
            const cancelled = new Promise(resolve => signal.addEventListener('abort', () => { record('aborted'); setImmediate(resolve); }, { once: true }));
            writeFileSync(${JSON.stringify(ready)}, 'ready');
            await cancelled;
            record('write-resume:exists=' + existsSync(root));
          };
          ${body}
          record('write-settled:exists=' + existsSync(root));
          done();
          return;`)
        .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)));
      writeFileSync(join(fixture, 'lifecycle.test.js'), source);
      writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
      run.args[run.args.indexOf('--maxWorkers') + 1] = '2';
      run.args.push('--bail=1', '--testNamePattern', 'preserves operator session|controlled sibling failure');
      closeConfirmed = false;
      const result = await runFixtureToCompletion(run, RUN_CEILING_MS, { signal });
      closeConfirmed = result.closeConfirmed;
      if (signal.aborted && closeConfirmed) return;
      const observed = existsSync(events) ? readFileSync(events, 'utf8') : '';
      const output = `${result.stdout}\n${result.stderr}\n${observed}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(output).toContain('controlled sibling failure');
      expect(observed, output).toBe(drainBodies
        ? 'write-ready:exists=true\naborted\nwrite-resume:exists=true\nwrite-settled:exists=true\ncleanup:exists=true\nremoved:exists=false\nobserver:exists=false\n'
        : 'write-ready:exists=true\naborted\ncleanup:exists=true\nremoved:exists=false\nwrite-resume:exists=false\nwrite-settled:exists=true\nobserver:exists=true\n');
      expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
    } finally {
      if (closeConfirmed) rmSync(host, { recursive: true, force: true });
    }
  }, RUN_CEILING_MS + 15000);
}
