import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareEvidence, superviseEvidence, startEvidence, snapshotEvidence, finishEvidence } from './browser-ci-evidence.js';
import { workflowJobs } from './lib/workflowJobs.js';

const script = fileURLToPath(new URL('./browser-ci-evidence.js', import.meta.url));
const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'browser-evidence-test-')); roots.push(parent);
  const env = { RUNNER_TEMP: parent, GITHUB_SHA: 'b'.repeat(40), CI_PR_HEAD: 'a'.repeat(40), GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'database', PORTOS_BROWSER_TEST_PROFILE: 'smoke',
    CI_TEST_FILES: '["server/services/musicVideo/documentRender.browser.test.js"]', TOKEN: 'example-private-secret' };
  const exec = command => command === 'git' ? 'b'.repeat(40) : command === 'google-chrome' ? 'Google Chrome 155.0.8059.80' : 'ffmpeg version 9.0.2';
  const { root, path } = prepareEvidence(env, exec);
  const config = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
  return { root, path, env, exec, config };
}
function state(root, config, status) {
  const started = { nonce: config.nonce, pid: process.pid, startedAt: Date.now() };
  writeFileSync(join(root, 'started.json'), JSON.stringify(started));
  if (status !== undefined) writeFileSync(join(root, 'verdict.json'), JSON.stringify({ ...started, status, completedAt: Date.now() }));
  return started;
}
async function untilFile(path) {
  const until = Date.now() + 2000;
  while (!existsSync(path) && Date.now() < until) await delay(10);
  expect(existsSync(path)).toBe(true);
}

describe('durable browser evidence lifecycle', () => {
  it('requires parent acknowledgement before tests launch and preserves failure/timeout verdicts', async () => {
    for (const status of [0, 17, 124]) {
      const { root } = fixture();
      const watch = vi.fn(async () => status);
      const running = superviseEvidence(root, watch);
      await untilFile(join(root, 'started.json'));
      expect(watch).not.toHaveBeenCalled();
      writeFileSync(join(root, 'ack.json'), readFileSync(join(root, 'started.json')));
      expect(await running).toBe(status);
      expect(watch).toHaveBeenCalledOnce();
      expect(watch.mock.calls[0][1].deadlineMs).toBe(720000);
      const verdict = JSON.parse(readFileSync(join(root, 'verdict.json'), 'utf8'));
      expect(verdict.status).toBe(status);
      expect(await finishEvidence(root, ['success', 'failure'])).toBe(status || 1);
    }
  });

  it('fails closed without an acknowledgement and when cleanup throws', async () => {
    const first = fixture(), watch = vi.fn();
    expect(await superviseEvidence(first.root, watch, { ackMs: 1 })).toBe(1);
    expect(watch).not.toHaveBeenCalled();
    const second = fixture();
    const failed = superviseEvidence(second.root, async () => { throw Error('example-private-secret'); });
    await untilFile(join(second.root, 'started.json'));
    writeFileSync(join(second.root, 'ack.json'), readFileSync(join(second.root, 'started.json')));
    expect(await failed).toBe(1);
    expect(await finishEvidence(second.root, ['success'])).toBe(1);
  });

  it('handshakes across processes and retires a rejected startup without launching its payload', async () => {
    vi.stubEnv('RUNNER_TRACKING_ID', 'synthetic-tracking-id');
    for (const mismatch of [false, true]) {
      const { root } = fixture();
      const executable = join(root, 'synthetic.mjs');
      writeFileSync(executable, `
        import { readFileSync, writeFileSync, existsSync } from 'node:fs';
        import { join } from 'node:path';
        const root = process.argv[3];
        const { nonce } = JSON.parse(readFileSync(join(root, 'control.json')));
        const state = { nonce: ${mismatch} ? '0'.repeat(32) : nonce, pid: process.pid, startedAt: Date.now() };
        writeFileSync(join(root, 'started.json'), JSON.stringify(state));
        const deadline = setTimeout(() => { clearInterval(timer); process.exitCode = 1; }, 1500);
        const timer = setInterval(() => {
          if (!existsSync(root)) { clearInterval(timer); clearTimeout(deadline); return; }
          if (!existsSync(join(root, 'ack.json'))) return;
          clearInterval(timer); clearTimeout(deadline);
          writeFileSync(join(root, 'payload-started'), process.env.RUNNER_TRACKING_ID);
          writeFileSync(join(root, 'verdict.json'), JSON.stringify({ ...state, status: 0, completedAt: Date.now() }));
        }, 10);
      `);
      if (mismatch) {
        await expect(startEvidence(root, { executable })).rejects.toThrow('ownership mismatch');
        expect(existsSync(join(root, 'payload-started'))).toBe(false);
        const pid = JSON.parse(readFileSync(join(root, 'started.json'))).pid;
        expect(() => process.kill(pid, 0)).toThrow();
      } else {
        await startEvidence(root, { executable });
        await untilFile(join(root, 'verdict.json'));
        expect(readFileSync(join(root, 'payload-started'), 'utf8')).toBe('synthetic-tracking-id');
      }
      const pid = JSON.parse(readFileSync(join(root, 'started.json'))).pid;
      const until = Date.now() + 2500;
      let alive = true;
      while (alive && Date.now() < until) {
        try { process.kill(pid, 0); await delay(10); } catch { alive = false; }
      }
      expect(alive, 'synthetic supervisor settled before fixture removal').toBe(false);
    }
  });

  it('uploads only projected metadata and exact stage tokens, including the early final verdict', () => {
    vi.stubEnv('CI', 'true'); vi.stubEnv('PORTOS_CI_MAX_WORKERS', '2');
    const { root, path, config } = fixture(); state(root, config, 0);
    const attempt = join(root, 'diagnostics', 'portos-vitest-fixture'); mkdirSync(attempt);
    writeFileSync(join(attempt, 'invocation.json'), JSON.stringify({ startedAt: Date.now(), completed: true, status: 0,
      selectors: ['server/services/musicVideo/documentRender.browser.test.js'], secret: 'example-private-secret' }));
    writeFileSync(join(attempt, 'run.json'), JSON.stringify({ reason: 'passed', completedCount: 1, errorCount: 0,
      activeModules: [], completedModules: ['server/services/musicVideo/documentRender.browser.test.js'], errors: ['example-private-secret'] }));
    writeFileSync(join(root, 'supervisor.log'), 'example-private-secret\n🎬 Generated Three stage: main-preview\n🎬 Generated Three stage: export example-private-secret\n');
    const output = join(root, 'outputs');
    const child = spawnSync(process.execPath, [script, 'snapshot', root, '1'], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GITHUB_OUTPUT: output, TOKEN: 'example-private-secret' } });
    expect(child.status, child.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('complete=true');
    const text = readFileSync(join(root, '001', 'snapshot.json'), 'utf8');
    const snapshot = JSON.parse(text);
    expect(snapshot).toMatchObject({ checkoutHead: 'b'.repeat(40), workflowSha: 'b'.repeat(40), pullRequestHead: 'a'.repeat(40),
      maxWorkers: 2, phase: 'completed', status: 0, lastThreeStage: 'main-preview' });
    expect(text).not.toContain('example-private'); expect(text).not.toContain(root); expect(text).not.toContain(config.nonce);
    expect(readFileSync(join(path, 'snapshot.json'), 'utf8')).not.toContain('example-private');
    const repeat = spawnSync(process.execPath, [script, 'snapshot', root, '1'], { encoding: 'utf8', timeout: 5000 });
    expect(repeat.status).toBe(1);
    expect(readFileSync(join(root, '001', 'snapshot.json'), 'utf8')).toBe(text);
  });

  it('uses absolute milestone deadlines and refuses stale, missing or malformed completion', async () => {
    const { root, config } = fixture(); const started = state(root, config);
    let clock = started.startedAt + 179500;
    const wait = vi.fn(async ms => { clock += ms; });
    const snapshot = await snapshotEvidence(root, 2, { now: () => clock, wait });
    expect(snapshot.complete).toBe(false); expect(wait).toHaveBeenCalledOnce();
    await expect(finishEvidence(root, ['success'], { now: () => started.startedAt + 750000, wait })).rejects.toThrow('unverified');
    writeFileSync(join(root, 'verdict.json'), JSON.stringify({ ...started, nonce: '0'.repeat(32), status: 0, completedAt: clock }));
    await expect(finishEvidence(root, ['success'])).rejects.toThrow('ownership mismatch');
    writeFileSync(join(root, 'verdict.json'), 'malformed');
    const child = spawnSync(process.execPath, [script, 'finish', root], { encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(1);
  });

  it('requires an actual upload for every successful capture, including early completion', async () => {
    const { root, config } = fixture(); state(root, config, 0);
    expect(await finishEvidence(root, ['success', 'skipped'])).toBe(1);
    expect(await finishEvidence(root, ['skipped', 'skipped'])).toBe(1);
    expect(await finishEvidence(root, ['success', 'success', 'skipped', 'skipped'])).toBe(0);
    expect(await finishEvidence(root, ['success', 'success', 'failure', 'skipped'])).toBe(1);
  });

  it('rejects untrusted selector and version text before creating artifacts', () => {
    const { env, exec } = fixture();
    expect(() => prepareEvidence({ ...env, CI_TEST_FILES: '["../../example-private-secret"]' }, exec)).toThrow();
    expect(() => prepareEvidence(env, command => command === 'google-chrome' ? 'example-private-secret' : exec(command))).toThrow();
  });

  it('uploads before launch and preserves final settlement after any post-launch upload failure', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const job = workflowJobs(workflow).database;
    const preflight = job.indexOf('name: Upload browser preflight before launch');
    const launch = job.indexOf('name: Run cross-workspace browser suites');
    const finish = job.indexOf('name: Enforce browser verdict and evidence completion');
    expect(preflight).toBeGreaterThan(job.indexOf('run: node scripts/browser-ci-evidence.js prepare'));
    expect(launch).toBeGreaterThan(preflight);
    expect(job.slice(preflight, launch)).not.toContain('continue-on-error');
    expect(job.match(/uses: actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/g)).toHaveLength(6);
    for (let i = 1; i <= 5; i++) {
      const begin = job.indexOf(`name: Capture browser evidence ${i}`);
      const end = i === 5 ? finish : job.indexOf(`name: Capture browser evidence ${i + 1}`);
      const block = job.slice(begin, end);
      expect(block).toContain('if: always()');
      expect(block).toContain("steps.browser-evidence-start.outcome == 'failure'");
      expect(block).toContain(`steps.browser-snapshot-${i}.outputs.path != ''`);
      expect(block.match(/continue-on-error: true/g)).toHaveLength(2);
      for (let prior = 1; prior < i; prior++) expect(block).toContain(`steps.browser-snapshot-${prior}.outputs.complete != 'true'`);
    }
    const final = job.slice(finish, job.indexOf('name: Preserve browser test failure diagnostics'));
    expect(final).toContain('if: always()'); expect(final).toContain("steps.browser-evidence-start.outcome == 'failure'");
    expect(final).not.toContain('continue-on-error');
    for (let i = 1; i <= 5; i++) expect(final).toContain(`steps.browser-upload-${i}.outcome`);
    expect(job).toContain('timeout-minutes: 20');
  });
});
