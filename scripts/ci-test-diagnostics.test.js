import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { collectTestDiagnostics } from './ci-test-diagnostics.js';
import { workflowJobs } from './lib/workflowJobs.js';

const launcher = new URL('./run-ci-tests.js', import.meta.url).href;
const reporter = new URL('./vitestRunDiagnostics.js', import.meta.url).href;

function fixture(abrupt) {
  const root = mkdtempSync(join(tmpdir(), 'ci-diagnostics-'));
  const reports = join(root, 'reports');
  mkdirSync(reports);
  const npmScript = join(root, 'npm.mjs');
  writeFileSync(npmScript, `
    import reporter from ${JSON.stringify(reporter)};
    import { writeFileSync } from 'node:fs';
    if (process.env.PORTOS_CI_DIAGNOSTICS_DIR) throw Error('nested launcher inherited durable ownership');
    const hooks = reporter();
    hooks.onInit({ onClose() {} });
    hooks.onTestModuleQueued?.({ moduleId: 'server/lib/synthetic.test.js' });
    if (${abrupt}) {
      // Only this fixture's known launcher PID; no process discovery or live jobs.
      process.kill(Number(process.env.FIXTURE_LAUNCHER_PID), 'SIGKILL');
    } else {
      hooks.onTestModuleEnd?.({ moduleId: 'server/lib/synthetic.test.js' });
      hooks.onTestRunEnd([], [], 'failed');
      const output = process.argv.find(arg => arg.startsWith('--outputFile.json=')).split('=').slice(1).join('=');
      writeFileSync(output, JSON.stringify({ testResults: [{
        name: 'server/lib/synthetic.test.js', status: 'failed', assertionResults: [],
        message: 'example-private-message C:/Users/example-private/secret',
      }] }));
    }
    process.exitCode = 17;
  `);
  writeFileSync(join(root, 'npm'), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(npmScript).href)});`, { mode: 0o755 });
  writeFileSync(join(root, 'npm.cmd'), `@"${process.execPath}" "${npmScript}" %*\r\n`);
  return { root, reports };
}

async function launchAndCollect(abrupt) {
  const { root, reports } = fixture(abrupt);
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runNpm } from ${JSON.stringify(launcher)};
      process.env.FIXTURE_LAUNCHER_PID = String(process.pid);
      process.exitCode = (await runNpm('server', 'test:ci', ['./lib/synthetic.test.js'])).status;
    `], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`,
        TMPDIR: root, TMP: root, TEMP: root, NODE_DISABLE_COMPILE_CACHE: '1',
        PORTOS_CI_DIAGNOSTICS_DIR: reports, GITHUB_STEP_SUMMARY: '', GITHUB_ENV: '' },
    });
    expect(result.error).toBeUndefined();
    if (abrupt) expect(result.signal === 'SIGKILL' || result.status !== 0).toBe(true);
    else expect(result.status, result.stderr).toBe(17);
    const attempts = readdirSync(reports);
    expect(attempts).toHaveLength(1);
    const invocation = JSON.parse(readFileSync(join(reports, attempts[0], 'invocation.json'), 'utf8'));
    expect(invocation.completed).toBe(!abrupt);
    const options = { diagnose: vi.fn(), logger: { warn: vi.fn() }, writeSummary: vi.fn() };
    await collectTestDiagnostics(reports, options);
    const output = options.writeSummary.mock.calls[0][0];
    expect(output).toContain('server/lib/synthetic.test.js');
    expect(output).not.toMatch(/example-private|Users|secret/);
    expect(options.diagnose).toHaveBeenCalledWith(invocation.startedAt);
    return output;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('independent CI test failure recovery (#11552)', () => {
  it('recovers a failed launcher result after its normal report callback', async () => {
    const output = await launchAndCollect(false);
    expect(output).toContain('Launcher completed; exit=17');
    expect(output).toContain('reason=failed; completed=1');
    expect(output).toContain('Failed suites (up to 10): server/lib/synthetic.test.js');
  });

  it('recovers an unfinished module after abrupt launcher death without claiming a test failure cause', async () => {
    const output = await launchAndCollect(true);
    expect(output).toContain('Launcher interrupted or completion not recorded; exit=unavailable');
    expect(output).toContain('reason=not-finished; completed=0');
    expect(output).toContain('structured test report missing');
  });

  it('keeps unavailable and invalid reports inconclusive even when summary and native collection fail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-diagnostics-invalid-'));
    try {
      const attempt = join(root, 'portos-vitest-fixture');
      mkdirSync(attempt);
      writeFileSync(join(attempt, 'invocation.json'), '{');
      writeFileSync(join(attempt, 'run.json'), JSON.stringify({ reason: 'passed', activeModules: [] }));
      writeFileSync(join(attempt, 'failures.json'), '{}');
      const logger = { warn: vi.fn() };
      const lines = await collectTestDiagnostics(root, { logger,
        diagnose: async () => { throw Error('example-private'); },
        writeSummary: () => { throw Error('example-private'); },
      });
      expect(lines.join('\n')).toContain('launcher completion is unverified');
      expect(lines.join('\n')).toContain('active test file is unknown');
      expect(lines.join('\n')).toContain('Inconclusive failure');
      expect(logger.warn.mock.calls.flat().join('\n')).not.toContain('example-private');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['windows-server', 'Run server tests on Windows', 'Preserve Windows test failure diagnostics', 'run-ci-tests.js'],
  ])('%s collects after failure and before sibling cancellation with bounded, non-masking failure handling', (jobId, testName, collectorName, launcherName) => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const job = workflowJobs(workflow)[jobId];
    const start = job.indexOf(`      - name: ${collectorName}`);
    expect(start).toBeGreaterThan(job.indexOf(`run: node scripts/${launcherName} server`));
    const end = job.indexOf('      - name: Report the failure, then cancel sibling CI jobs');
    expect(end).toBeGreaterThan(start);
    const step = job.slice(start, end);
    expect(step).toContain('if: failure()');
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('timeout-minutes: 1');
    expect(step).toContain('run: node scripts/ci-test-diagnostics.js');
    const testStep = job.slice(job.indexOf(`- name: ${testName}`), start);
    const durable = 'PORTOS_CI_DIAGNOSTICS_DIR: ${{ runner.temp }}/portos-ci-diagnostics';
    expect(testStep).toContain(durable);
    expect(step).toContain(durable);
    const testMinutes = Number(testStep.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    const jobMinutes = Number(job.match(/^    timeout-minutes:\s*(\d+)/m)?.[1]);
    expect(testMinutes).toBeGreaterThan(0);
    expect(testMinutes).toBeLessThan(jobMinutes - 1);
    expect(testStep).not.toContain('continue-on-error');
    expect(job.slice(end)).toContain("if: failure() && github.event_name == 'pull_request'");
  });
});
