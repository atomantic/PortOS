import { afterEach, expect, it as rawIt } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownTestBodies } from './mockPathsDataRoot.js';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from '../../scripts/lib/vitestTempRootFixture.js';

const owned = ownTestBodies(rawIt);
afterEach(() => owned.drain());
const helper = new URL('./gitTestRepo.js', import.meta.url).href;

// Unique regression: allocation has not returned its directory when a neighbor
// bails. Teardown releases that allocation, then must drain its real Git/copy
// work before removing the template. No wall-clock race selects the ordering.
for (const removalFailure of [false, true]) {
  owned.it(`settles template allocation on sibling bail (removal failure: ${removalFailure})`, async ({ signal }) => {
    const host = mkdtempSync(join(tmpdir(), 'git-template-lifecycle-'));
    let running;
    try {
      const ready = join(host, 'ready');
      const resultPath = join(host, 'result.json');
      writeFileSync(join(host, 'keep'), 'unrelated');
      const run = createVitestTempFixture(host, 'server', '');
      const root = run.args[run.args.indexOf('--root') + 1];
      writeFileSync(join(root, 'vitest.setup.js'), `import ${JSON.stringify(new URL('../vitest.setup.js', import.meta.url).href)};`);
      writeFileSync(join(root, 'neighbor.test.js'), fixtureReadyFailureSource(ready));
      writeFileSync(join(root, 'lifecycle.test.js'), `
        import { it, afterAll, vi } from 'vitest';
        import { writeFileSync, existsSync, rmSync } from 'node:fs';
        const state = vi.hoisted(() => ({ pending: null, template: null, active: 0, activeGit: 0, activeAtEntry: null }));
        vi.mock('fs/promises', async original => {
          const fs = await original();
          return { ...fs, mkdtemp: async prefix => {
            const dir = await fs.mkdtemp(prefix);
            if (String(prefix).includes('portos-git-template-')) {
              state.template = dir;
              writeFileSync(${JSON.stringify(ready)}, 'allocated before ownership returned');
              await new Promise(resolve => { globalThis.__releaseGitAllocation = resolve; });
            }
            return dir;
          }, rm: async (dir, options) => {
            if (${removalFailure} && dir === state.template) throw new Error('controlled template removal failure');
            return fs.rm(dir, options);
          } };
        });
        vi.mock(${JSON.stringify(new URL('./execGit.js', import.meta.url).href)}, async original => {
          const git = await original();
          return { ...git, execGit: async (...args) => {
            state.activeGit++;
            try { return await git.execGit(...args); }
            finally { state.activeGit--; }
          } };
        });
        import { makeGitSandbox, destroyGitSandbox } from ${JSON.stringify(helper)};
        it('owns interrupted allocation', async ({ signal }) => {
          state.active++;
          state.pending = makeGitSandbox().then(async box => {
            state.active--;
            await destroyGitSandbox(box.scratch);
          }, error => { state.active--; throw error; });
          await Promise.race([state.pending, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
        });
        let cleanupError;
        const cleanup = globalThis.__portosCleanupGitTemplates;
        if (cleanup) globalThis.__portosCleanupGitTemplates = async () => {
          state.activeAtEntry ??= state.active;
          const pending = cleanup();
          globalThis.__releaseGitAllocation?.();
          try { await pending; } catch (error) { cleanupError = error; throw error; }
        };
        afterAll(async () => {
          try { await globalThis.__portosCleanupGitTemplates?.(); } catch {}
          globalThis.__releaseGitAllocation?.();
          const error = cleanupError;
          const activeAtCleanup = state.active;
          await state.pending;
          writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
            activeAtEntry: state.activeAtEntry, activeAtCleanup, activeGit: state.activeGit,
            templateExists: existsSync(state.template),
            error: error?.errors?.[0]?.cause?.message,
          }));
          if (error) {
            // Preserve the failure verdict; allow the environment's retry to
            // remove this synthetic failed-removal fixture afterwards.
            rmSync(state.template, { recursive: true, force: true });
            throw error;
          }
        });
      `);
      run.args[run.args.indexOf('--maxWorkers') + 1] = '2';
      run.args.push('--bail=1');
      running = runFixtureToCompletion(run, undefined, { signal });
      const result = await running;
      const output = result.stdout + result.stderr;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(output).toContain('controlled sibling failure');
      expect(existsSync(resultPath), output).toBe(true);
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({
        activeAtEntry: 1, activeAtCleanup: 0, activeGit: 0, templateExists: removalFailure,
        ...(removalFailure ? { error: 'controlled template removal failure' } : {}),
      });
      if (removalFailure) expect(output).toContain('Git template teardown failed');
      else expect(output).not.toContain('test temp leak');
      expect(readFileSync(join(host, 'keep'), 'utf8')).toBe('unrelated');
      expect(readdirSync(host).filter(name => name.startsWith('pvt-'))).toEqual([]);
    } finally {
      await running;
      rmSync(host, { recursive: true, force: true });
    }
  });
}
