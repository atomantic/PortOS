import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Uniquely catches diagnostics lost by a runner timeout or quiet CI reporting,
// and proves observation neither replaces the original error nor waits on Chrome.
it('retains bounded phase evidence with the original failure before suite teardown', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-phase-contract-'));
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const api = fileURLToPath(new URL('../node_modules/vitest/dist/index.js', import.meta.url));
  const diagnostics = fileURLToPath(new URL('./testPhaseDiagnostics.js', import.meta.url));
  const report = join(root, 'report.json');
  const cleanup = join(root, 'cleanup.json');
  try {
    writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: { maxWorkers: 1, fileParallelism: false } };');
    writeFileSync(join(root, 'phases.test.mjs'), `
      import { it, afterAll } from ${JSON.stringify(api)};
      import { writeFileSync } from 'node:fs';
      import { createTestPhaseDiagnostics } from ${JSON.stringify(diagnostics)};
      const observed = [];
      const observe = context => createTestPhaseDiagnostics(callback => context.onTestFailed(result => {
        callback(result);
        observed.push(result.task.result.errors.map(error => error.message));
      }));
      it('stalled screenshot', async context => {
        const phase = observe(context);
        for (let i = 0; i < 30; i++) await phase('capture-ready', () => undefined);
        await phase('capture-screenshot', () => new Promise(() => {}));
      }, 40);
      it('rejected upload', async context => {
        const phase = observe(context);
        await phase('capture-upload-or-error', () => { throw new Error('original synthetic failure'); });
      });
      afterAll(() => writeFileSync(${JSON.stringify(cleanup)}, JSON.stringify(observed)));
    `);
    const env = { ...process.env, NODE_ENV: 'test', NODE_DISABLE_COMPILE_CACHE: '1' };
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    const result = spawnSync(process.execPath, [vitest, 'run', '--configLoader', 'native', '--root', root,
      '--config', join(root, 'vitest.config.mjs'), '--silent', '--reporter=json', '--outputFile', report],
    { env, encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const failures = JSON.parse(readFileSync(report, 'utf8')).testResults[0].assertionResults;
    expect(failures.map(test => test.status)).toEqual(['failed', 'failed']);
    expect(failures[0].failureMessages.join('\n')).toContain('Test timed out in 40ms');
    expect(failures[0].failureMessages.join('\n')).toContain('active=capture-screenshot');
    expect(failures[1].failureMessages.join('\n')).toContain('original synthetic failure');
    expect(failures[1].failureMessages.join('\n')).toContain('active=capture-upload-or-error');
    const observed = JSON.parse(readFileSync(cleanup, 'utf8'));
    expect(observed).toHaveLength(2);
    expect(observed[0][0]).toContain('capture-screenshot:start@');
    expect(observed[0][0].split('recent=')[1].split(',')).toHaveLength(24);
    expect(observed[1][0]).toContain('capture-upload-or-error:failed@');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
