// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runFixtureToCompletion } from '../../../scripts/lib/vitestTempRootFixture.js';

// The candidate runner sits outside the client project root. Vitest's normal
// in-process transport can bypass Vite's filesystem check, hiding a hosted
// multi-worker failure. Exercise the real config with that check enabled.
it('runs the candidate runner under strict filesystem checks with two workers', async ({ task, signal }) => {
  expect(task.file.projectName).toBe('capture');
  const clientRoot = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(clientRoot, '.cache'), { recursive: true });
  const fixture = mkdtempSync(join(clientRoot, '.cache', 'candidate-runner-'));
  let settled = true;
  try {
    const temp = join(fixture, 'tmp');
    mkdirSync(temp);
    const files = Array.from({ length: 12 }, (_, index) => {
      const file = join(fixture, `case-${index}.test.js`);
      writeFileSync(file, `import { test, expect } from 'vitest'; test('case ${index}', () => expect(${index}).toBe(${index}));\n`);
      return relative(clientRoot, file).replaceAll('\\', '/');
    });
    const selection = join(fixture, 'selection.json');
    writeFileSync(selection, JSON.stringify({ include: files, exclude: [] }));
    const program = `
      import assert from 'node:assert/strict';
      import { createVitest } from 'vitest/node';
      import { isFileLoadingAllowed, normalizePath } from 'vite';
      const ctx = await createVitest('test', { config: 'vitest.config.js', configLoader: 'runner', watch: false, maxWorkers: 2, fsModuleCache: false });
      try {
        assert.ok(ctx.projects.some(project => project.name === 'parallel'));
        for (const project of ctx.projects) {
          const runner = normalizePath(project.config.runner);
          if (project.name === 'parallel') assert.equal(project.config.maxWorkers, 2);
          assert.equal(project.vite.config.server.fs.strict, true);
          assert.equal(isFileLoadingAllowed(project.vite.config, runner), true, 'candidate runner must be permitted by Vite');
          assert.equal(isFileLoadingAllowed(project.vite.config, normalizePath(project.vite.config.root) + '/src/test/setup.js'), true);
          assert.equal(isFileLoadingAllowed(project.vite.config, runner.replace(/vitestCandidateRunner\\.js$/, 'unlisted-private-file.js')), false);
          const environment = project.vite.environments.__vitest__;
          const skipped = environment._skipFsCheck;
          environment._skipFsCheck = false;
          const url = runner.startsWith('/') ? '/@fs' + runner : '/@fs/' + runner;
          assert.ok(await environment.transformRequest(url));
          environment._skipFsCheck = skipped;
        }
        await ctx.start();
        const files = ctx.state.getFiles();
        assert.equal(files.length, 12);
        assert.ok(files.every(file => file.result?.state === 'pass'));
        assert.equal(ctx.state.getUnhandledErrors().length, 0);
      } finally { await ctx.close(); }
    `;
    const result = await runFixtureToCompletion({ args: ['--input-type=module', '-e', program], options: {
      cwd: clientRoot,
      env: { ...process.env, CI: 'true', TMPDIR: temp, TMP: temp, TEMP: temp, PORTOS_CI_COLLECTION: '1', PORTOS_CI_TEST_SELECTION: selection,
        PORTOS_TEST_TEMP_ROOT: '', PORTOS_TEST_MEMO_DIR: '', PORTOS_CI_DIAGNOSTICS_DIR: '', PORTOS_CI_DIAGNOSTICS_PATH: '',
        PORTOS_TEST_PROCESS_DIAGNOSTICS_PATH: '', VITEST_POOL_ID: '', VITEST_WORKER_ID: '' },
    } }, undefined, { signal });
    settled = result.closeConfirmed;
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  } finally {
    if (settled) rmSync(fixture, { recursive: true, force: true });
  }
});
