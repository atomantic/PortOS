import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ciTestBail, releaseCandidateDiagnostics } from './ciTestPolicy.js';
import { workflowJobs } from './lib/workflowJobs.js';
import { spawnNpm } from './run-ci-tests.js';

const policyEnv = {
  PORTOS_CI_TEST_POLICY: 'release-candidate', GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_BASE_REF: 'release', GITHUB_HEAD_REF: 'codex/release-2.105.1',
  GITHUB_REPOSITORY: 'example/project', PORTOS_CI_HEAD_REPOSITORY: 'example/project',
  PORTOS_CI_CANDIDATE_HEAD: 'a'.repeat(40),
};
const launcher = new URL('./run-ci-tests.js', import.meta.url).href;

// Each invocation owns its fixture and durable reports; real Vitest/npm prove
// the policy across the public launcher boundary without production sleeps.
function launch(body, { policy = true, extraReporter, cancel = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-policy-'));
  try {
    writeFileSync(join(root, 'fixture.test.js'), body);
    writeFileSync(join(root, 'config.mjs'), `import { ciTestConfig } from ${JSON.stringify(new URL('./ciTestPolicy.js', import.meta.url).href)}; export default { test: { ...ciTestConfig(), globals: true, maxWorkers: 1, fileParallelism: false } };`);
    const args = ['--config', join(root, 'config.mjs'), '--root', root, './fixture.test.js'];
    if (extraReporter) {
      writeFileSync(join(root, 'extra.mjs'), extraReporter);
      args.push(`--reporter=${join(root, 'extra.mjs')}`);
    }
    const env = { ...process.env, GITHUB_ACTIONS: '', NODE_ENV: 'test', PORTOS_CI_TEST_POLICY: '', PORTOS_CI_COLLECTION: '',
      PORTOS_CI_TEST_SELECTION: '', PORTOS_TEST_TEMP_ROOT: '', PORTOS_TEST_MEMO_DIR: '',
      PORTOS_CI_DIAGNOSTICS_DIR: join(root, 'reports'), GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '',
      ...(policy ? policyEnv : {}) };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runNpm } from ${JSON.stringify(launcher)};
      import { watchFile, unwatchFile } from 'node:fs';
      const controller = new AbortController();
      ${cancel ? `watchFile(${JSON.stringify(join(root, 'ready'))}, { interval: 10 }, () => controller.abort());` : ''}
      const result = await runNpm('server', 'test:ci', ${JSON.stringify(args)}, { signal: controller.signal });
      ${cancel ? `unwatchFile(${JSON.stringify(join(root, 'ready'))});` : ''}
      console.log('RESULT=' + JSON.stringify(result));
      process.exitCode = result.status;
    `], { env, encoding: 'utf8', timeout: 20000 });
    expect(result.error, result.stderr).toBeUndefined();
    const dir = join(root, 'reports', readdirSync(join(root, 'reports'))[0]);
    const read = name => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; } };
    return { ...result, run: read('run.json'), invocation: read('invocation.json'), report: read('failures.json') };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('release-only assertion collection (#13759)', () => {
  it('keeps the ordinary one-failure default and bounds candidate collection at five', () => {
    const body = `for (let i = 0; i < 8; i++) test('independent ' + i, () => expect(i).toBe(-1));`;
    const ordinary = launch(body, { policy: false });
    expect(ordinary.status, ordinary.stderr).toBe(1);
    expect(ordinary.report.numFailedTests).toBe(1);
    const candidate = launch(body);
    expect(candidate.status, candidate.stderr).toBe(1);
    expect(candidate.report, candidate.stderr).not.toBeNull();
    expect(candidate.report.numFailedTests).toBe(5);
    expect(candidate.run.collection).toMatchObject({ limit: 5, stop: 'assertion-limit', coverage: 'unverified' });
    expect(candidate.run.collection.failures).toHaveLength(5);
    expect(candidate.run.collection.failures[0].name).toContain('independent 0');
    expect(candidate.invocation).toMatchObject({ policy: 'release-candidate', assertionLimit: 5,
      candidate: { head: 'a'.repeat(40), selectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  }, 45000);

  it('keeps a genuinely complete candidate green with verified run evidence', () => {
    const result = launch(`test('control', () => expect(1).toBe(1));`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.run.collection).toEqual({ limit: 5, failures: [], stop: null, coverage: 'complete' });
    const record = result.stdout.split('\n').find(line => line.startsWith('RESULT='));
    expect(JSON.parse(record.slice(7))).toMatchObject({ status: 0, runReport: { reason: 'passed', errorCount: 0 } });
  }, 25000);

  it('bounds concurrent collection and refuses explicit test retries', () => {
    const concurrent = launch(`for (let i=0;i<12;i++) test.concurrent('concurrent '+i, () => expect(i).toBe(-1));`);
    expect(concurrent.status, concurrent.stderr).not.toBe(0);
    expect(concurrent.run.collection.failures).toHaveLength(5);
    expect(concurrent.run.collection).toMatchObject({ stop: 'assertion-limit', coverage: 'unverified' });
    const retry = launch(`let attempt=0; test('retry forbidden', { retry: 2 }, () => expect(++attempt).toBe(3));`);
    expect(retry.status, retry.stderr).not.toBe(0);
    expect(retry.report.numFailedTests).toBe(1);
    expect(retry.run.collection.failures).toHaveLength(1);
  }, 45000);

  it.each([
    ['unknown test error', `test('unsafe', () => { throw Error('fixture settlement refused'); });`],
    ['hook assertion', `afterEach(() => expect(true).toBe(false)); test('unsafe', () => {});`],
    ['unhandled rejection', `test('unsafe', async () => { Promise.reject(Error('first cause')); await new Promise(setImmediate); });`],
    ['native worker exit', `test('unsafe', () => process.exit(86));`],
  ])('stops safe collection on %s and never calls later noise independent', (_name, body) => {
    const result = launch(`${body}\nfor (let i=0;i<8;i++) test('later noise '+i, () => expect(1).toBe(2));`);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.run, result.stderr).not.toBeNull();
    expect(result.run.collection.coverage).toBe('unverified');
    // A failed hook/worker can be reported after already-running work. Its
    // assertion list never promotes errors emitted after an unsafe stop.
    expect(result.run.collection.stop).toBe('unsafe');
    expect(result.run.collection.failures).toHaveLength(0);
    expect(result.invocation.completed).toBe(true);
    expect(result.stderr).toMatch(/unsafe|refused|first cause|unexpectedly|exit code/i);
  }, 25000);

  it('rejects a zero exit with malformed final evidence', () => {
    const result = launch(`test('control', () => {});`, { extraReporter: `import { writeFileSync } from 'node:fs';
      export default function () { return { onInit(v) { v.onClose(() => { process.once('exit', () => writeFileSync(process.env.PORTOS_CI_DIAGNOSTICS_PATH, '{}')); }); } }; }` });
    expect(result.status, result.stderr).not.toBe(0);
    expect([0, 143]).toContain(result.invocation.status);
    expect(result.run).toEqual({});
  }, 25000);

  it('preserves external cancellation without coverage or memo evidence', () => {
    const result = launch(`import { writeFileSync } from 'node:fs'; test('blocked', async () => {
      writeFileSync(new URL('./ready', import.meta.url), 'ready'); await new Promise(() => {});
    });`, { cancel: true });
    expect(result.status, result.stderr).toBe(143);
    expect(result.invocation.signal).toBe('SIGTERM');
    expect(result.run?.collection.coverage).not.toBe('complete');
    const record = result.stdout.split('\n').find(line => line.startsWith('RESULT='));
    expect(JSON.parse(record.slice(7))).toMatchObject({ fileResults: [], runReport: null });
  }, 25000);

  it('retains a late process-settlement refusal after passing assertions', () => {
    const result = launch(`test('passing control', () => {});`, { extraReporter: `import { writeFileSync } from 'node:fs';
      import { join, dirname } from 'node:path'; export default function () { return { onInit(v) { v.onClose(() => {
        writeFileSync(join(dirname(process.env.PORTOS_CI_DIAGNOSTICS_PATH), 'processes.json'), JSON.stringify({ outcomes: [{ settled: false, reason: 'fixture settlement refused' }] }));
        throw Error('fixture settlement refused');
      }); } }; }` });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('fixture settlement refused');
    expect(result.report.numPassedTests).toBe(1);
    const record = result.stdout.split('\n').find(line => line.startsWith('RESULT='));
    expect(JSON.parse(record.slice(7))).toMatchObject({ fileResults: [], runReport: null, diagnosticsPath: expect.any(String) });
  }, 25000);

  it('opts in only frozen release PRs and retains evidence from each existing test job', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(workflow).toContain("github.base_ref == 'release' && startsWith(github.head_ref, 'codex/release-')");
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    const jobs = workflowJobs(workflow);
    for (const job of ['server', 'client', 'database', 'browser', 'windows-server']) {
      expect(jobs[job]).toContain("if: always() && env.PORTOS_CI_TEST_POLICY == 'release-candidate'");
      expect(jobs[job]).toMatch(/PORTOS_CI_DIAGNOSTICS_DIR:.*portos-ci-diagnostics/);
      expect(jobs[job]).toContain('portos-vitest-*/invocation.json');
    }
  });

  it('retains ordinary local defaults and rejects out-of-scope opt-ins', () => {
    expect(ciTestBail({ npm_lifecycle_event: 'test:ci' })).toBe(1);
    expect(ciTestBail({ npm_lifecycle_event: 'test:db:ci' })).toBe(1);
    expect(ciTestBail({ npm_lifecycle_event: 'test' })).toBeUndefined();
    expect(releaseCandidateDiagnostics({})).toBe(false);
    expect(releaseCandidateDiagnostics({ ...policyEnv, GITHUB_HEAD_REF: 'codex/release-1/fix' })).toBe(true);
    expect(releaseCandidateDiagnostics({ ...policyEnv, GITHUB_HEAD_REF: 'codex/release-' })).toBe(true);
    for (const patch of [{ GITHUB_BASE_REF: 'main' }, { GITHUB_EVENT_NAME: 'schedule' },
      { GITHUB_HEAD_REF: 'ordinary-feature' }, { PORTOS_CI_HEAD_REPOSITORY: 'other/fork' }]) {
      expect(() => releaseCandidateDiagnostics({ ...policyEnv, ...patch })).toThrow(/frozen candidate/);
    }
  });

  it('does not retry a candidate native crash into green', async () => {
    for (const [key, value] of Object.entries(policyEnv)) vi.stubEnv(key, value);
    try {
      const run = vi.fn().mockResolvedValue({ status: 1, output: 'Worker exited unexpectedly with exit code 86 while running test file /repo/server/crash.test.js' });
      expect(await spawnNpm('server', 'test:ci', [], 'candidate', { run })).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });
});
