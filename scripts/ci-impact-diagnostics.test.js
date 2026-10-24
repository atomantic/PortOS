import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPACT_STAGES, observeImpactStage, reportImpactSettlement, scanImpactOwners } from './ci-impact-diagnostics.js';
import { workflowJobs } from './lib/workflowJobs.js';

const roots = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), 'impact-diagnostics-'));
  roots.push(dir);
  return dir;
};
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const launcher = fileURLToPath(new URL('./ci-impact-diagnostics.js', import.meta.url));

it('preserves command output, failure status, and GitHub command files through the actual CLI', () => {
  const dir = root();
  const output = join(dir, 'output');
  const result = spawnSync(process.execPath, [launcher, 'plan', '--', process.execPath, '-e', `
    require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, 'server_files=["example.test.js"]\\n');
    console.log('original-output'); process.exitCode = 17;
  `], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PORTOS_CI_IMPACT_DIAGNOSTICS: dir, GITHUB_OUTPUT: output } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(17);
  expect(result.stdout).toContain('original-output');
  expect(readFileSync(output, 'utf8')).toBe('server_files=["example.test.js"]\n');
  const record = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  expect(record).toMatchObject({ stage: 'plan', exit: { code: 17 }, close: { code: 17 } });
  expect(record.exit.elapsedMs).toBeLessThanOrEqual(record.close.elapsedMs);
  expect(result.stdout).not.toContain(record.token);
});

it('retains interrupted and missing evidence as unknown, and redacts persisted untrusted metadata', () => {
  const dir = root();
  const token = randomUUID();
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({
    stage: 'plan', token, exit: { code: 0 }, close: null,
    privatePath: '/home/example-private/secret', rawCommand: 'SECRET_SENTINEL',
  }));
  writeFileSync(join(dir, 'syntax.json'), '{broken');
  const lines = [];
  const summaries = [];
  reportImpactSettlement(dir, {
    scan: () => ({ coverage: 'partial', counts: {} }),
    log: line => lines.push(line), summary: text => summaries.push(text),
  });
  const rows = lines.map(line => JSON.parse(line.slice('CI impact '.length)));
  expect(rows.find(row => row.stage === 'plan')).toMatchObject({ recorded: true, exit: 0, close: null, owned: null, coverage: 'partial' });
  expect(rows.find(row => row.stage === 'syntax')).toMatchObject({ recorded: false, owned: null, coverage: 'unavailable' });
  const publicText = [...lines, ...summaries].join('\n');
  for (const secret of [token, '/home/example-private', 'SECRET_SENTINEL']) expect(publicText).not.toContain(secret);
});

it('does not turn a spawn failure or signal into a successful command', async () => {
  const dir = root();
  const lines = [];
  const options = { root: dir, log: line => lines.push(line) };
  const missing = await observeImpactStage('plan', join(dir, 'missing'), [], options);
  expect(missing).toEqual({ code: null, signal: null });
  expect(lines.some(line => line.includes('spawn-error'))).toBe(true);
  const result = spawnSync(process.execPath, [launcher, 'syntax', '--', process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PORTOS_CI_IMPACT_DIAGNOSTICS: dir },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
});

describe('ownership snapshot', () => {
  it('matches an exact inherited nonce, excludes zombies/unrelated work, and reports unreadable scans', () => {
    const dir = root();
    const token = randomUUID();
    const put = (pid, env, state = 'S') => {
      const path = join(dir, String(pid));
      mkdirSync(path);
      writeFileSync(join(path, 'stat'), `${pid} (private command) ${state} ${Array(18).fill('0').join(' ')} 123 0 0\n`);
      writeFileSync(join(path, 'environ'), env);
    };
    put(1, `SECRET_SENTINEL=x\0PORTOS_CI_IMPACT_OWNER=${token}\0`);
    put(2, `PORTOS_CI_IMPACT_OWNER=${randomUUID()}\0`);
    put(3, `PORTOS_CI_IMPACT_OWNER=${token}\0`, 'Z');
    put(4, `OTHER_PORTOS_CI_IMPACT_OWNER=${token}\0`);
    const options = { procRoot: dir, platform: 'linux', uid: statSync(dir).uid };
    expect(scanImpactOwners([token], options)).toEqual({ coverage: 'complete', counts: { [token]: 1 } });
    expect(scanImpactOwners([token], { ...options, budgetMs: -1 }).coverage).toBe('partial');
    expect(scanImpactOwners([token], { ...options, procRoot: join(dir, 'missing') })).toEqual({ coverage: 'unavailable', counts: {} });
    expect(scanImpactOwners([token], { ...options, platform: 'darwin' }).coverage).toBe('unavailable');
  });

  // A successful direct exit must not hide a reparented descendant. The
  // fixture settles only its own socket-controlled child; no process is killed.
  it.skipIf(process.platform !== 'linux')('detects owned work surviving its stage, then its real settlement', async () => {
    const dir = root();
    const socket = join(dir, 'owned.sock');
    const worker = `
      const server = require('node:net').createServer(connection => {
        connection.end(); server.close();
      });
      server.listen(${JSON.stringify(socket)}, () => process.send('ready'));
    `;
    const parent = `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env,
      });
      child.once('message', () => { child.disconnect(); child.unref(); });
    `;
    try {
      const result = await observeImpactStage('plan', process.execPath, ['-e', parent], { root: dir, log: () => {} });
      expect(result).toEqual({ code: 0, signal: null });
      const record = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
      expect(record.ownedAfterClose.count).toBe(1);
      const lines = [];
      reportImpactSettlement(dir, { log: line => lines.push(line), summary: () => {} });
      expect(lines.find(line => line.includes('"stage":"plan"'))).toContain('"owned":1');
    } finally {
      await new Promise((resolve, reject) => {
        const connection = connect(socket);
        connection.once('error', reject);
        connection.once('close', resolve);
        connection.resume();
      });
    }
    const record = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    let snapshot;
    const deadline = Date.now() + 5000;
    do {
      snapshot = scanImpactOwners([record.token]);
      if (snapshot.counts[record.token] === 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    expect(snapshot.counts[record.token]).toBe(0);
  });
});

it('observes every repository stage before runner finalization while retaining the existing deadline and gate', () => {
  const jobs = workflowJobs(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  for (const stage of IMPACT_STAGES) expect(jobs.impact).toContain(`node scripts/ci-impact-diagnostics.js ${stage} -- `);
  expect(jobs.impact).toMatch(/timeout-minutes: 10\n/);
  expect(jobs.impact).toContain('if: always()\n        run: node scripts/ci-impact-diagnostics.js settlement');
  expect(jobs.impact).not.toMatch(/continue-on-error/);
  expect(jobs.gate).toContain('CI_GATE_RESULT_IMPACT: ${{ needs.impact.result }}');
  // Exercise both actual heredoc scripts; a malformed delimiter can silently
  // swallow a shell command or change which GitHub outputs reach later jobs.
  if (process.platform === 'win32') return;
  const dir = root();
  for (const stage of ['node-minimum', 'summary']) {
    const script = jobs.impact.match(new RegExp(`          (node scripts/ci-impact-diagnostics\\.js ${stage} -- [^\\n]+\\n[\\s\\S]*?          PORTOS_IMPACT_SCRIPT)\\n`))?.[1];
    expect(script, stage).toBeTruthy();
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-s'], {
      input: script.split('\n').map(line => line.slice(line.startsWith('          ') ? 10 : 0)).join('\n'),
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CI_EVENT: 'workflow_dispatch', PORTOS_CI_IMPACT_DIAGNOSTICS: dir,
        GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') },
    });
    expect(result.status, result.stderr).toBe(0);
  }
  expect(readFileSync(join(dir, 'output'), 'utf8')).toBe('run=true\n');
  expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('### CI impact plan');
});
