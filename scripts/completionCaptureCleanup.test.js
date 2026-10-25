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

// Run the real seed/restart scenario against a neighboring worker's bail. The
// negative control removes only the ownership drain, leaving every assertion.
for (const drainBodies of [false, true]) {
  owned.it(`completion capture sibling bail: ${drainBodies ? 'settles before teardown' : 'detects unfinished seed body'}`, async ({ signal }) => {
    const host = mkdtempSync(join(tmpdir(), 'completion-cancel-'));
    let closeConfirmed = true;
    try {
      const fixture = join(host, 'fixture');
      const ready = join(fixture, 'ready');
      const events = join(fixture, 'events');
      const fixtureRun = createVitestTempFixture(host, 'server', '');
      // Real setup owns Git templates after per-suite teardown has settled.
      writeFileSync(join(fixture, 'vitest.setup.js'), `import ${JSON.stringify(new URL('../server/vitest.setup.js', import.meta.url).href)};\n`);
      const sourcePath = fileURLToPath(new URL('../server/services/cosAgentLifecycle.test.js', import.meta.url));
      const input = readFileSync(sourcePath, 'utf8');
      const header = 'seedBodies.it(`recovers only the original completion physical seed after restart, scenario=${scenario}`, async () => {';
      const gitRead = "expect((await execGit(['rev-parse', 'HEAD'], checkout)).stdout.trim()).toBe(retainedHead);";
      for (const marker of [header, gitRead, 'await seedBodies.drain();']) expect(input).toContain(marker);
      const source = (drainBodies ? input : input.replace('await seedBodies.drain();', '/* negative control: no body settlement */'))
        .replace('afterAll(cleanupTempDataRoots);', `
          const { appendFileSync, writeFileSync } = await import('node:fs');
          const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');
          let seedRoot;
          let pending = false;
          let release;
          let settled;
          const bodySettled = new Promise(resolve => { settled = resolve; });
          // Registered before real cleanup: reverse hook order observes teardown
          // first, then safely joins the negative control's orphaned body.
          afterAll(async () => {
            await bodySettled;
            record('observer-complete:exists=' + existsSync(seedRoot));
          });
          afterAll(() => {
            record('outer-cleanup:pending=' + pending + ':exists=' + existsSync(seedRoot));
            cleanupTempDataRoots();
          });`)
        .replace(header, header.replace('async () =>', 'async ({ signal }) =>'))
        .replace("let failFirstRead;", `let failFirstRead;
          seedRoot = scratch;
          record('allocated');
          const cancelled = new Promise(resolve => { release = resolve; });
          signal.addEventListener('abort', () => {
            record('aborted');
            // Let Vitest enter teardown while this body still owns Git work.
            setImmediate(release);
          }, { once: true });`)
        .replace(gitRead, `pending = true;
          record('git-ready');
          writeFileSync(${JSON.stringify(ready)}, 'ready');
          await cancelled;
          record('git-resume');
          ${gitRead}
          pending = false;
          record('git-settled');`)
        .replace('failFirstRead?.mockRestore();', "record('finally-enter');\n        failFirstRead?.mockRestore();")
        .replace('await rm(scratch, { recursive: true, force: true, maxRetries: 3 });', `await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
          record('seed-removed:exists=' + existsSync(scratch));
          settled();`)
        .replace('fsFailures.dateBucketWritesFail = false;', `record('teardown:pending=' + pending + ':exists=' + existsSync(seedRoot));
          fsFailures.dateBucketWritesFail = false;`)
        .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)));
      writeFileSync(join(fixture, 'lifecycle.test.js'), source);
      writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
      fixtureRun.args[fixtureRun.args.indexOf('--maxWorkers') + 1] = '2';
      fixtureRun.args.push('--bail=1', '--testNamePattern', 'scenario=unchanged$|controlled sibling failure');
      closeConfirmed = false;
      const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS, { signal });
      closeConfirmed = result.closeConfirmed;
      if (signal.aborted && closeConfirmed) return;
      const observed = existsSync(events) ? readFileSync(events, 'utf8') : '';
      const output = `${result.stdout}\n${result.stderr}\nlifecycle: ${observed}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(output).toContain('controlled sibling failure');
      const outerCleanup = observed.split('\n').find(event => event.startsWith('outer-cleanup:'));
      if (drainBodies) expect(outerCleanup, output).toBe('outer-cleanup:pending=false:exists=false');
      expect(observed.replace(/^outer-cleanup:.*\n/m, ''), output).toBe(drainBodies
        ? 'allocated\ngit-ready\naborted\ngit-resume\ngit-settled\nfinally-enter\nseed-removed:exists=false\nteardown:pending=false:exists=false\nobserver-complete:exists=false\n'
        : 'allocated\ngit-ready\naborted\nteardown:pending=true:exists=true\ngit-resume\ngit-settled\nfinally-enter\nseed-removed:exists=false\nobserver-complete:exists=false\n');
      expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
    } finally {
      // Preserve an unconfirmed host instead of removing beneath a child.
      if (closeConfirmed) rmSync(host, { recursive: true, force: true });
    }
  }, RUN_CEILING_MS + 15000);
}
