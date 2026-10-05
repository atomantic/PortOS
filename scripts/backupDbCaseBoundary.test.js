import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVitestTempFixture } from './lib/vitestTempRootFixture.js';

const ownTestBodiesUrl = new URL('../server/lib/mockPathsDataRoot.js', import.meta.url).href;

// Pins the regression uniquely (#10272): a case that TIMES OUT while it is
// between restores — after one settled, before its next one starts — must not
// overlap the following case. Draining only in-flight restore promises (the
// former server/services/backup.db.test.js lifecycle) finds nothing pending at
// that moment and lets the next case in; owning the whole body does not. The
// timed-out body is held at that gap deterministically: it resumes only when
// the next case's body releases it, or on a fallback timer when that body is
// (correctly) still gated.
it('keeps a timed-out case between restores from overlapping the next case', () => {
  const host = mkdtempSync(join(tmpdir(), 'restore-boundary-'));
  try {
    const fixture = join(host, 'fixture');
    const resultsPath = join(fixture, 'results.json');
    const { args, options } = createVitestTempFixture(host, 'server', '');
    writeFileSync(join(fixture, 'boundary.test.js'), `
      import { afterAll, beforeEach, describe, it as vitestIt } from 'vitest';
      import { writeFileSync } from 'node:fs';
      import { ownTestBodies } from ${JSON.stringify(ownTestBodiesUrl)};

      const results = {};
      afterAll(() => writeFileSync(${JSON.stringify(resultsPath)}, JSON.stringify(results)));
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      function lifecycleCases(label, caseIt, track = work => work) {
        const state = { settled: false, restoreActive: false, overlapped: false };
        let release;
        const released = new Promise(resolve => { release = resolve; });
        const restore = () => track((async () => {
          state.restoreActive = true;
          await wait(20);
          state.restoreActive = false;
        })());
        caseIt('times out between restores', async ({ signal }) => {
          await restore();
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          await Promise.race([released, wait(300)]);
          await restore();
          state.settled = true;
        }, 50);
        caseIt('next case', async () => {
          results[label] = { previousSettledAtStart: state.settled };
          release();
          for (let i = 0; i < 10; i += 1) {
            if (state.restoreActive) state.overlapped = true;
            await wait(10);
          }
          results[label].overlapped = state.overlapped;
        });
      }

      describe('restore-promise drain', () => {
        const pendingRestores = new Set();
        const track = async pending => {
          pendingRestores.add(pending);
          try { return await pending; } finally { pendingRestores.delete(pending); }
        };
        beforeEach(() => Promise.all([...pendingRestores]));
        lifecycleCases('restoreSet', vitestIt, track);
      });

      describe('owned body drain', () => {
        const owned = ownTestBodies(vitestIt);
        beforeEach(() => owned.drain());
        lifecycleCases('owned', owned.it);
      });
    `);
    // CI's github-actions reporter repeats each failure as an annotation; the
    // fixture's own default-reporter output is what the assertions count.
    delete options.env.GITHUB_ACTIONS;
    const result = spawnSync(process.execPath, args, options);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output.match(/Test timed out in 50ms/g), output).toHaveLength(2);
    const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    // Negative control: the restore-only drain admits the next case early.
    expect(results.restoreSet).toEqual({ previousSettledAtStart: false, overlapped: true });
    expect(results.owned).toEqual({ previousSettledAtStart: true, overlapped: false });
    expect(output).not.toMatch(/Unhandled|Cancelled test body failed/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, 25000);
