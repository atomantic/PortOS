#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { collectTestDiagnostics } from './ci-test-diagnostics.js';
import { writeStepOutput } from './lib/githubOutput.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { vitestCiPool } from './vitestCiPool.js';

const script = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
export const EVIDENCE_MILESTONES = [60, 180, 360, 540, 720];
const stages = new Set(['generation', 'reference-parity', 'main-preview', 'cooperative-playback', 'title-cancellation', 'lens-parity', 'export']);
const deadlineMs = 720000;
const settlementMs = 30000;
const hex = value => /^[a-f0-9]{40}$/.test(value);
const atomic = (path, value) => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('Invalid evidence state');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function metadata(value) {
  if (!hex(value.checkoutHead) || !hex(value.workflowSha) || (value.pullRequestHead !== null && !hex(value.pullRequestHead))
    || !/^\d+$/.test(value.runId) || !/^\d+$/.test(value.attempt) || !/^[\w-]{1,80}$/.test(value.job)
    || (value.maxWorkers !== null && (!Number.isInteger(value.maxWorkers) || value.maxWorkers < 1 || value.maxWorkers > 4))
    || !['smoke', 'full'].includes(value.profile) || !Array.isArray(value.selectors) || !value.selectors.length || value.selectors.length > 100
    || value.selectors.some(path => typeof path !== 'string' || path.length > 240 || !/^(server|client)\/(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/.test(path) || path.split('/').includes('..'))
    || !/^v\d+(?:\.\d+){2}$/.test(value.versions?.node) || !/^[\d.]{1,40}$/.test(value.versions?.chrome)
    || !/^[\w.+~-]{1,80}$/.test(value.versions?.ffmpeg)) throw Error('Invalid evidence metadata');
  return { checkoutHead: value.checkoutHead, workflowSha: value.workflowSha, pullRequestHead: value.pullRequestHead,
    runId: value.runId, attempt: value.attempt, job: value.job, profile: value.profile, selectors: value.selectors,
    maxWorkers: value.maxWorkers, versions: { node: value.versions.node, chrome: value.versions.chrome, ffmpeg: value.versions.ffmpeg },
    command: ['node', 'scripts/watch-ci-tests.js', 'server'], limits: { watchdogMs: deadlineMs, settlementMs, maxSnapshotBytes: 65536, maxSnapshots: 6 } };
}
function control(root) {
  if (!root || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error('Evidence root unavailable');
  const value = readJson(join(root, 'control.json'));
  if (!/^[a-f0-9]{32}$/.test(value.nonce)) throw Error('Invalid evidence nonce');
  return { nonce: value.nonce, metadata: metadata(value.metadata) };
}
function ownedState(root, name, nonce, optional = false) {
  const path = join(root, name);
  if (optional && !existsSync(path)) return null;
  const state = readJson(path);
  if (state.nonce !== nonce || !Number.isSafeInteger(state.pid) || state.pid <= 0 || !Number.isSafeInteger(state.startedAt)
    || state.startedAt <= 0) throw Error('Evidence ownership mismatch');
  if (name === 'verdict.json' && (!Number.isInteger(state.status) || state.status < 0 || state.status > 255
    || !Number.isSafeInteger(state.completedAt) || state.completedAt < state.startedAt)) throw Error('Invalid browser verdict');
  return state;
}
function version(command, args, pattern, exec) {
  const output = exec(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] });
  const match = String(output).match(pattern);
  if (!match) throw Error('Tool version unavailable');
  return match[1];
}
export function prepareEvidence(env = process.env, exec = execFileSync) {
  const details = metadata({ checkoutHead: String(exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 5000 })).trim(),
    workflowSha: env.GITHUB_SHA, pullRequestHead: env.CI_PR_HEAD || null, runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB, profile: env.PORTOS_BROWSER_TEST_PROFILE,
    selectors: JSON.parse(env.CI_TEST_FILES || '[]'), maxWorkers: vitestCiPool().maxWorkers ?? null, versions: { node: process.version,
      chrome: version('google-chrome', ['--version'], /(?:Google Chrome|Chromium) ([\d.]+)/, exec),
      ffmpeg: version('ffmpeg', ['-version'], /^ffmpeg version ([\w.+~-]+)/, exec) } });
  const root = mkdtempSync(join(env.RUNNER_TEMP, 'portos-browser-evidence-'));
  const state = { nonce: randomBytes(16).toString('hex'), metadata: details };
  atomic(join(root, 'control.json'), state);
  mkdirSync(join(root, 'diagnostics'));
  const path = join(root, '000'); mkdirSync(path);
  atomic(join(path, 'snapshot.json'), { ...details, sequence: 0, phase: 'preflight', recordedAt: new Date().toISOString() });
  return { root, path };
}

export async function superviseEvidence(root, watch, { ackMs = 10000, wait = delay } = {}) {
  const config = control(root);
  watch ??= (await import('./watch-ci-tests.js')).watchTests;
  const state = { nonce: config.nonce, pid: process.pid, startedAt: Date.now() };
  atomic(join(root, 'started.json'), state);
  let status = 1;
  try {
    const until = Date.now() + ackMs;
    let ack;
    while (!(ack = ownedState(root, 'ack.json', config.nonce, true)) && Date.now() < until) await wait(25);
    if (!ack || ack.pid !== state.pid || ack.startedAt !== state.startedAt) throw Error('Supervisor startup was not acknowledged');
    status = await watch('server', { deadlineMs, env: { ...process.env,
      CI_TEST_MODE: 'files', CI_TEST_FILES: JSON.stringify(config.metadata.selectors),
      PORTOS_BROWSER_TEST_PROFILE: config.metadata.profile, PORTOS_REQUIRE_BROWSER_SUITES: '1',
      PORTOS_CI_DIAGNOSTICS_DIR: join(root, 'diagnostics') } });
    if (!Number.isInteger(status) || status < 0 || status > 255) status = 1;
  } catch { console.error('Browser evidence supervisor failed; owned cleanup is unverified.'); }
  atomic(join(root, 'verdict.json'), { ...state, status, completedAt: Date.now() });
  return status;
}

export async function startEvidence(root, { spawnChild = spawn, executable = script } = {}) {
  const config = control(root);
  if (existsSync(join(root, 'started.json')) || existsSync(join(root, 'verdict.json'))) throw Error('Evidence run already started');
  const fd = openSync(join(root, 'supervisor.log'), 'wx', 0o600);
  let child, spawnError;
  try { child = spawnChild(process.execPath, [executable, 'supervise', root], { cwd: repoRoot, detached: true, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  // Keep RUNNER_TRACKING_ID inherited: GitHub still owns final job cancellation.
  child.once('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (spawnError) throw Error('Browser supervisor failed to spawn');
      const state = ownedState(root, 'started.json', config.nonce, true);
      if (state) {
        if (state.pid !== child.pid) throw Error('Browser supervisor identity mismatch');
        child.unref();
        atomic(join(root, 'ack.json'), state);
        return state;
      }
      await delay(25);
    }
    throw Error('Browser supervisor startup deadline exceeded');
  } catch (error) {
    // Until our acknowledgement the supervisor cannot launch tests. Signal only
    // this retained child; never discover or adopt a process from a PID file.
    child.kill('SIGTERM');
    await Promise.race([closed, delay(1000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([closed, delay(1000)]);
    if (child.exitCode === null && child.signalCode === null) { child.unref(); throw Error('Owned supervisor startup cleanup is unverified'); }
    throw error;
  }
}
function lastThreeStage(root) {
  const path = join(root, 'supervisor.log');
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const buffer = Buffer.alloc(Math.min(stat.size, 65536));
  const fd = openSync(path, 'r');
  try { readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length)); }
  finally { closeSync(fd); }
  return buffer.toString('utf8').split(/\r?\n/).map(line => /^🎬 Generated Three stage: ([a-z-]+)$/.exec(line)?.[1]).filter(stage => stages.has(stage)).at(-1) ?? null;
}
export async function snapshotEvidence(root, sequence, { now = Date.now, wait = delay } = {}) {
  const offset = EVIDENCE_MILESTONES[sequence - 1];
  if (offset === undefined) throw Error('Invalid evidence sequence');
  const config = control(root);
  const state = ownedState(root, 'started.json', config.nonce);
  let verdict;
  while (!(verdict = ownedState(root, 'verdict.json', config.nonce, true)) && now() < state.startedAt + offset * 1000) await wait(500);
  if (verdict && (verdict.pid !== state.pid || verdict.startedAt !== state.startedAt)) throw Error('Verdict does not belong to this launch');
  const lines = await collectTestDiagnostics(join(root, 'diagnostics'), { logger: { warn() {} }, writeSummary() {}, diagnose: async () => {} });
  const value = { ...config.metadata, sequence, phase: verdict ? 'completed' : 'running', recordedAt: new Date(now()).toISOString(),
    elapsedMs: Math.max(0, now() - state.startedAt), status: verdict?.status ?? null, lastThreeStage: lastThreeStage(root), diagnostics: lines };
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > 65536) throw Error('Evidence snapshot exceeds size bound');
  const path = join(root, String(sequence).padStart(3, '0'));
  mkdirSync(path); // An uploaded sequence is immutable; never replace it.
  writeFileSync(join(path, 'snapshot.json'), text, { flag: 'wx', mode: 0o600 });
  return { path, complete: Boolean(verdict) };
}
export async function finishEvidence(root, outcomes, { now = Date.now, wait = delay } = {}) {
  const config = control(root);
  const state = ownedState(root, 'started.json', config.nonce);
  let verdict;
  while (!(verdict = ownedState(root, 'verdict.json', config.nonce, true)) && now() < state.startedAt + deadlineMs + settlementMs) await wait(500);
  if (!verdict || verdict.pid !== state.pid || verdict.startedAt !== state.startedAt) throw Error('Browser completion or owned cleanup is unverified');
  const pairs = Array.isArray(outcomes) && outcomes.length > 0 && outcomes.length <= 10 && outcomes.length % 2 === 0
    ? Array.from({ length: outcomes.length / 2 }, (_, i) => outcomes.slice(i * 2, i * 2 + 2)) : [];
  const evidenceComplete = pairs.some(([, upload]) => upload === 'success')
    && pairs.every(([capture, upload]) => (capture === 'success' && upload === 'success') || (capture === 'skipped' && upload === 'skipped'));
  console.log(`Browser test verdict: exit=${verdict.status}; evidenceComplete=${evidenceComplete}.`);
  // An upload failure must not replace the actual nonzero test exit code.
  return verdict.status || (evidenceComplete ? 0 : 1);
}
if (isDirectlyInvoked(import.meta.url)) {
  try {
    const [mode, root, sequence] = process.argv.slice(2);
    if (mode === 'prepare') {
      const prepared = prepareEvidence(); writeStepOutput('root', prepared.root); writeStepOutput('path', prepared.path);
    } else if (mode === 'start') { await startEvidence(root); }
    else if (mode === 'supervise') { process.exitCode = await superviseEvidence(root); }
    else if (mode === 'snapshot') {
      const result = await snapshotEvidence(root, Number(sequence)); writeStepOutput('path', result.path); writeStepOutput('complete', result.complete);
    } else if (mode === 'finish') {
      process.exitCode = await finishEvidence(root, (process.env.CI_EVIDENCE_OUTCOMES || '').split(','));
    } else throw Error('Invalid evidence command');
  } catch { console.error('Browser evidence failed closed; state, upload, or owned completion is unverified.'); process.exitCode = 1; }
}
